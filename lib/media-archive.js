/** MediaMTX fMP4 分片适配器：按实际时长验证覆盖，避免把缺口标成有录像。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnExportProcess as spawn } from './export-process-lock.js';
import { ffmpegPath, ffprobePath } from './ffmpeg-paths.js';
import { wallTime, wallRange, displayWall } from './camera-time.js';
import { allocateArtifact, artifactWorkDir, cleanArtifactWork } from './artifacts.js';

export async function runMedia(binary, args, options = {}) {
  const { signal } = options;
    if (signal?.aborted) throw new Error('任务已取消。');
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [], stderr = [];
      let stdoutSize = 0, stderrSize = 0, pending = '', settled = false, timedOut = false, failed = false;
      let previousOutputSize = null, previousOutputSampleAt = null, outputSpeed = null;
      const append = (chunks, size, chunk) => {
        if (size >= 2 * 1024 * 1024) return size;
        const part = chunk.subarray(0, Math.max(0, 2 * 1024 * 1024 - size));
        chunks.push(part);
        return size + part.length;
      };
      const report = value => {
        const outputSize = /^total_size=([0-9]+)$/.exec(value);
        if (outputSize) {
          const size = Number(outputSize[1]), sampledAt = Date.now();
          if (previousOutputSize !== null && previousOutputSampleAt !== null && size >= previousOutputSize && sampledAt > previousOutputSampleAt) {
            outputSpeed = (size - previousOutputSize) / ((sampledAt - previousOutputSampleAt) / 1000);
          }
          previousOutputSize = size;
          previousOutputSampleAt = sampledAt;
          return;
        }
        const duration = Number(options.durationSeconds);
        if (!Number.isFinite(duration) || duration <= 0) return;
        const microseconds = /^out_time_(?:us|ms)=(-?\d+)$/.exec(value);
        const clock = /^out_time=(-?\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
        if (!microseconds && !clock) return;
        const seconds = microseconds ? Number(microseconds[1]) / 1_000_000
          : Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
        if (Number.isFinite(seconds)) {
          try { options.onProgress?.(Math.max(0, Math.min(1, seconds / duration)), outputSpeed); } catch { /* 进度展示不能中断媒体处理。 */ }
        }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15 * 60 * 1000);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        stdoutSize = append(stdout, stdoutSize, chunk);
        if (!options.onProgress) return;
        pending += chunk.toString('utf8');
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1); report(line);
        }
      });
      child.stderr.on('data', chunk => { stderrSize = append(stderr, stderrSize, chunk); });
      child.once('error', () => { failed = true; });
      child.once('close', code => {
        if (signal?.aborted) return finish(new Error('任务已取消。'));
        if (failed || timedOut || code !== 0) return finish(new Error('媒体处理失败，请检查素材、ffmpeg/ffprobe 和服务端配置。'));
        finish(null, { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });

}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function segmentStart(name) {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,6}))?\.mp4$/.exec(name);
  if (!match) return null;
  try {
    return wallTime(`${match[1]} ${match[2]}:${match[3]}:${match[4]}`) +
      Number((match[5] || '').padEnd(6, '0')) / 1000;
  } catch { return null; }
}

/** Compute the exact union of usable footage, clipping overlaps and preserving every gap. */
export function recordingCoverage(segments, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error('无效的录像区间。');
  const slices = [], missingIntervals = [];
  let cursor = startMs;
  const gap = (start, end) => missingIntervals.push({
    start: displayWall(start), end: displayWall(end), startMs: start, endMs: end,
    durationSeconds: (end - start) / 1000,
  });
  for (const segment of [...segments].filter(item => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs)) {
    if (segment.endMs <= cursor || segment.startMs >= endMs) continue;
    if (segment.startMs > cursor) gap(cursor, segment.startMs);
    const start = Math.max(cursor, segment.startMs), end = Math.min(endMs, segment.endMs);
    slices.push({ ...segment, offset: (start - segment.startMs) / 1000, duration: (end - start) / 1000 });
    cursor = end;
    if (cursor >= endMs) break;
  }
  if (cursor < endMs) gap(cursor, endMs);
  const missingSeconds = missingIntervals.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0) / 1000;
  const requestedSeconds = (endMs - startMs) / 1000;
  return { slices, coverage: { complete: missingIntervals.length === 0, hasGaps: missingIntervals.length > 0,
    hasFootage: slices.length > 0, missingIntervals, missingSeconds, requestedSeconds,
    availableSeconds: requestedSeconds - missingSeconds } };
}

