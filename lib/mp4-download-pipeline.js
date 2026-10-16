import { deviceCacheKey } from './device-endpoint.js';
/**
 * MP4 Download Pipeline Orchestrator
 *
 * Orchestrates the full DVR recording download pipeline:
 * Search → Download → Trim → Concatenate → Cleanup
 * Progress describes the current stage; no overall duration is assumed.
 */

import { existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { searchRecordings } from './recording-search.js';
import { downloadFiles } from './file-downloader.js';
import { trimFiles } from './mp4-file-trimmer.js';
import { concatenateToMp4 } from './mp4-file-concatenator.js';
import { ProgressReporter } from './progress-reporter.js';
import { createRateTracker } from './rate-tracker.js';

/**
 * Convert Hikvision compact time format to ISO format.
 * Input: "20260507T175000Z" → Output: "2026-05-07T17:50:00Z"
 *
 * @param {string} compact - Hikvision compact format "YYYYMMDDTHHmmssZ"
 * @returns {string} ISO format "YYYY-MM-DDTHH:mm:ssZ"
 */
export function compactToIso(compact) {
  // Format: YYYYMMDDTHHmmssZ
  const year = compact.slice(0, 4);
  const month = compact.slice(4, 6);
  const day = compact.slice(6, 8);
  // Skip 'T' at index 8
  const hour = compact.slice(9, 11);
  const min = compact.slice(11, 13);
  const sec = compact.slice(13, 15);
  return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
}

/**
 * Filter recording files to only those overlapping with the user's time range.
 * A file overlaps if: file.endTime > userStartTime AND file.startTime < userEndTime
 *
 * @param {import('./recording-search.js').RecordingFile[]} files
 * @param {string} userStartTime - ISO format
 * @param {string} userEndTime - ISO format
 * @returns {import('./recording-search.js').RecordingFile[]}
 */
export function filterOverlappingFiles(files, userStartTime, userEndTime) {
  const userStart = new Date(userStartTime).getTime();
  const userEnd = new Date(userEndTime).getTime();

  return files.filter(file => {
    const fileStart = new Date(file.startTime).getTime();
    const fileEnd = new Date(file.endTime).getTime();
    return fileEnd > userStart && fileStart < userEnd;
  });
}

/**
 * Collect temporary files that should be cleaned up on failure/cancel.
 * Scans outputDir for *_trimmed.mp4 and *_filelist.txt files.
 *
 * @param {string} outputDir
 * @returns {string[]}
 */
function findTemporaryFiles(outputDir) {
  const tempFiles = [];
  try {
    const entries = readdirSync(outputDir);
    for (const entry of entries) {
      if (entry.endsWith('_trimmed.mp4') || entry.endsWith('_remuxed.mp4') || entry.endsWith('_filelist.txt')) {
        tempFiles.push(join(outputDir, entry));
      }
    }
  } catch {
    // Directory might not exist
  }
  return tempFiles;
}

/**
 * Delete temporary files, ignoring errors for individual files.
 * @param {string[]} files
 */
function cleanupTempFiles(files) {
  for (const filePath of files) {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Run the full MP4 download pipeline.
 *
 * Pipeline: Search → Download → Trim → Concatenate → Cleanup
 *
 * @param {object} options - PipelineOptions
 * @param {string} options.ip - DVR IP address
 * @param {string} options.user - Username
 * @param {string} options.pass - Password
 * @param {string} options.channel - Channel ID (e.g. "201")
 * @param {string} options.startTime - Hikvision compact format "YYYYMMDDTHHmmssZ"
 * @param {string} options.endTime - Hikvision compact format "YYYYMMDDTHHmmssZ"
 * @param {string} options.taskId - Unique task identifier
 * @param {Array<{id: number, res: import('http').ServerResponse}>} options.sseClients - SSE clients
 * @param {string} options.outputDir - Output directory for files
 * @param {AbortSignal} [options.signal] - Optional abort signal for cancellation
 * @returns {Promise<string>} Final MP4 file path
 */
export async function runMp4DownloadPipeline(options) {
  const { ip, httpPort, rtspPort, deviceId, user, pass, channel, startTime, endTime, taskId, sseClients, outputDir, signal } = options;
  // Injectable operations keep stage sequencing testable without a DVR.
  const {
    search = searchRecordings,
    download = downloadFiles,
    trim = trimFiles,
    concatenate = concatenateToMp4,
  } = options;

  // Convert compact times to ISO for ISAPI search
  const isoStartTime = compactToIso(startTime);
  const isoEndTime = compactToIso(endTime);

  // Output filename: ch{channel}_{startTime}_to_{endTime}.mp4
  const outputFilename = `dvr${deviceCacheKey({ ip, httpPort, rtspPort, deviceId })}_ch${channel}_${startTime}_to_${endTime}.mp4`;
  const outputPath = join(outputDir, outputFilename);

  // Instantiate progress reporter
  const progress = new ProgressReporter(taskId, sseClients);

  // Track temporary files for cleanup on failure
  const tempFilesCreated = [];

  try {
    // --- Search recordings ---
    checkAborted(signal);
    broadcastPipelineProgress(progress, 'searching', '搜索录像文件...');

    console.log(`[${taskId}] 搜索录像: ${isoStartTime} ~ ${isoEndTime}, 通道 ${channel}`);

    const allRecordings = await search(ip, user, pass, channel, isoStartTime, isoEndTime, httpPort);

    // Filter to only files overlapping with user's time range
    const recordingFiles = filterOverlappingFiles(allRecordings, isoStartTime, isoEndTime);

    if (recordingFiles.length === 0) {
      throw new Error('该时间段内无可用录像');
    }

    console.log(`[${taskId}] 找到 ${recordingFiles.length} 个录像文件，总大小 ${(recordingFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(0)} MB`);
    for (const f of recordingFiles) {
      console.log(`  ${f.startTime} ~ ${f.endTime}  (${(f.size / 1024 / 1024).toFixed(0)} MB)`);
    }

    broadcastPipelineProgress(progress, 'searching',
      `找到 ${recordingFiles.length} 个录像文件`);

    // --- Download or reuse cached files ---
    checkAborted(signal);

    broadcastPipelineProgress(progress, 'cache',
      `检查 ${recordingFiles.length} 个文件的缓存...`);

    console.log(`[${taskId}] 开始下载 ${recordingFiles.length} 个文件...`);

    // Speed tracking state for the download phase.
    // bytesReceived is per-file and resets to 0 on each new file; the tracker
    // absorbs that reset instead of reporting a negative rate.
    let rateTracker = createRateTracker();
    let previousSkippedFiles = 0;

    let lastLoggedFile = 0;
    const downloadResults = await download({
      ip, httpPort, rtspPort, deviceId,
      user,
      pass,
      recordingFiles,
      outputDir,
      signal,
      onProgress: (update) => {
        const cacheHit = update.skippedFiles > previousSkippedFiles;
        previousSkippedFiles = update.skippedFiles || 0;
        const skippedMsg = previousSkippedFiles > 0
          ? `（已复用 ${previousSkippedFiles}/${recordingFiles.length} 个缓存文件）`
          : '';

        // The downloader's totals come from a DVR search snapshot, not a
        // transfer Content-Length. They can be exceeded by active recordings,
        // so do not convert them into either stage or overall percentages.
        if (cacheHit || update.currentFile !== lastLoggedFile) rateTracker = createRateTracker();
        const speed = cacheHit ? null : rateTracker.update(update.bytesReceived || 0);
        broadcastPipelineProgress(progress, cacheHit ? 'cache' : 'downloading',
          `${update.message || '下载中...'}${skippedMsg}`, { speed, transferredBytes: cacheHit ? null : update.bytesReceived, transferScope: cacheHit ? null : 'file' });

        // CLI: log when a new file starts or completes
        if (update.currentFile !== lastLoggedFile) {
          lastLoggedFile = update.currentFile;
          console.log(`[${taskId}] ${update.message}`);
        }
      },
    });

    const skippedCount = downloadResults.filter(r => r.skipped).length;
    const downloadSummary = skippedCount === downloadResults.length
      ? `已复用全部 ${skippedCount} 个缓存文件`
      : `文件准备完成，下载 ${downloadResults.length - skippedCount} 个，复用缓存 ${skippedCount} 个`;
    console.log(`[${taskId}] ${downloadSummary}`);
    broadcastPipelineProgress(progress, skippedCount === downloadResults.length ? 'cache' : 'downloading',
      downloadSummary);

    // --- Probe, trim and normalize timestamps ---
    checkAborted(signal);
    console.log(`[${taskId}] 裁剪文件...`);
    const trimResults = await trim({
      downloadResults,
      userStartTime: isoStartTime,
      userEndTime: isoEndTime,
      outputDir,
      signal,
      onProgress: (update) => progress.reportProgress(update),
    });

    // Track temporary trimmed files for cleanup on later failure
    for (const tr of trimResults) {
      if (tr.isTemporary) {
        tempFilesCreated.push(tr.filePath);
      }
    }

    // --- Concatenate and finalize MP4 ---
    checkAborted(signal);
    console.log(`[${taskId}] 拼接封装 MP4...`);
    const finalPath = await concatenate({
      trimResults,
      outputPath,
      signal,
      onProgress: (update) => progress.reportProgress(update),
    });

    checkAborted(signal);

    // Report completion
    console.log(`[${taskId}] ✓ 导出完成: ${outputFilename}`);
    progress.reportComplete(outputFilename);

    return finalPath;

  } catch (err) {
    // Clean up temporary files on failure/cancel
    // Also scan for any temp files that might have been created
    const allTempFiles = [...tempFilesCreated, ...findTemporaryFiles(outputDir)];
    cleanupTempFiles(allTempFiles);

    // Also clean up the partial output file if it exists
    try {
      if (existsSync(outputPath)) {
        unlinkSync(outputPath);
      }
    } catch {
      // Ignore
    }

    // Report error via SSE (unless it's a cancellation)
    if (err.message === 'Download aborted' || (signal && signal.aborted)) {
      progress.reportError('导出已取消');
      throw new Error('导出已取消');
    }

    progress.reportError(`导出失败: ${err.message}`);
    throw err;
  }
}

/**
 * Check if the abort signal has been triggered and throw if so.
 * @param {AbortSignal} [signal]
 */
function checkAborted(signal) {
  if (signal && signal.aborted) {
    throw new Error('Download aborted');
  }
}

/** Broadcast stage-local evidence, never an assumed fraction of total work. */
function broadcastPipelineProgress(reporter, stage, message, details = {}) {
  reporter.reportProgress({
    phase: 'downloading',
    stage,
    stagePercent: null,
    message,
    speed: null,
    ...details,
  });
}
