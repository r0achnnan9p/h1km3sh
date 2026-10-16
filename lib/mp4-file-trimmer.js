/**
 * MP4 File Trimmer Module
 *
 * Trims downloaded .hikraw recording files based on user-specified time range.
 * Uses ffmpeg -ss/-t with -c:v copy for lossless video trimming.
 * Only processes files with .done markers to ensure completeness.
 * Outputs trimmed files as temporary *_trimmed.mp4 files, preserving originals.
 */

import { spawnExportProcess as spawn } from './export-process-lock.js';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegPath, ffprobePath } from './ffmpeg-paths.js';

const execFileAsync = promisify(execFile);

/**
 * Calculate trim parameters for a single file given user and file time ranges.
 *
 * @param {string} userStartTime - User-specified start time (ISO format)
 * @param {string} userEndTime - User-specified end time (ISO format)
 * @param {string} fileStartTime - Recording file start time (ISO format)
 * @param {string} fileEndTime - Recording file end time (ISO format)
 * @returns {{ ss: number, to: number, needsTrim: boolean, trimmedStart: boolean, trimmedEnd: boolean }}
 */
export function calculateTrimParams(userStartTime, userEndTime, fileStartTime, fileEndTime) {
  const userStart = new Date(userStartTime).getTime() / 1000;
  const userEnd = new Date(userEndTime).getTime() / 1000;
  const fileStart = new Date(fileStartTime).getTime() / 1000;
  const fileEnd = new Date(fileEndTime).getTime() / 1000;
  const fileDuration = fileEnd - fileStart;

  // -ss offset: how far into the file to start
  const ss = Math.max(0, userStart - fileStart);

  // -to: where in the file to stop (relative to file start, not to -ss)
  const to = Math.min(fileDuration, userEnd - fileStart);

  // Determine if trimming is needed
  const trimmedStart = ss > 0;
  const trimmedEnd = to < fileDuration;
  const needsTrim = trimmedStart || trimmedEnd;

  return { ss, to, needsTrim, trimmedStart, trimmedEnd };
}

/**
 * Run ffmpeg to trim a single file.
 *
 * @param {string} inputPath - Input .hikraw file path
 * @param {string} outputPath - Output trimmed .mp4 file path
 * @param {number} ss - Start offset in seconds (0 = from beginning)
 * @param {number|null} to - End position in seconds (null = to end of file)
 * @returns {Promise<void>}
 */
async function runFfmpegTrim(inputPath, outputPath, ss, to, { signal, spawnProcess }) {
  const inputArgs = [];
  // Input-side seeking handles recordings with large PTS offsets.
  if (ss > 0) inputArgs.push('-ss', String(ss));
  inputArgs.push('-i', inputPath);
  if (to !== null && to !== undefined && to - ss > 0) {
    inputArgs.push('-t', String(to - ss));
  }

  const run = (audioArgs) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Download aborted'));
    const args = [...inputArgs, '-c:v', 'copy', ...audioArgs, '-movflags', '+faststart', '-y', outputPath];
    console.log(`[trim] ffmpeg ${args.join(' ')}`);
    const child = spawnProcess(ffmpegPath, args);
    let stderr = '';
    let processError = null;
    const onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
    child.on('error', err => { processError = err; });
    // Sending SIGTERM is not settlement: the queue must wait for close.
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('Download aborted'));
      else if (processError) reject(new Error(`Failed to start ffmpeg: ${processError.message}`));
      else resolve({ code, stderr });
    });
  });

  let result = await run(['-c:a', 'aac', '-b:a', '128k']);
  if (result.code === 0) return;
  // Preserve the existing fallback for recordings with unusable audio.
  console.log('[trim] Retrying without audio');
  result = await run(['-an']);
  if (result.code !== 0) {
    throw new Error(`ffmpeg trim failed (exit code ${result.code}): ${result.stderr.slice(-500)}`);
  }
}

/**
 * Probe the actual duration of a media file using ffprobe.
 *
 * @param {string} filePath - Path to the media file
 * @returns {Promise<number>} Duration in seconds
 */
async function probeDuration(filePath) {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 30000 });
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? 0 : duration;
  } catch {
    return 0;
  }
}

/**
 * Trim downloaded recording files based on user-specified time range.
 *
 * Because Hikvision ISAPI search returns timeSpan.startTime truncated to the
 * user's requested start time (even though the actual .hikraw file may contain
 * earlier content), we use ffprobe to detect the actual file duration and
 * always trim the first and last files to ensure accurate boundaries.
 *
 * - Files fully contained within user range: remuxed (resets PTS)
 * - Files partially overlapping: trimmed with ffmpeg -ss/-t
 * - Only processes files with .done markers
 *
 * @param {object} options - TrimOptions
 * @param {Array<{filePath: string, recordingFile: object, skipped: boolean, resumed: boolean}>} options.downloadResults
 * @param {string} options.userStartTime - User start time (ISO format)
 * @param {string} options.userEndTime - User end time (ISO format)
 * @param {string} options.outputDir - Directory for temporary trimmed files
 * @param {function} [options.onProgress] - Completed-file counts and current operation
 * @param {AbortSignal} [options.signal] - Cancellation waits for active ffmpeg to close
 * @returns {Promise<Array<{index: number, filePath: string, isTemporary: boolean, trimmedStart: boolean, trimmedEnd: boolean, startTime: string}>>}
 * @throws If any required file is missing its .done marker
 */
