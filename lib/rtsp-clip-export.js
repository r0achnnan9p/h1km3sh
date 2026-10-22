import { deviceCacheKey } from './device-endpoint.js';
/**
 * RTSP Clip Export Module — 短片段快速导出
 *
 * 适用场景：用户只需要一小段视频（如 30 秒~10 分钟），而所在录像文件很大
 * （本项目实测 NVR 的 ISAPI 下载被限速在约 1X 实时且只能整文件下载）。
 *
 * 原理：
 *   - 海康 RTSP 回放 (rtsp://ip/Streaming/tracks/{ch}?starttime=...&endtime=...)
 *     支持任意时间点精确 seek（实测精确到秒），但发流速率被 NVR 限制在约 1X。
 *   - NVR 对多路并发回放线性扩展（实测 4 路并发每路速率不降），
 *     因此将片段均分为 N 段并发拉流，总耗时 ≈ 时长 / N。
 *   - 海康回放流按 GOP 对齐发送：实际发送范围是与请求窗口相交的所有 GOP，
 *     两端各可能多出 0~1 个 GOP（实测 GOP=2 秒），相邻段之间存在重叠。
 *     接缝对齐采用内容指纹（findOverlapCutoff）：重叠部分是 NVR 从同一录像
 *     文件转发的相同字节，字节级搜索定位截断点，无缝且不依赖固件时序行为。
 *   - 海康主码流为 I/P 帧结构（无 B 帧），裸流按 NAL 边界裁尾安全；
 *     掐头必须落在 IDR 边界，因此片段开头可能比请求时间早 0~2 秒（宁多勿少）。
 *
 * 流程：分段 → 并发拉 H.264 + AAC → 探测参数 → 音视频接缝去重 → 拼接 → 封装 MP4
 */

import { execFile } from 'node:child_process';
import { spawnExportProcess as spawn } from './export-process-lock.js';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream, existsSync, statSync, unlinkSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegPath, ffprobePath } from './ffmpeg-paths.js';
import { ProgressReporter } from './progress-reporter.js';
import { pullRtspRaw } from './rtsp-client.js';
import { collectDvrRecordingDiagnostics } from './dvr-recording-inspection.js';
import { dvrExportError, isDvrExportError } from './dvr-export-errors.js';
import { createRateTracker } from './rate-tracker.js';
import { compactToMs, msToCompact } from './hik-time.js';

const execFileAsync = promisify(execFile);

/** 单段最短时长（秒）——太短的段 RTSP 建连开销占比过大 */
const MIN_SEGMENT_SECONDS = 20;
/** 每段帧数上限余量（秒）——防止 NVR 多发 */
const FRAME_LIMIT_EXTRA_SECONDS = 6;
/** 默认帧率（探测失败时的回退值，海康主码流常见 20/25） */
const DEFAULT_FPS = 20;

/** 最终帧数是否足以覆盖请求窗口（允许 2 秒封装/边界误差）。 */
export function isFrameCountComplete(actualFrames, totalSeconds, fps) {
  if (![actualFrames, totalSeconds, fps].every(Number.isFinite) || totalSeconds <= 0 || fps <= 0) {
    return false;
  }
  const minimumFrames = Math.max(1, Math.round((totalSeconds - 2) * fps));
  return actualFrames >= minimumFrames;
}

// compact ↔ 毫秒的实现搬到了 lib/hik-time.js（那边不依赖 ffmpeg/RTSP，MCP 进程
// 可以单独引它）。这里再导出一次，保持既有 import 路径不变。
export { compactToMs, msToCompact };


/**
 * 把 [startMs, endMs] 均分为 N 段（用于并发拉流）。
 * N = min(concurrency, ceil(时长/MIN_SEGMENT_SECONDS))，至少 1 段。
 *
 * @returns {Array<{index:number, startMs:number, endMs:number}>}
 */
export function splitClipSegments(startMs, endMs, concurrency) {
  const totalSec = (endMs - startMs) / 1000;
  const n = Math.max(1, Math.min(concurrency, Math.ceil(totalSec / MIN_SEGMENT_SECONDS)));
  const segLen = (endMs - startMs) / n;
  const segments = [];
  for (let i = 0; i < n; i++) {
    segments.push({
      index: i,
      startMs: Math.round(startMs + i * segLen),
      endMs: i === n - 1 ? endMs : Math.round(startMs + (i + 1) * segLen),
    });
  }
  return segments;
}

