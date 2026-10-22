import { deviceHttpOrigin, deviceCacheKey } from './device-endpoint.js';
/**
 * File Downloader Module
 *
 * Downloads recording files from DVR via ISAPI POST /ISAPI/ContentMgmt/download.
 * Supports cache reuse, resume (Range header), and retry logic.
 * Uses curl with --digest for HTTP Digest Authentication.
 */

import { spawnExportProcess as spawn } from './export-process-lock.js';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Convert an ISO time string to compact format YYYYMMDDTHHmmssZ.
 * Input: "2026-05-07T17:58:17Z" → Output: "20260507T175817Z"
 *
 * @param {string} isoTime - ISO format time string
 * @returns {string} Compact time string
 */
function toCompactTime(isoTime) {
  return isoTime.replace(/[-:]/g, '');
}

/** 分片结束时间落在这个窗口内，就认为 DVR 可能还在往里写 */
const STILL_RECORDING_WINDOW_MS = 2 * 60 * 1000;

/**
 * 判断某个录像分片是否可能仍在录制中。
 *
 * 搜索结果里的时间是「墙上时钟贴 Z」（并非真 UTC，见 server.js 里 compactToMs
 * 附近的说明），所以当前时刻也要按同样语义折算，否则非 UTC 时区下会全判错。
 *
 * @param {string} endTimeIso - 分片结束时间，如 "2026-05-07T18:13:47Z"
 * @returns {boolean}
 */
function isStillRecording(endTimeIso) {
  const endMs = Date.parse(endTimeIso);
  if (!Number.isFinite(endMs)) return false;
  const now = new Date();
  const nowWallMs = Date.UTC(
    now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds()
  );
  return endMs >= nowWallMs - STILL_RECORDING_WINDOW_MS;
}

/**
 * Generate the local cache file path for a recording file.
 * Format: {outputDir}/ch{channel}_{startTimeCompact}_{endTimeCompact}.hikraw
 *
 * @param {string} outputDir - Output directory path
 * @param {import('./recording-search.js').RecordingFile} recordingFile - Recording file info
 * @returns {string} Full file path
 */
export function getCacheFilePath(outputDir, recordingFile, endpoint) {
  const startCompact = toCompactTime(recordingFile.startTime);
  const endCompact = toCompactTime(recordingFile.endTime);
  const filename = `${endpoint ? `dvr${deviceCacheKey(endpoint)}_` : ''}ch${recordingFile.channel}_${startCompact}_${endCompact}.hikraw`;
  return join(outputDir, filename);
}

/**
 * Download a single file using curl, with optional Range header for resume.
 *
 * @param {object} params
 * @param {string} params.ip - DVR IP address
 * @param {string} params.user - Username
 * @param {string} params.pass - Password
 * @param {string} params.playbackURI - The playbackURI from search results
 * @param {string} params.outputPath - Local file path to write to
 * @param {number} params.resumeFrom - Byte offset to resume from (0 for full download)
 * @param {AbortSignal} [params.signal] - Optional abort signal
 * @param {function} [params.onBytesUpdate] - Callback with current file size
 * @returns {Promise<{ success: boolean, fileSize: number }>}
 */
