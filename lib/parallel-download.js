import { deviceCacheKey } from './device-endpoint.js';
/**
 * Parallel Download Pipeline Orchestrator
 *
 * Main entry point that orchestrates the full parallel download pipeline:
 * split → download all segments as .ts → concat + remux to MP4.
 * Handles fallback to sequential mode when parallel is not feasible.
 * Supports resume: skips segments that already have valid downloaded files.
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawnExportProcess as spawn } from './export-process-lock.js';
import { ffmpegPath } from './ffmpeg-paths.js';
import { splitTimeRange } from './segment-splitter.js';
import { downloadAll, FallbackToSequentialError, CancellationError } from './download-manager.js';
import { ProgressReporter } from './progress-reporter.js';

/**
 * Orchestrate the full parallel download pipeline.
 *
 * Pipeline steps:
 *   1. Split time range into segments
 *   2. Download all segments in parallel as MPEG-TS (video + audio)
 *   3. Concat all .ts segments and remux to MP4 using ffmpeg concat protocol
 *   4. Clean up all intermediate files
 *
 * @param {object} params
 * @param {string} params.ip - DVR IP address
 * @param {string} params.user - RTSP username
 * @param {string} params.pass - RTSP password
 * @param {string} params.channel - Channel identifier (e.g. "101")
 * @param {string} params.startTime - Start time in Hikvision format "YYYYMMDDTHHmmssZ"
 * @param {string} params.endTime - End time in Hikvision format "YYYYMMDDTHHmmssZ"
 * @param {number} [params.concurrency=3] - Max concurrent RTSP connections (1-8)
 * @param {number} [params.segmentDuration=300] - Duration of each segment in seconds (min 30)
 * @param {number} [params.overlapDuration=3] - Overlap duration in seconds
 * @param {string} params.taskId - Unique task identifier for progress reporting
 * @param {Array} params.sseClients - SSE client connections array
 * @param {AbortSignal} [params.signal] - Optional AbortSignal for cancellation
 * @param {string} [params.outputDir] - Output directory (defaults to "downloads")
 * @param {string} [params.baseFilename] - Base filename for output files
 * @returns {Promise<object>} Result object with `filePath` on success or `{ fallback: true }` for fallback
 */
