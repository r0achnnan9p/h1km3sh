import { deviceRtspAuthority } from './device-endpoint.js';
/**
 * Download Manager Module
 *
 * Orchestrates parallel RTSP segment downloads with a fixed-size concurrency pool.
 * Handles codec detection, concurrent ffmpeg process management, and progress tracking.
 */

import { exec } from 'child_process';
import { spawnExportProcess as spawn } from './export-process-lock.js';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { ffmpegPath, ffprobePath } from './ffmpeg-paths.js';

const execAsync = promisify(exec);

/**
 * Error class indicating that all parallel connections were refused
 * and the system should fall back to sequential single-stream mode.
 */
export class FallbackToSequentialError extends Error {
  constructor(message = 'All parallel connections refused, falling back to sequential mode') {
    super(message);
    this.name = 'FallbackToSequentialError';
    this.fallbackToSequential = true;
  }
}

/**
 * Error class indicating that the download was cancelled by the user.
 * The pipeline orchestrator can use `instanceof CancellationError` to
 * distinguish cancellation from other failures.
 */
export class CancellationError extends Error {
  constructor(message = 'Download cancelled by user') {
    super(message);
    this.name = 'CancellationError';
    this.cancelled = true;
  }
}

/**
 * Patterns in ffmpeg stderr that indicate RTSP connection was refused.
 * These trigger adaptive concurrency degradation rather than normal retry.
 */
const CONNECTION_REFUSED_PATTERNS = [
  /[Cc]onnection refused/,
  /[Cc]onnection timed out/,
  /[Ss]erver returned 4[0-9]{2}/,
  /RTSP.*[Ee]rror/,
];

/**
 * Abnormal exit codes that indicate the process was killed externally
 * (e.g., by the DVR dropping the connection). On Windows these are large
 * unsigned values. However, we should NOT treat all large exit codes as
 * connection-refused — ffmpeg can crash for other reasons.
 * Only treat specific known codes as connection issues.
 */
function isAbnormalExitCode(code) {
  if (code === null || code === undefined) return false;
  // Known Windows RTSP connection-drop codes:
  // 0xC000013A = 3221225786 (STATUS_CONTROL_C_EXIT - process killed)
  // We no longer treat arbitrary large codes as connection-refused
  // because ffmpeg can crash for unrelated reasons (codec issues, etc.)
  return false; // Disabled — rely only on stderr pattern matching
}

/**
 * Delay helper for retry backoff.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect video codec from the first segment's RTSP stream using ffprobe.
 *
 * @param {object} params
 * @param {string} params.ip - DVR IP address
 * @param {string} params.user - RTSP username
 * @param {string} params.pass - RTSP password
 * @param {string} params.channel - Channel identifier
 * @param {object} params.segment - First TimeSegment to probe
 * @returns {Promise<string>} "h264" or "hevc"
 */
export async function detectCodec({ ip, rtspPort, user, pass, channel, segment }) {
  const rtspUrl = buildRtspUrl(ip, user, pass, channel, segment.startTime, segment.endTime, 'tracks', rtspPort);
  const probeCmd = `"${ffprobePath}" -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${rtspUrl}"`;

  try {
    const { stdout } = await execAsync(probeCmd, { timeout: 30000 });
    if (stdout.trim().includes('hevc')) {
      return 'hevc';
    }
    return 'h264';
  } catch {
    // Default to h264 if probe fails
    return 'h264';
  }
}

/**
 * Build an RTSP URL for a Hikvision DVR playback stream.
 *
 * @param {string} ip
 * @param {string} user
 * @param {string} pass
 * @param {string} channel
 * @param {string} startTime - Hikvision format "YYYYMMDDTHHmmssZ"
 * @param {string} endTime - Hikvision format "YYYYMMDDTHHmmssZ"
 * @param {string} [rtspPath='tracks'] - RTSP path type: 'tracks' or 'Channels'
 * @returns {string} RTSP URL
 */
function buildRtspUrl(ip, user, pass, channel, startTime, endTime, rtspPath = 'tracks', rtspPort) {
  return `rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${deviceRtspAuthority({ ip, rtspPort })}/Streaming/${rtspPath}/${channel}?starttime=${startTime}&endtime=${endTime}`;
}