function downloadSingleFile({ ip, httpPort, user, pass, playbackURI, outputPath, resumeFrom, signal, onBytesUpdate }) {
  return new Promise((resolve, reject) => {
    const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
    // Escape & to &amp; for XML body (playbackURI contains & between query params)
    const escapedURI = playbackURI.replace(/&/g, '&amp;');
    const xmlBody = `<downloadRequest><playbackURI>${escapedURI}</playbackURI></downloadRequest>`;

    // Write XML body to temp file to avoid shell/argument issues with special characters
    const tempBodyFile = join(tmpdir(), `dl_body_${randomUUID()}.xml`);
    writeFileSync(tempBodyFile, xmlBody, 'utf-8');

    const args = [
      '--connect-timeout', '10',
      '-s',
      '--digest',
      '-u', `${user}:${pass}`,
      '-X', 'POST',
      '-H', 'Content-Type: application/xml',
      '--data-binary', `@${tempBodyFile}`,
      '-o', outputPath,
      `${deviceHttpOrigin({ ip, httpPort })}/ISAPI/ContentMgmt/download`,
    ];

    // Add Range header for resume (append to existing file)
    if (resumeFrom > 0) {
      // For POST-based downloads, curl's -C (continue) doesn't work reliably.
      // Instead, we delete the partial file and re-download from scratch.
      // The .done marker mechanism ensures we never use incomplete files.
      // Full resume with Range header + append can be added as a future optimization.
      try { unlinkSync(outputPath); } catch (_) {}
      // Reset - download from beginning
    }

    const curlProcess = spawn(curlCmd, args);

    let aborted = false;

    // Handle abort signal
    if (signal) {
      const onAbort = () => {
        aborted = true;
        try { curlProcess.kill('SIGTERM'); } catch (_) {}
      };
      signal.addEventListener('abort', onAbort, { once: true });
      curlProcess.on('close', () => {
        signal.removeEventListener('abort', onAbort);
      });
    }

    // Monitor file size periodically for progress reporting
    let progressInterval = null;
    if (onBytesUpdate) {
      progressInterval = setInterval(() => {
        try {
          if (existsSync(outputPath)) {
            const stats = statSync(outputPath);
            onBytesUpdate(stats.size);
          }
        } catch (_) {
          // File might not exist yet or be locked
        }
      }, 1000);
    }

    curlProcess.on('error', (err) => {
      if (progressInterval) clearInterval(progressInterval);
      try { unlinkSync(tempBodyFile); } catch (_) {}
      reject(new Error(`curl spawn error: ${err.message}`));
    });

    curlProcess.on('close', (code) => {
      if (progressInterval) clearInterval(progressInterval);

      // Clean up temp body file
      try { unlinkSync(tempBodyFile); } catch (_) {}

      if (aborted) {
        reject(new Error('Download aborted'));
        return;
      }

      // Get final file size
      let fileSize = 0;
      try {
        if (existsSync(outputPath)) {
          fileSize = statSync(outputPath).size;
        }
      } catch (_) {}

      // curl exit code 33 means Range request not satisfiable (file already complete)
      // curl exit code 0 means success
      if (code === 0 || code === 33) {
        resolve({ success: true, fileSize });
      } else {
        reject(new Error(`curl exited with code ${code}`));
      }
    });
  });
}

/**
 * Download all recording files sequentially with cache reuse and resume support.
 *
 * @param {object} options - DownloadOptions
 * @param {string} options.ip - DVR IP address
 * @param {string} options.user - Username
 * @param {string} options.pass - Password
 * @param {import('./recording-search.js').RecordingFile[]} options.recordingFiles - Files to download
 * @param {string} options.outputDir - Output directory
 * @param {function} options.onProgress - Progress callback
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {Promise<Array<{filePath: string, recordingFile: object, skipped: boolean, resumed: boolean}>>}
 */