/**
 * 拉取单段 RTSP 回放裸流。
 * 使用自研 RTSP 客户端（lib/rtsp-client.js）以携带 Rate-Control: no，
 * NVR 会全速发送（实测 ~4X 实时），远快于 ffmpeg 的默认 1X 派发。
 * 收满 maxFrames 或数据空闲超时即结束（NVR 发完窗口后不关会话）。
 *
 * @returns {Promise<{frames:number, filePath:string}>}
 */
async function pullSegment({ ip, rtspPort, user, pass, channel, startCompact, endCompact, windowSec, outPath, audioOutPath, maxFrames, signal, onFrameProgress }) {
  const result = await pullRtspRaw({
    ip, rtspPort,
    user,
    pass,
    path: `/Streaming/tracks/${channel}?starttime=${startCompact}&endtime=${endCompact}`,
    outPath,
    audioOutPath,
    fastPull: true,
    maxFrames,
    idleTimeoutMs: 15000,    // NVR 高负载时发流断续，太短会误判「发完」
    connectTimeoutMs: 20000, // NVR 会话池紧张时握手响应会变慢，放宽
    // 总时长上限：即便 NVR 只有 0.2X 速度也够拉完窗口（10 倍 + 2 分钟裕量）
    maxWallMs: (windowSec * 10 + 120) * 1000,
    captureFrameOffsets: true,
    signal,
    onProgress: (frames, bytes) => {
      if (onFrameProgress) onFrameProgress(frames, bytes);
    },
  });

  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    throw dvrExportError('DVR_NO_DATA');
  }
  // 音频可缺席：部分通道（摄像头没接拾音器）录像里根本没有音频轨，
  // 此时降级为纯视频导出，不再当作失败。
  return {
    frames: result.frames,
    audioFrames: result.audioFrames,
    filePath: outPath,
    audioPath: audioOutPath,
    meta: result.meta,
  };
}

/** 常见监控帧率候选集合 */
const FPS_CANDIDATES = [8, 10, 12, 12.5, 15, 16, 18, 20, 22, 24, 25, 30, 50, 60];

/**
 * 从「请求窗口时长 + 实际收到帧数」推导 fps（当 RTP 时间戳不可用时）。
 *
 * 原理：海康按 GOP 对齐发流，实际内容时长 = 窗口时长 + 0~4 秒余量。
 * 对常见 fps 候选逐一检验「帧数/fps 得到的时长是否落在 [窗口, 窗口+5s]」，
 * 所有段一致命中的候选即为答案。窗口越长该判据越锐利。
 *
 * @param {Array<{frames:number, startMs:number, endMs:number}>} pulled
 * @returns {number|null}
 */
export function deriveFpsFromFrameCounts(pulled) {
  // 单段无法区分「较低 fps 的完整窗口」和「较高 fps 的不完整窗口」，
  // 交给 RTP/GOP/ffprobe 链处理；至少两个独立窗口才能用一致性判断。
  if (pulled.length < 2) return null;

  const matches = FPS_CANDIDATES.map(fps => {
    const excesses = pulled.map(seg => {
      const windowSec = (seg.endMs - seg.startMs) / 1000;
      const contentSec = seg.frames / fps;
      return contentSec - windowSec;
    });
    const valid = excesses.every(excess => excess >= -0.05 && excess <= 5);
    const score = excesses.reduce((sum, excess) => sum + Math.abs(excess), 0) / excesses.length;
    return { fps, valid, score };
  }).filter(item => item.valid).sort((a, b) => a.score - b.score);

  if (matches.length === 0) return null;
  // 选择最贴近请求窗口的候选；若前两名几乎相同则仍视为不确定。
  if (matches.length > 1 && Math.abs(matches[1].score - matches[0].score) < 0.1) return null;
  return matches[0].fps;
}

/**
 * 综合推导 fps。链条（可靠性从高到低）：
 *   1. RTP 时间戳帧间隔（协议级；海康回放流该值通常损坏，仅有效时用）
 *   2. 帧数/窗口时长唯一匹配（需要段拉取完整）
 *   3. GOP 整除交叉验证（GOP 秒数几乎总是 1~4 的整数；结合 ffprobe 读数筛选）
 *   4. ffprobe 读数（已做 field-rate 双倍误报修正）
 *
 * @returns {{fps: number, source: string}}
 */