export async function runParallelDownload(params) {
  const {
    ip, httpPort, rtspPort, deviceId,
    user,
    pass,
    channel,
    startTime,
    endTime,
    concurrency = 3,
    segmentDuration = 300,
    overlapDuration = 3,
    taskId,
    sseClients = [],
    signal,
    outputDir = 'downloads',
    baseFilename,
  } = params;

  // Derive base filename if not provided
  const baseName = baseFilename || `dvr${deviceCacheKey({ ip, httpPort, rtspPort, deviceId })}_ch${channel}_${startTime}_to_${endTime}`;

  // Instantiate progress reporter
  const progress = new ProgressReporter(taskId, sseClients);

  // Track all intermediate files for cleanup at the end
  const allIntermediateFiles = [];

  try {
    // --- Step 1: Split time range into segments ---
    progress.reportProgress({
      phase: 'segmenting',
      overallPercent: 50,
      segmentsCompleted: 0,
      segmentsTotal: 0,
      segmentsInProgress: [],
      message: '正在分段...',
    });

    const segments = splitTimeRange(startTime, endTime, segmentDuration, overlapDuration);

    // If only one segment returned (duration ≤ 60s), signal fallback to sequential
    if (segments.length === 1 && segments[0].isFirst && segments[0].isLast && segments[0].overlapBefore === 0 && segments[0].overlapAfter === 0) {
      progress.reportProgress({
        phase: 'segmenting',
        overallPercent: 100,
        segmentsCompleted: 0,
        segmentsTotal: 1,
        segmentsInProgress: [],
        message: '时间范围较短，回退到单流模式',
      });
      return { fallback: true };
    }

    progress.reportProgress({
      phase: 'segmenting',
      overallPercent: 100,
      segmentsCompleted: 0,
      segmentsTotal: segments.length,
      segmentsInProgress: [],
      message: `已分为 ${segments.length} 个片段`,
    });

    // --- Step 2: Download all segments in parallel as MPEG-TS ---
    // No codec detection needed - MPEG-TS handles any codec transparently
    const codec = 'h264'; // placeholder, not actually used for TS format

    let segmentFiles;
    try {
      segmentFiles = await downloadAll({
        ip, rtspPort,
        user,
        pass,
        channel,
        segments,
        concurrency,
        codec,
        outputDir,
        baseFilename: baseName,
        onProgress: (update) => progress.reportProgress(update),
        signal,
      });
    } catch (err) {
      if (err instanceof FallbackToSequentialError) {
        progress.reportProgress({
          phase: 'downloading',
          overallPercent: 0,
          segmentsCompleted: 0,
          segmentsTotal: segments.length,
          segmentsInProgress: [],
          message: '并行下载不可用，已切换为单流模式',
        });
        return { fallback: true };
      }
      if (err instanceof CancellationError) {
        throw err;
      }
      progress.reportError(`下载失败: ${err.message}`);
      throw err;
    }

    // Track all segment files as intermediate (including .done markers and .aac files)
    for (const sf of segmentFiles) {
      if (sf && sf.filePath) {
        allIntermediateFiles.push(sf.filePath);
        allIntermediateFiles.push(sf.filePath + '.done');
        allIntermediateFiles.push(sf.filePath.replace(/\.h264$/, '.aac'));
      }
    }

    // Log segment file sizes for debugging
    console.log(`[${taskId}] Segment download summary:`);
    let totalSegmentBytes = 0;
    for (const sf of segmentFiles) {
      if (sf && sf.success) {
        console.log(`  seg${String(sf.index).padStart(3,'0')}: ${(sf.fileSize / 1024 / 1024).toFixed(1)} MB`);
        totalSegmentBytes += sf.fileSize;
      }
    }
    console.log(`  Total: ${(totalSegmentBytes / 1024 / 1024).toFixed(1)} MB`);

    // --- Step 3: Concat + Remux to MP4 ---
    // H264 Annex B streams can be concatenated by simple binary append.
    // Then remux with forced frame rate to produce correct-speed MP4.
    progress.reportProgress({
      phase: 'concatenating',
      overallPercent: 0,
      segmentsCompleted: 0,
      segmentsTotal: segments.length,
      segmentsInProgress: [],
      message: '正在拼接并封装为MP4...',
    });

    // Stream-based concatenation of h264 segment files (avoids 4GB Buffer limit)
    const concatH264Path = path.join(outputDir, `${baseName}_concat.h264`);
    const concatAacPath = path.join(outputDir, `${baseName}_concat.aac`);
    allIntermediateFiles.push(concatH264Path);
    allIntermediateFiles.push(concatAacPath);

    // Concatenate video segments using streams
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(concatH264Path);
      let i = 0;

      function writeNext() {
        while (i < segmentFiles.length) {
          const sf = segmentFiles[i];
          i++;
          if (!sf || !sf.success) continue;

          const readStream = fs.createReadStream(sf.filePath);
          readStream.on('error', reject);
          readStream.pipe(writeStream, { end: false });
          readStream.on('end', writeNext);
          return;
        }
        // All segments written
        writeStream.end(resolve);
      }

      writeStream.on('error', reject);
      writeNext();
    });

    // Concatenate audio segments using streams
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(concatAacPath);
      let i = 0;

      function writeNext() {
        while (i < segmentFiles.length) {
          const sf = segmentFiles[i];
          i++;
          if (!sf || !sf.success) continue;

          const audioPath = sf.filePath.replace(/\.h264$/, '.aac');
          if (!fs.existsSync(audioPath)) continue;

          const readStream = fs.createReadStream(audioPath);
          readStream.on('error', () => writeNext()); // skip if audio file unreadable
          readStream.pipe(writeStream, { end: false });
          readStream.on('end', writeNext);
          return;
        }
        writeStream.end(resolve);
      }

      writeStream.on('error', reject);
      writeNext();
    });

    console.log(`[${taskId}] Concatenated h264 file: ${(fs.statSync(concatH264Path).size / 1024 / 1024).toFixed(1)} MB`);
    const hasAudio = fs.existsSync(concatAacPath) && fs.statSync(concatAacPath).size > 0;
    if (hasAudio) {
      console.log(`[${taskId}] Concatenated aac file: ${(fs.statSync(concatAacPath).size / 1024 / 1024).toFixed(1)} MB`);
    }

    // Remux concatenated h264 to MP4 with correct frame rate
    const mp4OutputPath = path.join(outputDir, `${baseName}.mp4`);

    progress.reportProgress({
      phase: 'remuxing',
      overallPercent: 50,
      segmentsCompleted: segments.length,
      segmentsTotal: segments.length,
      segmentsInProgress: [],
      message: '正在封装MP4...',
    });

    await new Promise((resolve, reject) => {
      const args = [
        '-r', '20',           // Force 20fps input interpretation (matches camera's real frame rate)
        '-i', concatH264Path,
      ];

      // Add audio input if available
      if (hasAudio) {
        args.push('-i', concatAacPath);
      }

      args.push(
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', mp4OutputPath,
      );

      const ffmpeg = spawn(ffmpegPath, args);

      ffmpeg.on('error', (err) => {
        reject(new Error(`Failed to start ffmpeg concat: ${err.message}`));
      });

      ffmpeg.stderr.on('data', (data) => {
        // Could parse progress here, but concat is usually fast
        const output = data.toString();
        const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (timeMatch) {
          progress.reportProgress({
            phase: 'remuxing',
            overallPercent: 50,
            segmentsCompleted: segments.length,
            segmentsTotal: segments.length,
            segmentsInProgress: [],
            message: '正在封装MP4...',
          });
        }
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg concat+remux exited with code ${code}`));
        }
      });
    });

    // --- Step 4: Clean up ALL intermediate files ---
    cleanupFiles(allIntermediateFiles);

    if (signal?.aborted) throw new CancellationError();

    // Report completion
    progress.reportComplete(`${baseName}.mp4`);

    return { filePath: mp4OutputPath };
  } catch (err) {
    if (err instanceof CancellationError) {
      throw err;
    }
    if (!err._reported) {
      progress.reportError(`导出失败: ${err.message}`);
      err._reported = true;
    }
    throw err;
  }
}

/**
 * Delete a list of files, ignoring errors for individual files.
 * @param {string[]} files - Array of file paths to delete
 */
function cleanupFiles(files) {
  for (const filePath of files) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore - file may already be deleted
    }
  }
}