export async function trimFiles(options) {
  const {
    downloadResults, userStartTime, userEndTime, outputDir, onProgress, signal,
    spawn: spawnProcess = spawn, probeDuration: probe = probeDuration,
  } = options;

  const results = [];
  const totalFiles = downloadResults.length;

  const report = (stage, completed, message) => onProgress?.({
    phase: stage === 'remuxing' ? 'remuxing' : 'trimming',
    stage,
    // File counts describe completed preparation work, never time remaining.
    stagePercent: totalFiles > 0 ? completed / totalFiles * 100 : null,
    progressUnit: 'files',
    segmentsCompleted: completed,
    segmentsTotal: totalFiles,
    message,
  });

  for (let i = 0; i < totalFiles; i++) {
    if (signal?.aborted) throw new Error('Download aborted');
    const { filePath, recordingFile } = downloadResults[i];
    const donePath = filePath + '.done';

    // Verify .done marker exists
    if (!existsSync(donePath)) {
      throw new Error(`文件 ${basename(filePath)} 下载不完整（缺少 .done 标记），无法继续处理`);
    }

    // Probe actual file duration to handle ISAPI time truncation
    report('trimming', i, `探测文件 ${i + 1}/${totalFiles} 的时长（已处理 ${i}/${totalFiles}）...`);
    const actualDuration = await probe(filePath);
    if (signal?.aborted) throw new Error('Download aborted');

    // Calculate the reported duration from ISAPI metadata
    const reportedDuration = (new Date(recordingFile.endTime).getTime() - new Date(recordingFile.startTime).getTime()) / 1000;

    // If actual duration is significantly longer than reported, the file contains
    // content outside the user's requested range (ISAPI truncated the timeSpan)
    const durationMismatch = actualDuration > 0 && actualDuration > reportedDuration + 5;

    const isFirstFile = i === 0;
    const isLastFile = i === totalFiles - 1;

    let { ss, to, needsTrim, trimmedStart, trimmedEnd } = calculateTrimParams(
      userStartTime,
      userEndTime,
      recordingFile.startTime,
      recordingFile.endTime
    );

    // If there's a duration mismatch (file is longer than reported), force trim
    // For the first file: the extra content is at the beginning (before user's startTime)
    // For the last file: the extra content is at the end (after user's endTime)
    if (durationMismatch && !needsTrim) {
      const extraDuration = actualDuration - reportedDuration;

      if (isFirstFile) {
        // Extra content at the beginning - skip it
        ss = extraDuration;
        to = actualDuration;
        needsTrim = true;
        trimmedStart = true;
        console.log(`[trim] File ${i + 1}: actual duration ${actualDuration.toFixed(1)}s vs reported ${reportedDuration.toFixed(1)}s, trimming ${extraDuration.toFixed(1)}s from start`);
      } else if (isLastFile) {
        // Extra content at the end - cut it
        ss = 0;
        to = reportedDuration;
        needsTrim = true;
        trimmedEnd = true;
        console.log(`[trim] File ${i + 1}: actual duration ${actualDuration.toFixed(1)}s vs reported ${reportedDuration.toFixed(1)}s, trimming ${extraDuration.toFixed(1)}s from end`);
      }
    } else if (durationMismatch && needsTrim) {
      // Already needs trim but duration is off - adjust ss to account for extra content at start
      if (isFirstFile && actualDuration > reportedDuration + 5) {
        const extraDuration = actualDuration - reportedDuration;
        ss += extraDuration;
        to = ss + (to - (ss - extraDuration));
        console.log(`[trim] File ${i + 1}: adjusting trim offset by ${extraDuration.toFixed(1)}s for actual file duration`);
      }
    }

    const base = basename(filePath, '.hikraw');

    if (!needsTrim) {
      // File is fully contained within user range - still need to remux from .hikraw to .mp4
      // because .hikraw has absolute PTS timestamps that would break concat ordering.
      const remuxedPath = join(outputDir, `${base}_remuxed.mp4`);

      report('remuxing', i, `封装文件 ${i + 1}/${totalFiles}（已处理 ${i}/${totalFiles}）...`);
      await runFfmpegTrim(filePath, remuxedPath, 0, null, { signal, spawnProcess });

      results.push({
        index: i,
        filePath: remuxedPath,
        isTemporary: true,
        trimmedStart: false,
        trimmedEnd: false,
        startTime: recordingFile.startTime,
      });
    } else {
      // Need to trim - output to temporary file
      const trimmedPath = join(outputDir, `${base}_trimmed.mp4`);

      report('trimming', i, `裁剪文件 ${i + 1}/${totalFiles}（已处理 ${i}/${totalFiles}）...`);
      await runFfmpegTrim(filePath, trimmedPath, ss, to, { signal, spawnProcess });

      results.push({
        index: i,
        filePath: trimmedPath,
        isTemporary: true,
        trimmedStart,
        trimmedEnd,
        startTime: recordingFile.startTime,
      });
    }
    report('trimming', i + 1, `文件处理完成 ${i + 1}/${totalFiles}`);
  }

  return results;
}