/**
 * Download all segments concurrently with a fixed-size concurrency pool.
 *
 * @param {object} options - DownloadOptions
 * @param {string} options.ip - DVR IP address
 * @param {string} options.user - RTSP username
 * @param {string} options.pass - RTSP password
 * @param {string} options.channel - Channel identifier
 * @param {Array} options.segments - Array of TimeSegment objects
 * @param {number} options.concurrency - Max concurrent downloads (1-8, default 4)
 * @param {string} [options.codec] - "h264" | "hevc" - if not provided, detect from first segment
 * @param {string} options.outputDir - Directory to store downloaded segment files
 * @param {string} options.baseFilename - Base filename for segment files
 * @param {function} options.onProgress - Callback for progress updates
 * @param {AbortSignal} [options.signal] - Optional AbortSignal for cancellation support
 * @returns {Promise<Array>} Array of SegmentResult objects
 */
export async function downloadAll(options) {
  const {
    ip, rtspPort,
    user,
    pass,
    channel,
    segments,
    concurrency = 4,
    codec: providedCodec,
    outputDir,
    baseFilename,
    onProgress,
    signal,
    // Test seams: allow injecting a fake `spawn` and a no-op `delay` so unit
    // tests can exercise the concurrency/retry logic deterministically without
    // launching real ffmpeg processes or waiting on real retry backoff timers.
    // Production callers omit these and get the real implementations.
    spawn: spawnFn = spawn,
    delay: delayFn = delay,
  } = options;

  if (signal?.aborted) throw new CancellationError();
  if (segments.length === 0) return [];

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Detect codec if not provided
  let codec = providedCodec;
  if (!codec) {
    codec = await detectCodec({ ip, rtspPort, user, pass, channel, segment: segments[0] });
  }

  const totalSegments = segments.length;

  // Results array indexed by segment index
  const results = new Array(totalSegments).fill(null);

  // Per-segment retry tracking
  const segmentRetries = new Array(totalSegments).fill(0);

  // Track active ffmpeg child processes for abort/kill
  const activeProcesses = new Map(); // segIndex -> ChildProcess
  let stopping = false;

  // Track all intermediate files created during this export for cleanup
  const intermediateFiles = [];

  /**
   * Delete all tracked intermediate files. Called on failure or cancellation.
   * Uses try/catch per file so one missing file doesn't prevent others from being cleaned.
   */
  function cleanupIntermediateFiles() {
    for (const filePath of intermediateFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // File may have already been deleted or never fully created - ignore
      }
    }
  }

  /**
   * Gracefully kill all active ffmpeg processes.
   * Sends SIGTERM first, then waits up to 5 seconds before sending SIGKILL.
   * @returns {Promise<void>}
   */
  async function gracefulKillAllProcesses() {
    const processes = [...activeProcesses.values()];
    if (processes.length === 0) return;

    // ChildProcess.killed only means a signal was sent, not that it exited.
    // Keep the export slot until every child closes, including after SIGKILL.
    await Promise.all(processes.map(proc => new Promise(resolve => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* wait for close */ }
      }, 5000);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try { proc.kill('SIGTERM'); } catch { /* wait for close */ }
    })));
  }

  // Per-segment byte tracking for progress
  const segmentBytes = new Array(totalSegments).fill(null).map(() => ({
    received: 0,
    estimated: 0,
  }));

  // Estimate bytes per segment based on duration (rough: ~500KB/s for typical DVR stream)
  const ESTIMATED_BITRATE = 4_000_000; // 4 Mbps estimate
  for (let i = 0; i < totalSegments; i++) {
    const seg = segments[i];
    const durationSec = estimateSegmentDuration(seg);
    segmentBytes[i].estimated = Math.max(1, (ESTIMATED_BITRATE / 8) * durationSec);
  }

  // Queue of segment indices to download
  const queue = [];
  let completedCount = 0;
  const inProgress = new Set();

  // --- Resume support: check for already-downloaded segment files ---
  // A segment is considered complete if a companion marker file exists.
  // The marker file (*.done) is written ONLY after ffmpeg exits successfully (code 0)
  // or when the file has valid data despite non-zero exit.
  // This guarantees we never resume from a half-written file.

  for (let i = 0; i < totalSegments; i++) {
    const segFilename = `${baseFilename}_seg${String(i).padStart(3, '0')}.h264`;
    const segPath = path.join(outputDir, segFilename);
    const donePath = segPath + '.done';

    try {
      // Only resume if both the .ts file AND the .done marker exist
      if (fs.existsSync(donePath) && fs.existsSync(segPath)) {
        const stats = fs.statSync(segPath);
        results[i] = {
          index: i,
          filePath: segPath,
          fileSize: stats.size,
          success: true,
          retries: 0,
        };
        segmentBytes[i].received = stats.size;
        completedCount++;
        continue;
      }
    } catch {
      // Any error - just re-download
    }

    // Clean up incomplete files (no .done marker means incomplete)
    try { fs.unlinkSync(segPath); } catch { /* ignore */ }
    try { fs.unlinkSync(donePath); } catch { /* ignore */ }

    queue.push(i);
  }

  // If all segments already downloaded (full resume), skip downloading
  if (completedCount === totalSegments) {
    if (onProgress) {
      onProgress({
        phase: 'downloading',
        overallPercent: 100,
        segmentsCompleted: completedCount,
        segmentsTotal: totalSegments,
        segmentsInProgress: [],
        message: `所有片段已存在，跳过下载（断点续传）`,
      });
    }
    return results;
  }

  // Report how many segments were resumed
  if (completedCount > 0 && onProgress) {
    onProgress({
      phase: 'downloading',
      overallPercent: Math.min(100, (completedCount / totalSegments) * 100),
      segmentsCompleted: completedCount,
      segmentsTotal: totalSegments,
      segmentsInProgress: [],
      message: `已恢复 ${completedCount}/${totalSegments} 个片段，继续下载剩余片段...`,
    });
  } else {
    // Report initial progress
    reportDownloadProgress();
  }

  /**
   * Report current download progress via onProgress callback.
   * @param {object} [retryInfo] - Optional retry info: { segment, attempt }
   */
  function reportDownloadProgress(retryInfo) {
    if (!onProgress) return;

    const totalReceived = segmentBytes.reduce((sum, s) => sum + s.received, 0);
    const totalEstimated = segmentBytes.reduce((sum, s) => sum + s.estimated, 0);
    const overallPercent = totalEstimated > 0
      ? Math.min(100, (totalReceived / totalEstimated) * 100)
      : 0;

    const update = {
      phase: 'downloading',
      overallPercent,
      segmentsCompleted: completedCount,
      segmentsTotal: totalSegments,
      segmentsInProgress: [...inProgress],
      message: `下载中 ${completedCount}/${totalSegments} 完成`,
    };

    if (retryInfo) {
      update.currentRetry = retryInfo;
      update.message = `片段 ${retryInfo.segment} 下载失败，正在重试 (${retryInfo.attempt}/2)...`;
    }

    onProgress(update);
  }

  /**
   * Download a single segment using ffmpeg.
   * @param {number} segIndex - Index of the segment to download
   * @returns {Promise<object>} SegmentResult
   */
  function downloadSegment(segIndex) {
    return new Promise((resolve, reject) => {
      const segment = segments[segIndex];
      const rtspUrl = buildRtspUrl(ip, user, pass, channel, segment.startTime, segment.endTime, 'tracks', rtspPort);
      const segFilename = `${baseFilename}_seg${String(segIndex).padStart(3, '0')}.h264`;
      const outputPath = path.join(outputDir, segFilename);

      const downloadArgs = [
        '-rtsp_transport', 'tcp',
        '-timeout', '15000000',
        '-i', rtspUrl,
        '-c:v', 'copy', '-an', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', '-y', outputPath,
        '-vn', '-c:a', 'copy', '-f', 'adts', '-y', outputPath.replace(/\.h264$/, '.aac'),
      ];

      // Track this file as intermediate before spawning ffmpeg
      intermediateFiles.push(outputPath);
      intermediateFiles.push(outputPath.replace(/\.h264$/, '.aac'));

      const ffmpeg = spawnFn(ffmpegPath, downloadArgs);

      // Track active process for abort capability
      activeProcesses.set(segIndex, ffmpeg);

      // Flag to detect connection-refused errors from stderr
      let connectionRefused = false;

      let processError;
      ffmpeg.on('error', (err) => {
        processError = new Error(`ffmpeg spawn error for segment ${segIndex}`);
      });

      // Parse ffmpeg stderr for progress information and connection errors
      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();

        // Detect connection-refused patterns in ffmpeg stderr
        for (const pattern of CONNECTION_REFUSED_PATTERNS) {
          if (pattern.test(output)) {
            if (!connectionRefused) {
              console.log(`[download-manager] seg ${segIndex} RTSP connection refused`);
            }
            connectionRefused = true;
            break;
          }
        }

        // Parse size= from ffmpeg output (in kB)
        const sizeMatch = output.match(/size=\s*(\d+)kB/);
        if (sizeMatch) {
          const sizeKB = parseInt(sizeMatch[1], 10);
          segmentBytes[segIndex].received = sizeKB * 1024;
          reportDownloadProgress();
        }
      });

      ffmpeg.on('close', (code) => {
        activeProcesses.delete(segIndex);
        if (processError) { reject(processError); return; }
        if (stopping) { reject(new CancellationError()); return; }

        console.log(`[download-manager] seg ${segIndex} ffmpeg exited code=${code}, connectionRefused=${connectionRefused}`);

        // Get actual file size
        let fileSize = 0;
        try {
          const stats = fs.statSync(outputPath);
          fileSize = stats.size;
        } catch {
          // File might not exist if ffmpeg produced no output
        }

        // Minimum valid segment size: a real segment with video data should be at least 10KB.
        // Anything smaller is likely just TS headers with no actual video frames.
        const MIN_VALID_SIZE = 10 * 1024; // 10 KB

        if (code === 0 && fileSize >= MIN_VALID_SIZE) {
          // Update received bytes to actual file size
          segmentBytes[segIndex].received = fileSize;

          // Update estimated bytes for future segments based on actual data
          if (fileSize > 0 && completedCount === 0) {
            const actualDuration = estimateSegmentDuration(segment);
            const actualBytesPerSec = fileSize / actualDuration;
            // Recalibrate estimates for remaining segments
            for (let i = 0; i < totalSegments; i++) {
              if (!results[i]) {
                const dur = estimateSegmentDuration(segments[i]);
                segmentBytes[i].estimated = actualBytesPerSec * dur;
              }
            }
          }

          // Write .done marker to indicate this segment is complete (for resume support)
          try { fs.writeFileSync(outputPath + '.done', ''); } catch { /* ignore */ }

          resolve({
            index: segIndex,
            filePath: outputPath,
            fileSize,
            success: true,
            retries: segmentRetries[segIndex],
          });
        } else if (code !== 0 && fileSize >= MIN_VALID_SIZE) {
          // File has substantial data despite non-zero exit (RTSP stream ended abruptly but data is valid)
          segmentBytes[segIndex].received = fileSize;

          // Write .done marker
          try { fs.writeFileSync(outputPath + '.done', ''); } catch { /* ignore */ }

          resolve({
            index: segIndex,
            filePath: outputPath,
            fileSize,
            success: true,
            retries: segmentRetries[segIndex],
          });
        } else {
          // Either exit code non-zero with no/tiny file, or exit code 0 but file too small
          const err = new Error(`ffmpeg exited with code ${code} for segment ${segIndex} (fileSize=${fileSize})`);
          err.connectionRefused = connectionRefused || isAbnormalExitCode(code);
          reject(err);
        }
      });
    });
  }

  // Handle empty segments case
  if (totalSegments === 0) {
    return [];
  }

  // Check if already aborted before starting
  if (signal && signal.aborted) {
    throw new CancellationError();
  }

  // Concurrency pool implementation with retry logic and adaptive degradation
  return new Promise((resolveAll, rejectAll) => {
    let aborted = false;
    let currentConcurrency = concurrency;

    async function stopWithError(error) {
      if (aborted) return;
      aborted = true;
      stopping = true;
      if (signal) signal.removeEventListener('abort', handleCancellation);
      await gracefulKillAllProcesses();
      cleanupIntermediateFiles();
      rejectAll(error);
    }

    function handleCancellation() {
      void stopWithError(new CancellationError());
    }

    // Listen for abort signal
    if (signal) {
      signal.addEventListener('abort', handleCancellation, { once: true });
    }

    function startNext() {
      if (aborted) return;

      while (inProgress.size < currentConcurrency && queue.length > 0) {
        const segIndex = queue.shift();
        inProgress.add(segIndex);
        reportDownloadProgress();

        downloadSegment(segIndex)
          .then((result) => {
            if (aborted) return;

            results[segIndex] = result;
            inProgress.delete(segIndex);
            completedCount++;
            reportDownloadProgress();

            // Check if all done
            if (completedCount === totalSegments) {
              // Remove signal listener on success
              if (signal) {
                signal.removeEventListener('abort', handleCancellation);
              }
              resolveAll(results);
            } else {
              // Start next queued segment
              startNext();
            }
          })
          .catch((err) => {
            if (aborted) return;

            inProgress.delete(segIndex);

            // Check if this is a connection-refused error (adaptive degradation)
            if (err.connectionRefused) {
              // Only decrement concurrency once per "round" — avoid multiple simultaneous
              // rejections all decrementing at once
              const prevConcurrency = currentConcurrency;
              if (currentConcurrency > 1 && inProgress.size >= currentConcurrency - 1) {
                // Multiple segments were running and this one got refused
                // Only reduce if we haven't already reduced this round
                currentConcurrency -= 1;

                console.log(`[download-manager] Connection refused for seg ${segIndex}, reducing concurrency: ${prevConcurrency} → ${currentConcurrency} (${inProgress.size} still in progress)`);

                // Notify progress reporter of concurrency change
                if (onProgress) {
                  onProgress({
                    phase: 'downloading',
                    overallPercent: 0,
                    segmentsCompleted: completedCount,
                    segmentsTotal: totalSegments,
                    segmentsInProgress: [...inProgress],
                    concurrencyReduced: true,
                    currentConcurrency,
                    message: `连接被拒绝，降低并发至 ${currentConcurrency}...`,
                  });
                }
              } else {
                console.log(`[download-manager] Connection refused for seg ${segIndex}, concurrency already at ${currentConcurrency} (${inProgress.size} in progress)`);
              }

              // Reset received bytes for this segment (will re-download)
              segmentBytes[segIndex].received = 0;

              // Put segment back in queue
              queue.unshift(segIndex);

              // If nothing else is in progress, we must retry after a delay
              if (inProgress.size === 0) {
                // Increment retry counter for this segment
                segmentRetries[segIndex]++;
                console.log(`[download-manager] No other segments running, retry ${segmentRetries[segIndex]}/5 for seg ${segIndex} after 8s delay`);

                if (segmentRetries[segIndex] > 5) {
                  void stopWithError(new Error(`Segment ${segIndex} connection refused after ${segmentRetries[segIndex]} retries`));
                  return;
                }
                reportDownloadProgress({ segment: segIndex, attempt: segmentRetries[segIndex] });
                // Wait longer (8s) to let DVR fully release connections
                delayFn(8000).then(() => startNext());
              }
              // else: do nothing — when running segments complete, startNext() is called naturally
            } else if (segmentRetries[segIndex] < 2) {
              // Normal failure: increment retry count
              segmentRetries[segIndex]++;

              // Reset received bytes for this segment (will re-download)
              segmentBytes[segIndex].received = 0;

              // Report retry via progress callback
              reportDownloadProgress({
                segment: segIndex,
                attempt: segmentRetries[segIndex],
              });

              // Push segment back to front of queue for retry
              queue.unshift(segIndex);

              // Wait 2 seconds before retrying to let DVR stabilize
              delayFn(2000).then(() => startNext());
            } else {
              // Stop siblings and wait for their close events before releasing the slot.
              void stopWithError(new Error(
                `Segment ${segIndex} failed after ${segmentRetries[segIndex] + 1} attempts: ${err.message}`
              ));
            }
          });
      }
    }

    startNext();
  });
}

/**
 * Estimate the duration of a segment in seconds from its time boundaries.
 * @param {object} segment - TimeSegment object
 * @returns {number} Duration in seconds
 */
function estimateSegmentDuration(segment) {
  const start = parseHikvisionTime(segment.startTime);
  const end = parseHikvisionTime(segment.endTime);
  return Math.max(1, (end.getTime() - start.getTime()) / 1000);
}

/**
 * Parse Hikvision time format string to Date object.
 * Format: "YYYYMMDDTHHmmssZ" e.g. "20231012T080000Z"
 * @param {string} timeStr
 * @returns {Date}
 */
function parseHikvisionTime(timeStr) {
  const year = parseInt(timeStr.substring(0, 4), 10);
  const month = parseInt(timeStr.substring(4, 6), 10) - 1;
  const day = parseInt(timeStr.substring(6, 8), 10);
  const hour = parseInt(timeStr.substring(9, 11), 10);
  const minute = parseInt(timeStr.substring(11, 13), 10);
  const second = parseInt(timeStr.substring(13, 15), 10);
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