export function deriveFps(pulled, probed) {
  const rtp = deriveFpsFromRtp(pulled);
  if (rtp) return { fps: rtp, source: 'rtp' };

  const byCount = deriveFpsFromFrameCounts(pulled);
  if (byCount) return { fps: byCount, source: 'frame-count' };

  if (probed.gopFrames > 0) {
    const byGop = FPS_CANDIDATES.filter(f => {
      const gopSec = probed.gopFrames / f;
      return Number.isInteger(gopSec) && gopSec >= 1 && gopSec <= 4;
    });
    if (byGop.length === 1) return { fps: byGop[0], source: 'gop' };
    if (byGop.includes(probed.fps)) return { fps: probed.fps, source: 'gop+ffprobe' };
  }

  return { fps: probed.fps, source: 'ffprobe' };
}

/**
 * 内容指纹对齐（主对齐路径）：
 * 相邻两段的重叠部分是 NVR 从同一录像文件转发的**完全相同的字节**。
 * 取段 k+1 裸流开头的一小段字节做指纹，在段 k 文件尾部搜索：
 *   - 命中 → 命中偏移即段 k 的截断点（其后内容与段 k+1 开头逐字节重复），
 *     直接按字节截断即可实现帧级无缝拼接（Annex-B 在 NAL 边界截断合法，
 *     且命中点必然是 NAL 起始码位置）。
 *   - 未命中 → 两段间存在真实录像缺口（或异常），整段保留。
 *
 * 该方法不依赖任何固件时序行为（海康回放流的 RTP 时间戳是坏的），
 * 是字节级确定性的。
 *
 * @param {string} prevPath - 段 k 文件路径
 * @param {string} nextPath - 段 k+1 文件路径
 * @returns {number|null} 段 k 应截断到的字节长度；null 表示未找到重叠
 */
