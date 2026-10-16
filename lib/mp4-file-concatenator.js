/**
 * MP4 File Concatenator Module
 *
 * Concatenates trimmed recording files into a single MP4 output.
 * - Single file: direct remux to MP4 (no concat demuxer)
 * - Multiple files: uses ffmpeg concat demuxer with file list
 * - Applies -c copy -movflags +faststart
 * - Sorts files by startTime ascending
 * - Cleans up temporary files (*_trimmed.mp4, *_filelist.txt) after success
 * - Preserves original .hikraw cache files
 */

import { spawnExportProcess as spawn } from './export-process-lock.js';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ffmpegPath } from './ffmpeg-paths.js';

/**
 * Build the concat demuxer file list content from trim results.
 * Sorts entries by startTime ascending.
 *
 * @param {Array<{index: number, filePath: string, isTemporary: boolean, trimmedStart: boolean, trimmedEnd: boolean, startTime: string}>} trimResults
 * @returns {string} File list content for ffmpeg concat demuxer
 */
export function buildConcatFileList(trimResults) {
  // Sort by startTime ascending
  const sorted = [...trimResults].sort((a, b) => {
    const timeA = new Date(a.startTime).getTime();
    const timeB = new Date(b.startTime).getTime();
    return timeA - timeB;
  });

  // Build file list lines with absolute paths
  const lines = sorted.map(r => `file '${resolve(r.filePath)}'`);
  return lines.join('\n') + '\n';
}

/**
 * Run ffmpeg and report only evidence from its stderr. Media timestamps are
 * processed seconds, not wall-clock progress or a fraction of total work.
 */
function runFfmpeg(args, stage, { onProgress, signal, spawnProcess }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Download aborted'));
    const child = spawnProcess(ffmpegPath, args);
    let stderr = '';
    let pendingLine = '';
    let processError = null;
    let processedSeconds = null;
    let finalizing = false;

    const report = (message) => {
      if (signal?.aborted) return;
      onProgress?.({
        phase: stage === 'remuxing' ? 'remuxing' : 'concatenating',
        stage: finalizing ? 'finalizing' : stage,
        stagePercent: null,
        processedSeconds,
        message,
      });
    };
    const consumeLine = (line) => {
      if (!finalizing && /Starting second pass: moving the moov atom/i.test(line)) {
        finalizing = true;
        report('正在整理 MP4 文件头（faststart）...');
      }
      const timestamps = [...line.matchAll(/\btime=(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)(?=\s|$)/g)];
      if (timestamps.length > 0) {
        const last = timestamps.at(-1);
        const seconds = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
        if (Number.isFinite(seconds) && (processedSeconds === null || seconds > processedSeconds)) {
          processedSeconds = seconds;
          report(finalizing
            ? '正在整理 MP4 文件头（faststart）...'
            : `${stage === 'remuxing' ? '封装' : '拼接'}已处理 ${seconds.toFixed(1)} 秒录像`);
        }
      }
    };
    const onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr.on('data', data => {
      const text = data.toString();
      // Bound diagnostics and any unterminated log line on long exports.
      stderr = (stderr + text).slice(-8192);
      const lines = (pendingLine + text).split(/[\r\n]/);
      pendingLine = lines.pop().slice(-8192);
      for (const line of lines) consumeLine(line);
    });
    child.on('error', err => { processError = err; });
    // Cancellation settles only when the actual process and its pipes close.
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Download aborted'));
      if (processError) return reject(new Error(`Failed to start ffmpeg: ${processError.message}`));
      consumeLine(pendingLine);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${stage} failed (exit code ${code}): ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Clean up temporary files produced during the trim/concat process.
 * Deletes files where isTemporary=true and the file list txt.
 * Does NOT delete .hikraw original cache files.
 *
 * @param {Array<{filePath: string, isTemporary: boolean}>} trimResults
 * @param {string|null} fileListPath - Path to the generated file list (if any)
 */
function cleanupTemporaryFiles(trimResults, fileListPath) {
  // Delete temporary trimmed files
  for (const result of trimResults) {
    if (result.isTemporary) {
      try {
        if (existsSync(result.filePath)) {
          unlinkSync(result.filePath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // Delete the file list
  if (fileListPath) {
    try {
      if (existsSync(fileListPath)) {
        unlinkSync(fileListPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Concatenate trimmed recording files into a single MP4.
 *
 * - Single file: direct remux with -c copy -movflags +faststart
 * - Multiple files: concat demuxer with file list, -c copy -movflags +faststart
 * - Files are ordered by startTime ascending
 * - Temporary files are cleaned up after success
 *
 * @param {object} options - ConcatOptions
 * @param {Array<{index: number, filePath: string, isTemporary: boolean, trimmedStart: boolean, trimmedEnd: boolean, startTime: string}>} options.trimResults
 * @param {string} options.outputPath - Final MP4 output path
 * @param {function} [options.onProgress] - Stage and measured media timestamps
 * @param {AbortSignal} [options.signal] - Cancellation waits for ffmpeg to close
 * @returns {Promise<string>} Final MP4 file path
 */
export async function concatenateToMp4(options) {
  const { trimResults, outputPath, onProgress, signal, spawn: spawnProcess = spawn } = options;
  if (signal?.aborted) throw new Error('Download aborted');

  if (!trimResults || trimResults.length === 0) {
    throw new Error('No files to concatenate');
  }

  // Sort by startTime ascending
  const sorted = [...trimResults].sort((a, b) => {
    const timeA = new Date(a.startTime).getTime();
    const timeB = new Date(b.startTime).getTime();
    return timeA - timeB;
  });

  let fileListPath = null;

  const report = (stage, message) => onProgress?.({
    phase: stage === 'remuxing' ? 'remuxing' : 'concatenating',
    stage,
    stagePercent: null,
    message,
  });

  try {
    if (sorted.length === 1) {
      report('remuxing', '正在封装为 MP4...');
      await runFfmpeg([
        '-i', sorted[0].filePath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath,
      ], 'remuxing', { onProgress, signal, spawnProcess });
    } else {
      report('concatenating', `正在生成 ${sorted.length} 个文件的拼接列表...`);
      const outputDir = dirname(outputPath);
      fileListPath = join(outputDir, `${Date.now()}_filelist.txt`);
      writeFileSync(fileListPath, buildConcatFileList(sorted), 'utf-8');

      report('concatenating', `正在拼接 ${sorted.length} 个文件并封装为 MP4...`);
      await runFfmpeg([
        '-f', 'concat', '-safe', '0', '-i', fileListPath,
        '-c', 'copy', '-movflags', '+faststart', '-y', outputPath,
      ], 'concatenating', { onProgress, signal, spawnProcess });
    }

    report('finalizing', '正在清理临时文件...');
    cleanupTemporaryFiles(trimResults, fileListPath);

    return outputPath;
  } catch (err) {
    // On failure, still attempt to clean up temporary files
    cleanupTemporaryFiles(trimResults, fileListPath);
    throw err;
  }
}