/** Existing callers require full coverage; permissive export must explicitly opt in. */
export function coverageSlices(segments, startMs, endMs) {
  const result = recordingCoverage(segments, startMs, endMs);
  return result.coverage.complete ? result.slices : [];
}

export function requireArchiveCoverage(coverage, acceptGaps = false) {
  if (!coverage.hasFootage || (coverage.hasGaps && acceptGaps !== true)) {
    const error = new Error(!coverage.hasFootage ? 'MediaMTX 目标区间没有可用录像，无法强制导出。'
      : `MediaMTX 录像缺少 ${coverage.missingSeconds} 秒；请确认接受缺口后导出已有录像，或自行选择 DVR 并核验录像。`);
    error.code = !coverage.hasFootage ? 'MEDIAMTX_EMPTY' : 'MEDIAMTX_GAPS';
    error.coverage = coverage;
    throw error;
  }
}

function filterPath(value) {
  return value.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''");
}

export function createMediaArchive({ root = process.env.HIKVISION_ARCHIVE_DIR, run = runMedia } = {}) {
  async function scan(camera, startMs, endMs, signal) {
    if (!root || !camera.archivePath) return [];
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(camera.archivePath)) throw new Error('无效的录像目录映射。');
    let realRoot, directory;
    try {
      realRoot = fs.realpathSync(root);
      directory = fs.realpathSync(path.join(realRoot, camera.archivePath));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('无法读取本地录像目录。');
    }
    if (!contained(realRoot, directory)) throw new Error('录像目录越界。');
    const candidates = fs.readdirSync(directory).map((name) => ({ name, startMs: segmentStart(name) }))
      .filter((item) => item.startMs !== null && item.startMs < endMs)
      .sort((a, b) => b.startMs - a.startMs);
    const segments = [];
    // 从最新文件倒推；只有整个窗口已覆盖才停止，较早的长分片也可能填补后续缺口。
    for (const candidate of candidates) {
      if (signal?.aborted) throw new Error('任务已取消。');
      const file = fs.realpathSync(path.join(directory, candidate.name));
      if (!contained(directory, file) || !fs.statSync(file).isFile()) throw new Error('录像文件越界。');
      let seconds;
      try {
        const { stdout } = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { signal });
        seconds = Number(JSON.parse(stdout).format?.duration);
      } catch {
        if (signal?.aborted) throw new Error('任务已取消。');
        continue; // 正在写入或损坏的分片不视为已覆盖。
      }
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      const end = candidate.startMs + seconds * 1000;
      if (end > startMs) segments.push({ file, startMs: candidate.startMs, endMs: end });
      if (candidate.startMs <= startMs && coverageSlices(segments, startMs, endMs).length) break;
    }
    return segments;
  }

  async function hasRecording(camera, start, end, { signal } = {}) {
    const { startMs, endMs } = wallRange(start, end);
    const { slices: availableSlices, coverage } = recordingCoverage(await scan(camera, startMs, endMs, signal), startMs, endMs);
    const slices = coverage.complete ? availableSlices : [];
    return { exists: coverage.complete, files: slices.map((item) => item.file), slices, availableSlices, coverage };
  }

  async function extractFrame(camera, ms, output, signal, label = false, work) {
    const segments = await scan(camera, ms, ms + 1, signal);
    const segment = segments.find((item) => item.startMs <= ms && item.endMs > ms);
    if (!segment) throw new Error('该时刻没有可用的 MediaMTX 录像。');
    await fileFrame(segment.file, (ms - segment.startMs) / 1000, ms, output, signal, label, work);
  }

  async function fileFrame(file, offset, ms, output, signal, label, work) {
    let filter = 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2';
    if (label) {
      const textFile = path.join(work, `${path.basename(output)}.txt`);
      fs.writeFileSync(textFile, displayWall(ms).slice(11), 'utf8');
      const configuredFont = process.env.HIKVISION_FONT_FILE || (process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/TTF/DejaVuSans.ttf');
      filter += `,drawtext=fontfile='${filterPath(configuredFont)}':textfile='${filterPath(textFile)}':x=8:y=h-th-8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.7`;
    }
    await run(ffmpegPath, ['-v', 'error', '-y', '-ss', String(offset), '-i', file,
      '-frames:v', '1', '-vf', filter, '-threads', '1', output], { signal });
    if (!fs.existsSync(output)) throw new Error('该时刻未能解出画面。');
  }

  async function publish(kind, generate, outputFile) {
    if (outputFile) {
      const work = artifactWorkDir();
      try { await generate(outputFile, work); return outputFile; }
      finally { cleanArtifactWork(work); }
    }
    const artifact = allocateArtifact(kind), work = artifactWorkDir();
    const temporary = path.join(work, path.basename(artifact.file));
    try {
      await generate(temporary, work);
      fs.renameSync(temporary, artifact.file);
      return { url: artifact.url, relative: artifact.relative };
    } finally { cleanArtifactWork(work); }
  }

  return {
    hasRecording,
    async inspectCoverage(camera, start, end, options = {}) { return (await hasRecording(camera, start, end, options)).coverage; },
    async getSnapshot(camera, datetime, { signal, outputFile } = {}) {
      const ms = wallTime(datetime);
      return publish('snapshot', (output) => extractFrame(camera, ms, output, signal), outputFile);
    },
    async createTimelineSheet(camera, { date, start, interval = 60, count = 36 }, { signal, outputFile, inputFile } = {}) {
      const startMs = wallTime(`${date} ${start}`);
      if (!Number.isInteger(interval) || interval < 1 || interval > 3600 || !Number.isInteger(count) || count < 1 || count > 36) {
        throw new Error('interval 必须为 1–3600 秒，count 必须为 1–36。');
      }
      return publish('timeline', async (output, work) => {
        for (let index = 0; index < count; index++) {
          const frame = path.join(work, `frame_${String(index).padStart(3, '0')}.png`);
          if (inputFile) await fileFrame(inputFile, index * interval, startMs + index * interval * 1000, frame, signal, true, work);
          else await extractFrame(camera, startMs + index * interval * 1000, frame, signal, true, work);
        }
        const cols = Math.min(6, Math.ceil(Math.sqrt(count))), rows = Math.ceil(count / cols);
        await run(ffmpegPath, ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(work, 'frame_%03d.png'),
          '-vf', `tile=${cols}x${rows}:nb_frames=${count}`, '-frames:v', '1', '-threads', '1', output], { signal });
      }, outputFile);
    },
    async snapshotFromClip(file, datetime, outputFile, { signal } = {}) {
      return publish('snapshot', (output) => fileFrame(file, 0, wallTime(datetime), output, signal, false), outputFile);
    },
    async cutClip(camera, start, end, { signal, outputFile, mode = 'precise', onProgress, acceptGaps = false, onCoverage } = {}) {
      if (!['copy', 'precise'].includes(mode)) throw new Error('mode 必须为 copy 或 precise。');
      const found = await hasRecording(camera, start, end, { signal });
      if (typeof acceptGaps !== 'boolean') throw new Error('acceptGaps 必须为布尔值。');
      requireArchiveCoverage(found.coverage, acceptGaps);
      const slices = acceptGaps ? found.availableSlices : found.slices;
      onCoverage?.(found.coverage);
      const generate = async (output, work) => {
        const pieces = [];
        const totalDuration = slices.reduce((sum, slice) => sum + slice.duration, 0);
        let completedDuration = 0;
        for (const [index, slice] of slices.entries()) {
          const piece = path.join(work, `piece_${index}.mp4`);
          // 全场优先复制原始码流；边界只能落在附近关键帧，精确短片仍可选择转码。
          const codec = mode === 'copy' ? ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
            : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-threads', '2'];
          await run(ffmpegPath, ['-progress', 'pipe:1', '-nostats', '-v', 'error', '-y', '-ss', String(slice.offset), '-i', slice.file, '-t', String(slice.duration),
            '-map', '0:v:0', '-map', '0:a?', ...codec, piece], {
            signal, durationSeconds: slice.duration,
            onProgress: (fraction, speed) => onProgress?.(Math.round((completedDuration + slice.duration * fraction) / totalDuration * 92), `正在处理录像片段 ${index + 1}/${slices.length}`, speed),
          });
          pieces.push(piece);
          completedDuration += slice.duration;
          onProgress?.(Math.round(completedDuration / totalDuration * 92), `已处理录像片段 ${index + 1}/${slices.length}`);
        }
        const list = path.join(work, 'concat.txt');
        fs.writeFileSync(list, pieces.map((file) => `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
        onProgress?.(93, '正在合并录像片段');
        await run(ffmpegPath, ['-progress', 'pipe:1', '-nostats', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output], {
          signal, durationSeconds: totalDuration,
          onProgress: (fraction, speed) => onProgress?.(93 + Math.round(fraction * 6), '正在合并录像片段', speed),
        });
        onProgress?.(99, '成片即将就绪');
      };
      if (!outputFile) return { ...(await publish('clip', generate)), coverage: found.coverage, acceptGaps };
      const work = artifactWorkDir();
      try { await generate(outputFile, work); return outputFile; }
      finally { cleanArtifactWork(work); }
    },
  };
}