export function findOverlapCutoff(prevPath, nextPath) {
  const FINGERPRINT_SIZE = 4096;      // 含 SPS/PPS + IDR 头部数据，唯一性足够
  const SEARCH_WINDOW = 32 * 1024 * 1024; // 段尾搜索窗口（重叠一般 <4s，32MB 富余）
  const MIN_OVERLAP_SIZE = 4096;

  let fpFd = null, prevFd = null;
  try {
    // 读段 k+1 开头窗口。单靠 4KB 指纹会被 H.264 起始码、SPS/PPS
    // 或低熵画面误命中；命中后还必须验证「prev 的完整后缀 == next 的前缀」。
    const nextSize = statSync(nextPath).size;
    const nextReadLen = Math.min(nextSize, SEARCH_WINDOW);
    fpFd = openSync(nextPath, 'r');
    const nextBuf = Buffer.alloc(nextReadLen);
    const nextLen = readSync(fpFd, nextBuf, 0, nextReadLen, 0);
    const fpLen = Math.min(FINGERPRINT_SIZE, nextLen);
    if (fpLen < 64) return null; // 太短不可靠
    const fingerprint = nextBuf.subarray(0, fpLen);

    // 读段 k 尾部窗口
    const prevSize = statSync(prevPath).size;
    const readStart = Math.max(0, prevSize - SEARCH_WINDOW);
    const winLen = prevSize - readStart;
    prevFd = openSync(prevPath, 'r');
    const winBuf = Buffer.alloc(winLen);
    readSync(prevFd, winBuf, 0, winLen, readStart);

    // 从最早候选开始找；第一个通过完整后缀验证的候选就是最长重叠。
    // 这既避免短重复序列假阳性，也不会把真实 2 秒重叠误裁成几 KB。
    let from = 0;
    while (from <= winBuf.length - fpLen) {
      const idx = winBuf.indexOf(fingerprint, from);
      if (idx < 0) break;
      const overlapLen = winBuf.length - idx;
      if (
        overlapLen >= MIN_OVERLAP_SIZE &&
        overlapLen <= nextLen &&
        winBuf.subarray(idx).equals(nextBuf.subarray(0, overlapLen))
      ) {
        return readStart + idx;
      }
      from = idx + 1;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (fpFd !== null) { try { closeSync(fpFd); } catch (_) {} }
    if (prevFd !== null) { try { closeSync(prevFd); } catch (_) {} }
  }
}

function readAdtsFrames(filePath) {
  const data = readFileSync(filePath);
  const frames = [];
  let offset = 0;
  while (offset + 7 <= data.length) {
    if (data[offset] !== 0xff || (data[offset + 1] & 0xf6) !== 0xf0) {
      throw new Error(`AAC ADTS 同步字无效（偏移 ${offset}）`);
    }
    const frameLength = ((data[offset + 3] & 0x03) << 11) |
      (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    if (frameLength < 7 || offset + frameLength > data.length) {
      throw new Error(`AAC ADTS 帧长度无效（偏移 ${offset}）`);
    }
    frames.push({ start: offset, end: offset + frameLength });
    offset += frameLength;
  }
  if (offset !== data.length) throw new Error('AAC 文件尾部存在不完整帧');
  return { data, frames };
}

function signedRtpDiff(a, b) {
  const unsigned = (a - b) >>> 0;
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

/**
 * 视频字节指纹无法命中时，用跨会话一致的 RTP 时间戳算出重叠帧数，
 * 再根据拉流时记录的帧结束字节偏移确定安全截断点。
 */
export function findVideoRtpOverlapCutoff(prevMeta, nextMeta) {
  const prevLast = prevMeta?.lastFrameTs;
  const nextFirst = nextMeta?.firstFrameTs;
  const step = nextMeta?.tsDeltaMode || prevMeta?.tsDeltaMode;
  const offsets = prevMeta?.frameEndBytes;
  if (![prevLast, nextFirst, step].every(Number.isFinite) || step <= 0 || !Array.isArray(offsets)) return null;
  const overlapTicks = signedRtpDiff(prevLast, nextFirst);
  if (overlapTicks < 0) return null;
  const steps = overlapTicks / step;
  if (Math.abs(steps - Math.round(steps)) > 0.1) return null;
  const overlapFrames = Math.round(steps) + 1;
  if (overlapFrames <= 0 || overlapFrames > 300 || overlapFrames >= offsets.length) return null;
  const keepFrames = offsets.length - overlapFrames;
  const cutoff = offsets[keepFrames - 1];
  return Number.isFinite(cutoff) && cutoff > 0 ? cutoff : null;
}

/**
 * 利用跨 RTSP 会话保持一致的归档 RTP 时间戳计算 AAC 重叠帧，再用字节内容复核。
 * 返回前一段应保留的字节数；null 表示没有可证明的重叠，宁可不裁。
 */
export function findAudioOverlapCutoff(prevPath, nextPath, prevMeta, nextMeta) {
  const prevLast = prevMeta?.lastFrameTs;
  const nextFirst = nextMeta?.firstFrameTs;
  const step = nextMeta?.tsDeltaMode || prevMeta?.tsDeltaMode;
  if (![prevLast, nextFirst, step].every(Number.isFinite) || step <= 0) return null;

  const overlapTicks = signedRtpDiff(prevLast, nextFirst);
  if (overlapTicks < 0) return null;
  const steps = overlapTicks / step;
  if (Math.abs(steps - Math.round(steps)) > 0.1) return null;
  const overlapFrames = Math.round(steps) + 1;
  // 海康边界预取通常不超过 4 秒；上限用于防御异常/回绕时间戳。
  if (overlapFrames <= 0 || overlapFrames > 200) return null;

  try {
    const prev = readAdtsFrames(prevPath);
    const next = readAdtsFrames(nextPath);
    if (overlapFrames >= prev.frames.length || overlapFrames > next.frames.length) return null;
    const cutoff = prev.frames[prev.frames.length - overlapFrames].start;
    const nextEnd = next.frames[overlapFrames - 1].end;
    if (!prev.data.subarray(cutoff).equals(next.data.subarray(0, nextEnd))) return null;
    return cutoff;
  } catch (_) {
    return null;
  }
}

/**
 * 从各段 RTP 元数据推导 fps。
 * 帧间 RTP 时间戳差众数（90kHz 时钟）是协议级信息，比 ffprobe 读 SPS VUI
 * 更可靠（不同 ffprobe 版本对 VUI field rate 的解释不一致，实测 6.x 报 20fps
 * 而 7.x 报 40fps）。
 *
 * @param {Array<{meta?: object}>} pulled
 * @returns {number|null} fps 或 null（元数据不可用）
 */
export function deriveFpsFromRtp(pulled) {
  const counts = new Map();
  for (const seg of pulled) {
    const delta = seg.meta?.tsDeltaMode;
    if (delta && delta > 0) {
      counts.set(delta, (counts.get(delta) || 0) + 1);
    }
  }
  let best = null, bestCount = 0;
  for (const [delta, count] of counts) {
    if (count > bestCount) { bestCount = count; best = delta; }
  }
  if (!best) return null;
  const fps = 90000 / best;
  if (fps < 1 || fps > 60) return null;
  // 舍入到 0.01（25fps 等整值不受影响，23.976 等分数帧率保留两位）
  return Math.round(fps * 100) / 100;
}


/**
 * 探测裸 H.264 流的 fps（SPS VUI timing）与 GOP 帧数（前两个 I 帧间隔）。
 *
 * @param {string} filePath - 裸流文件
 * @returns {Promise<{fps:number, gopFrames:number}>}
 */
export async function probeStreamParams(filePath) {
  let fps = DEFAULT_FPS;
  let gopFrames = 0;

  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 30000 });
    const m = stdout.trim().match(/^(\d+)\/(\d+)$/);
    if (m && parseInt(m[2], 10) > 0) {
      let val = parseInt(m[1], 10) / parseInt(m[2], 10);
      // H.264 VUI timing 描述的是 field rate，部分 ffprobe 版本（实测 7.x）
      // 直接除 num_units 报出 2 倍帧率。监控流帧率极少超过 32，出现
      // 32-60 的读数按双倍误报减半处理。
      if (val > 32 && val <= 60) val = val / 2;
      if (val >= 1 && val <= 60) fps = val;
    }
  } catch (_) { /* 用默认值 */ }

  try {
    // 只读前 200 帧的 pict_type，找第二个 I 帧位置得到 GOP 长度
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'frame=pict_type',
      '-of', 'csv=p=0',
      '-read_intervals', '%+#200',
      filePath,
    ], { timeout: 60000 });
    const types = stdout.split(/\r?\n/).map(s => s.trim().replace(/,+$/, '')).filter(Boolean);
    const firstI = types.indexOf('I');
    if (firstI >= 0) {
      const secondI = types.indexOf('I', firstI + 1);
      if (secondI > firstI) gopFrames = secondI - firstI;
    }
  } catch (_) { /* gopFrames 保持 0 = 未知 */ }

  return { fps, gopFrames };
}