export async function downloadFiles(options) {
  const { ip, httpPort, rtspPort, deviceId, user, pass, recordingFiles, outputDir, onProgress, signal } = options;

  const totalFiles = recordingFiles.length;
  const totalBytes = recordingFiles.reduce((sum, f) => sum + f.size, 0);
  let completedBytes = 0;
  let skippedFiles = 0;
  const results = [];

  for (let i = 0; i < totalFiles; i++) {
    // Check abort signal before starting each file
    if (signal && signal.aborted) {
      throw new Error('Download aborted');
    }

    const recordingFile = recordingFiles[i];
    const filePath = getCacheFilePath(outputDir, recordingFile, { ip, httpPort, rtspPort, deviceId });
    const donePath = filePath + '.done';

    // --- Cache check ---
    // If .done marker exists, skip this file (cache hit)
    if (existsSync(donePath) && existsSync(filePath)) {
      skippedFiles++;
      completedBytes += recordingFile.size;

      if (onProgress) {
        onProgress({
          phase: 'downloading',
          currentFile: i + 1,
          totalFiles,
          fileProgress: 100,
          overallPercent: Math.min(100, (completedBytes / totalBytes) * 100),
          bytesReceived: recordingFile.size,
          bytesTotal: recordingFile.size,
          skippedFiles,
          message: `文件 ${i + 1}/${totalFiles} 已缓存，跳过`,
        });
      }

      results.push({ filePath, recordingFile, skipped: true, resumed: false });
      continue;
    }

    // --- Determine resume offset ---
    let resumeFrom = 0;
    let resumed = false;
    if (existsSync(filePath)) {
      const localSize = statSync(filePath).size;
      const SIZE_TOLERANCE = 1024;
      if (localSize >= recordingFile.size && localSize <= recordingFile.size + SIZE_TOLERANCE) {
        // File looks complete (within tolerance for IMKH header) but missing .done marker
        // This can happen if process was killed right after download but before writing .done
        // Write the .done marker and skip
        writeFileSync(donePath, '', 'utf-8');
        skippedFiles++;
        completedBytes += recordingFile.size;
        if (onProgress) {
          onProgress({
            phase: 'downloading',
            currentFile: i + 1,
            totalFiles,
            fileProgress: 100,
            overallPercent: Math.min(100, (completedBytes / totalBytes) * 100),
            bytesReceived: recordingFile.size,
            bytesTotal: recordingFile.size,
            skippedFiles,
            message: `文件 ${i + 1}/${totalFiles} 已完整（补写标记），跳过`,
          });
        }
        results.push({ filePath, recordingFile, skipped: true, resumed: false });
        continue;
      } else if (localSize > recordingFile.size + SIZE_TOLERANCE) {
        // Local file is way too large - corrupted, delete and re-download
        try { unlinkSync(filePath); } catch (_) {}
        resumeFrom = 0;
        resumed = false;
      } else if (localSize > 0) {
        // Partial file exists (no .done marker) - for POST downloads, re-download from scratch
        try { unlinkSync(filePath); } catch (_) {}
        resumeFrom = 0;
        resumed = false;
      }
    }

    // --- Download with retry logic ---
    const MAX_ATTEMPTS = 3;
    let lastError = null;
    let downloadSuccess = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal && signal.aborted) {
        throw new Error('Download aborted');
      }

      try {
        // Report progress at start of attempt
        if (onProgress) {
          const currentBytes = resumeFrom;
          onProgress({
            phase: 'downloading',
            currentFile: i + 1,
            totalFiles,
            fileProgress: recordingFile.size > 0 ? Math.min(100, (currentBytes / recordingFile.size) * 100) : 0,
            overallPercent: Math.min(100, ((completedBytes + currentBytes) / totalBytes) * 100),
            bytesReceived: currentBytes,
            bytesTotal: recordingFile.size,
            skippedFiles,
            message: resumed
              ? `文件 ${i + 1}/${totalFiles} 断点续传中...`
              : `文件 ${i + 1}/${totalFiles} 下载中...`,
          });
        }

        const result = await downloadSingleFile({
          ip, httpPort,
          user,
          pass,
          playbackURI: recordingFile.playbackURI,
          outputPath: filePath,
          resumeFrom,
          signal,
          onBytesUpdate: (currentSize) => {
            if (onProgress) {
              onProgress({
                phase: 'downloading',
                currentFile: i + 1,
                totalFiles,
                fileProgress: recordingFile.size > 0 ? Math.min(100, (currentSize / recordingFile.size) * 100) : 0,
                overallPercent: Math.min(100, ((completedBytes + currentSize) / totalBytes) * 100),
                bytesReceived: currentSize,
                bytesTotal: recordingFile.size,
                skippedFiles,
                message: `文件 ${i + 1}/${totalFiles} 下载中... ${Math.round(currentSize / 1024 / 1024)}MB`,
              });
            }
          },
        });

        // --- Size verification ---
        const finalSize = result.fileSize;
        // The ISAPI download adds an IMKH header (~40 bytes) to the file,
        // so actual size is slightly larger than the `size` from search results.
        // Accept if: actual >= expected AND actual <= expected + 1024 (generous tolerance for headers)
        // Reject if: actual < expected (incomplete download) or actual > expected + 1024 (something wrong)
        const SIZE_TOLERANCE = 1024; // Allow up to 1KB extra for IMKH headers
        if (recordingFile.size > 0) {
          // DVR 还在往这个分片里写时，边录边传会让实际字节数远超搜索时刻拿到的
          // size（实测 42 秒的分片能下出 400MB）。多出来的是更晚的录像内容，数据
          // 本身有效，后续 trim 步骤会按用户请求的范围裁掉。这种情况下只保留
          // 「下载不完整」的判断，不再卡上界。
          const stillRecording = isStillRecording(recordingFile.endTime);
          const tooSmall = finalSize < recordingFile.size;
          const tooLarge = !stillRecording && finalSize > recordingFile.size + SIZE_TOLERANCE;

          if (tooSmall || tooLarge) {
            // Size mismatch - delete and retry
            if (attempt < MAX_ATTEMPTS) {
              try { unlinkSync(filePath); } catch (_) {}
              resumeFrom = 0;
              resumed = false;
              lastError = new Error(`文件大小不一致: 期望 ~${recordingFile.size}, 实际 ${finalSize}`);
              continue;
            }
            // Final attempt failed size check - report error
            throw new Error(`文件 ${i + 1} 下载后大小不一致: 期望 ~${recordingFile.size} 字节, 实际 ${finalSize} 字节`);
          }
        }

        // --- Success: write .done marker ---
        writeFileSync(donePath, '', 'utf-8');
        completedBytes += recordingFile.size;
        downloadSuccess = true;

        if (onProgress) {
          onProgress({
            phase: 'downloading',
            currentFile: i + 1,
            totalFiles,
            fileProgress: 100,
            overallPercent: Math.min(100, (completedBytes / totalBytes) * 100),
            bytesReceived: recordingFile.size,
            bytesTotal: recordingFile.size,
            skippedFiles,
            message: `文件 ${i + 1}/${totalFiles} 下载完成`,
          });
        }

        break; // Success, exit retry loop

      } catch (err) {
        lastError = err;

        // If aborted, don't retry - preserve partial file for future resume
        if (err.message === 'Download aborted') {
          throw err;
        }

        // Network interruption: preserve partial file for future resume
        // Only retry if we haven't exhausted attempts
        if (attempt < MAX_ATTEMPTS) {
          // Update resumeFrom for next attempt (file may have grown)
          if (existsSync(filePath)) {
            resumeFrom = statSync(filePath).size;
            resumed = resumeFrom > 0;
          }

          if (onProgress) {
            onProgress({
              phase: 'downloading',
              currentFile: i + 1,
              totalFiles,
              fileProgress: recordingFile.size > 0 ? Math.min(100, (resumeFrom / recordingFile.size) * 100) : 0,
              overallPercent: Math.min(100, ((completedBytes + resumeFrom) / totalBytes) * 100),
              bytesReceived: resumeFrom,
              bytesTotal: recordingFile.size,
              skippedFiles,
              message: `文件 ${i + 1}/${totalFiles} 下载失败，正在重试 (${attempt}/${MAX_ATTEMPTS - 1})...`,
            });
          }

          // Brief delay before retry
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      }
    }

    if (!downloadSuccess) {
      // All retries exhausted - abort and report error
      // Preserve partial file for future resume
      throw new Error(`文件 ${i + 1}/${totalFiles} 下载失败（已重试 ${MAX_ATTEMPTS - 1} 次）: ${lastError?.message || '未知错误'}`);
    }

    results.push({ filePath, recordingFile, skipped: false, resumed });
  }

  return results;
}