/**
 * 二进制顺序拼接多个 Annex-B 裸流文件（支持按字节截断）。
 *
 * @param {Array<{path: string, endByte: number|null}>} parts - endByte 为
 *   截断长度（不含该偏移之后的数据）；null 表示整个文件
 */
async function concatRawFiles(parts, outPath) {
  async function* chunks() {
    for (const { path: filePath, endByte } of parts) {
      if (endByte === 0) continue;
      const opts = endByte !== null ? { end: endByte - 1 } : {};
      yield* createReadStream(filePath, opts);
    }
  }
  // pipeline closes both streams on failure before its promise settles.
  await pipeline(chunks(), createWriteStream(outPath));
}

/**
 * H.264 + ADTS AAC → MP4 封装。
 * 视频用 -r 强制恒定帧率解释以修复海康缺失的 PTS；音频保留原始 AAC，
 * 全程不转码。
 */
function muxToMp4(rawPath, audioPath, mp4Path, fps) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-r', String(fps),
      '-i', rawPath,
      ...(audioPath ? ['-i', audioPath] : []),
      '-map', '0:v:0',
      ...(audioPath ? ['-map', '1:a:0', '-c:a', 'copy'] : []),
      '-c:v', 'copy',
      '-movflags', '+faststart',
      '-y', mp4Path,
    ]);
    // Drain stderr without persisting or reflecting paths or source metadata.
    proc.stderr.resume();
    proc.on('error', () => reject(dvrExportError('DVR_MUX_FAILED')));
    proc.on('close', (code) => {
      if (code === 0 && existsSync(mp4Path) && statSync(mp4Path).size > 0) {
        resolve();
      } else {
        reject(dvrExportError('DVR_MUX_FAILED'));
      }
    });
  });
}

/**
 * 运行 RTSP 并发分段导出管线。
 *
 * @param {object} options
 * @param {string} options.ip
 * @param {string} options.user
 * @param {string} options.pass
 * @param {string} options.channel - 轨道号（如 "101"）
 * @param {string} options.startTime - compact 格式 "20260714T020000Z"
 * @param {string} options.endTime - compact 格式
 * @param {string} options.taskId
 * @param {Array} options.sseClients
 * @param {string} options.outputDir
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.concurrency=4] - 并发拉流路数
 * @returns {Promise<string>} 最终 MP4 路径
 */
export async function runRtspClipExport(options) {
  const {
    ip, httpPort, rtspPort, deviceId, user, pass, channel, startTime, endTime,
    taskId, sseClients, outputDir, signal,
    concurrency = 4,
    pullSegment: pullSegmentFn = pullSegment, // deterministic cancellation tests
    inspectRecordingFailure = collectDvrRecordingDiagnostics,
  } = options;

  const progress = new ProgressReporter(taskId, sseClients);
  const startMs = compactToMs(startTime);
  const endMs = compactToMs(endTime);
  const totalSec = (endMs - startMs) / 1000;

  if (!(totalSec > 0)) throw new Error('无效的时间范围');

  const baseFilename = `dvr${deviceCacheKey({ ip, httpPort, rtspPort, deviceId })}_ch${channel}_${startTime}_to_${endTime}`;
  const mp4Path = join(outputDir, `${baseFilename}.mp4`);
  const tempFiles = [];

  const checkAborted = () => {
    if (signal && signal.aborted) throw new Error('Download aborted');
  };

  try {
    // --- 1. 分段 ---
    const segments = splitClipSegments(startMs, endMs, concurrency);
    console.log(`[${taskId}] RTSP 音视频分段导出: ${totalSec}s → ${segments.length} 段并发`);
    progress.reportProgress({
      phase: 'downloading', overallPercent: 0,
      segmentsCompleted: 0, segmentsTotal: segments.length, segmentsInProgress: [],
      message: `RTSP 音视频提取：${segments.length} 路并发，正在等待录像机返回数据`,
    });

    // --- 2. 并发拉流（权重 0-85%）---
    checkAborted();
    const segFrameCounts = new Array(segments.length).fill(0);
    const segByteCounts = new Array(segments.length).fill(0);
    const segExpected = segments.map(s => Math.round(((s.endMs - s.startMs) / 1000) * DEFAULT_FPS));
    let completedCount = 0;
    const startedAt = Date.now();
    // 统计的是 H.264 裸流字节，不含 RTP/TCP 头，实际占用的链路带宽略高于此读数
    const rateTracker = createRateTracker();

    const reportDownload = () => {
      const received = segFrameCounts.reduce((a, b) => a + b, 0);
      const expected = segExpected.reduce((a, b) => a + b, 0);
      const pct = Math.min(99, (received / expected) * 100);
      // 有效提取速度：已提取的录像秒数 / 实际耗时
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const extractedSec = received / DEFAULT_FPS;
      const speedX = elapsedSec > 1 ? (extractedSec / elapsedSec) : 0;
      const speed = rateTracker.update(segByteCounts.reduce((a, b) => a + b, 0));
      progress.reportProgress({
        phase: 'downloading', overallPercent: pct,
        segmentsCompleted: completedCount, segmentsTotal: segments.length,
        segmentsInProgress: [],
        message: `RTSP 提取中 ${Math.round(pct)}%`,
        speed,
        speedX,
      });
    };
    const throttledReport = throttle(reportDownload, 1000);

    const pullController = new AbortController();
    const abortPulls = () => pullController.abort();
    signal?.addEventListener('abort', abortPulls, { once: true });
    if (signal?.aborted) abortPulls();
    let pullError;
    const pulls = segments.map((seg, i) => {
      const segPath = join(outputDir, `${baseFilename}_seg${i}.h264`);
      const audioPath = join(outputDir, `${baseFilename}_seg${i}.aac`);
      tempFiles.push(segPath, audioPath);
      const maxFrames = Math.round(((seg.endMs - seg.startMs) / 1000 + FRAME_LIMIT_EXTRA_SECONDS) * DEFAULT_FPS * 1.6); // 1.6 余量：兼容 25/30fps 设备
      return Promise.resolve().then(() => pullSegmentFn({
        ip, rtspPort, user, pass, channel,
        startCompact: msToCompact(seg.startMs),
        endCompact: msToCompact(seg.endMs),
        windowSec: (seg.endMs - seg.startMs) / 1000,
        outPath: segPath,
        audioOutPath: audioPath,
        maxFrames,
        signal: pullController.signal,
        onFrameProgress: (frames, bytes) => {
          segFrameCounts[i] = frames;
          segByteCounts[i] = bytes || 0;
          throttledReport();
        },
      })).then((r) => {
        segFrameCounts[i] = r.frames;
        completedCount++;
        throttledReport();
        console.log(`[${taskId}] 段 ${i} 完成: 视频 ${r.frames} 帧, 音频 ${r.audioFrames} 帧, 结束原因=${r.meta?.endReason}`);
        return {
          ...seg,
          frames: r.frames,
          audioFrames: r.audioFrames,
          filePath: segPath,
          audioPath,
          meta: r.meta,
        };
      }).catch(err => {
        if (!pullError) pullError = err;
        abortPulls();
        throw err;
      });
    });

    // A failed segment must not leave its siblings using the DVR after rejection.
    const settledPulls = await Promise.allSettled(pulls);
    signal?.removeEventListener('abort', abortPulls);
    if (pullError) throw pullError;
    const pulled = settledPulls.map(result => result.value);
    checkAborted();

    // 校验：任何一段为空都视为失败
    for (const seg of pulled) {
      if (!seg.frames || !existsSync(seg.filePath) || statSync(seg.filePath).size === 0) {
        throw dvrExportError('DVR_NO_DATA');
      }
    }

    // 音频要么每段都有，要么整体没有（通道无音频轨）。部分段有、部分段没有
    // 说明是拉流异常，拼出来会音画错位，仍按失败处理。
    const audioSegs = pulled.filter(
      (s) => s.audioFrames && existsSync(s.audioPath) && statSync(s.audioPath).size > 0
    );
    const hasAudio = audioSegs.length === pulled.length;
    if (audioSegs.length && !hasAudio) {
      throw dvrExportError('DVR_AUDIO_INCOMPLETE');
    }
    if (!hasAudio && pulled.some(seg => seg.meta?.audio?.codec)) {
      throw dvrExportError('DVR_AUDIO_INCOMPLETE');
    }
    if (!hasAudio) {
      console.log(`[${taskId}] 该通道录像无音频轨，按纯视频导出`);
    }

    // --- 3. 探测流参数（fps）---
    const probed = await probeStreamParams(pulled[0].filePath);
    const { fps, source: fpsSource } = deriveFps(pulled, probed);
    console.log(`[${taskId}] 流参数: fps=${fps} (来源=${fpsSource}, ffprobe=${probed.fps}), GOP=${probed.gopFrames} 帧`);

    // --- 4. 接缝对齐（内容指纹，权重 85-92%）---
    checkAborted();
    progress.reportProgress({
      phase: 'trimming', overallPercent: 0,
      segmentsCompleted: segments.length, segmentsTotal: segments.length, segmentsInProgress: [],
      message: '正在对齐接缝...',
    });

    // 相邻段的重叠内容是逐字节相同的（同一录像文件的转发），用段 k+1 开头
    // 指纹在段 k 尾部定位截断点。未命中即两段间存在真实录像缺口，整段保留。
    const finalParts = [];
    const finalAudioParts = [];
    for (let i = 0; i < pulled.length; i++) {
      if (i === pulled.length - 1) {
        finalParts.push({ path: pulled[i].filePath, endByte: null });
        if (hasAudio) finalAudioParts.push({ path: pulled[i].audioPath, endByte: null });
        continue;
      }
      const contentCutoff = findOverlapCutoff(pulled[i].filePath, pulled[i + 1].filePath);
      const cutoff = contentCutoff ?? findVideoRtpOverlapCutoff(pulled[i].meta, pulled[i + 1].meta);
      if (cutoff !== null) {
        const cutKB = ((statSync(pulled[i].filePath).size - cutoff) / 1024).toFixed(0);
        const source = contentCutoff !== null ? '内容指纹' : 'RTP 帧时间戳';
        console.log(`[${taskId}] 接缝 ${i}→${i + 1}: ${source}命中，截去尾部 ${cutKB} KB 重叠`);
        finalParts.push({ path: pulled[i].filePath, endByte: cutoff });
      } else {
        console.log(`[${taskId}] 接缝 ${i}→${i + 1}: 未找到重叠（该处可能存在录像缺口），整段保留`);
        finalParts.push({ path: pulled[i].filePath, endByte: null });
      }

      if (!hasAudio) continue;

      const audioCutoff = findAudioOverlapCutoff(
        pulled[i].audioPath,
        pulled[i + 1].audioPath,
        pulled[i].meta?.audio,
        pulled[i + 1].meta?.audio,
      );
      if (audioCutoff !== null) {
        const cutKB = ((statSync(pulled[i].audioPath).size - audioCutoff) / 1024).toFixed(1);
        console.log(`[${taskId}] 音频接缝 ${i}→${i + 1}: RTP 时间戳与内容复核通过，截去 ${cutKB} KB 重叠`);
        finalAudioParts.push({ path: pulled[i].audioPath, endByte: audioCutoff });
      } else {
        console.log(`[${taskId}] 音频接缝 ${i}→${i + 1}: 无可证明重叠，整段保留`);
        finalAudioParts.push({ path: pulled[i].audioPath, endByte: null });
      }
    }

    // --- 5. 拼接（92-95%）---
    checkAborted();
    progress.reportProgress({
      phase: 'concatenating', overallPercent: 50,
      segmentsCompleted: segments.length, segmentsTotal: segments.length, segmentsInProgress: [],
      message: '正在拼接分段...',
    });

    const concatPath = join(outputDir, `${baseFilename}_all.h264`);
    const concatAudioPath = join(outputDir, `${baseFilename}_all.aac`);
    tempFiles.push(concatPath, concatAudioPath);
    const concatenated = await Promise.allSettled([
      concatRawFiles(finalParts, concatPath),
      hasAudio ? concatRawFiles(finalAudioParts, concatAudioPath) : Promise.resolve(),
    ]);
    const concatFailure = concatenated.find(result => result.status === 'rejected');
    if (concatFailure) throw concatFailure.reason;

    // --- 6. 封装 MP4（95-100%）---
    checkAborted();
    progress.reportProgress({
      phase: 'remuxing', overallPercent: 50,
      segmentsCompleted: segments.length, segmentsTotal: segments.length, segmentsInProgress: [],
      message: '正在封装 MP4...',
    });

    await muxToMp4(concatPath, hasAudio ? concatAudioPath : null, mp4Path, fps);

    // 音视频完整性自检：既要有音轨，也要分别覆盖请求窗口。
    try {
      const { stdout } = await execFileAsync(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,nb_frames,duration,sample_rate,channels',
        '-of', 'json', mp4Path,
      ], { timeout: 30000 });
      const streams = JSON.parse(stdout).streams || [];
      const video = streams.find(s => s.codec_type === 'video');
      const audio = streams.find(s => s.codec_type === 'audio');
      if (!video) throw dvrExportError('DVR_VERIFY_FAILED');
      if (hasAudio && !audio) throw dvrExportError('DVR_AUDIO_INCOMPLETE');

      const nbFrames = parseInt(video.nb_frames, 10);
      const theoretical = Math.round(totalSec * fps);
      if (Number.isFinite(nbFrames)) {
        const diff = nbFrames - theoretical;
        console.log(`[${taskId}] 视频自检: 实际 ${nbFrames} 帧, 理论 ${theoretical}, 差 ${diff} (${(diff / fps).toFixed(1)}s)`);
        if (!isFrameCountComplete(nbFrames, totalSec, fps)) {
          throw dvrExportError('DVR_VIDEO_INCOMPLETE');
        }
      }
      if (hasAudio) {
        const audioDuration = Number(audio.duration);
        if (!Number.isFinite(audioDuration) || audioDuration < Math.max(0.1, totalSec - 2)) {
          throw dvrExportError('DVR_AUDIO_INCOMPLETE');
        }
        console.log(`[${taskId}] 音频自检: ${audio.sample_rate}Hz, ${audio.channels} 声道, ${audioDuration.toFixed(2)}s`);
      }
    } catch (err) {
      if (isDvrExportError(err)) throw err;
      throw dvrExportError('DVR_VERIFY_FAILED');
    }

    checkAborted();
    progress.reportComplete(`${baseFilename}.mp4`);
    console.log(`[${taskId}] ✓ RTSP 分段导出完成: ${mp4Path}`);
    return mp4Path;

  } catch (err) {
    if (err.message === 'Download aborted' || (signal && signal.aborted)) {
      progress.reportError('导出已取消');
      cleanupFiles(tempFiles);
      try { if (existsSync(mp4Path)) unlinkSync(mp4Path); } catch (_) {}
      throw new Error('导出已取消');
    }
    let failure = dvrExportError(err.code, err.failureDiagnostics);
    cleanupFiles(tempFiles);
    try { if (existsSync(mp4Path)) unlinkSync(mp4Path); } catch (_) {}
    if (failure.code === 'DVR_RTSP_REJECTED' && failure.failureDiagnostics?.method === 'DESCRIBE'
        && failure.failureDiagnostics.rtspStatus === 400) {
      let recording;
      try { recording = await inspectRecordingFailure({ ip, httpPort, rtspPort, user, pass, channel, startTime, endTime, signal }); }
      catch { recording = { outcome: 'failed', source: 'search', matchCount: 0, truncated: false, recordings: [] }; }
      if (signal?.aborted) { progress.reportError('导出已取消'); throw new Error('导出已取消'); }
      failure = dvrExportError(failure.code, { ...failure.failureDiagnostics, recording });
    }
    progress.reportError(failure.message);
    throw failure;
  } finally {
    // 成功路径也清理中间文件
    cleanupFiles(tempFiles);
  }
}

function cleanupFiles(files) {
  for (const f of files) {
    try { if (existsSync(f)) unlinkSync(f); } catch (_) {}
  }
}

function throttle(fn, intervalMs) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      fn(...args);
    }
  };
}
