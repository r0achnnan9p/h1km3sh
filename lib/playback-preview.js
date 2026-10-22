/** Private, bounded standard-MP4 previews. Never publish these as export/upload outputs. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const PREVIEW_SECONDS = 30;
const abortError = () => Object.assign(new Error('回放请求已取消。'), { name: 'AbortError' });
const previewError = (message, status = 502) => Object.assign(new Error(message), { status });

export function previewIdentity({ sourceIdentity, camera, start, duration }) {
  const startMs = Date.parse(start), seconds = Number(duration);
  if (!/^[a-f0-9]{64}$/.test(sourceIdentity || '') || !/^[a-zA-Z0-9_-]{1,64}$/.test(camera || '')
    || !Number.isFinite(startMs) || !Number.isFinite(seconds) || seconds <= 0 || seconds > PREVIEW_SECONDS) {
    throw previewError(`标准 MP4 预览时长须在 ${PREVIEW_SECONDS} 秒以内。`, 400);
  }
  const iso = new Date(startMs).toISOString();
  return createHash('sha256').update(JSON.stringify([1, sourceIdentity, camera, iso.slice(0, 10), iso, seconds])).digest('hex');
}

// MediaMTX's pmp4 muxer writes ftyp + moov before mdat (faststart), preserving the
// original codecs and edit-list timing. Keep those bytes, including the edit list:
// a second copy-remux could change the requested wall-clock/keyframe alignment.
export function validatePreviewMp4(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, header = Buffer.alloc(16);
    let offset = 0, ftyp = false, moov = false, media = false;
    while (offset < size) {
      if (size - offset < 8 || fs.readSync(fd, header, 0, 8, offset) !== 8) throw new Error();
      const type = header.toString('ascii', 4, 8); let length = header.readUInt32BE(0), headerSize = 8;
      if (length === 1) {
        if (size - offset < 16 || fs.readSync(fd, header, 8, 8, offset + 8) !== 8) throw new Error();
        length = Number(header.readBigUInt64BE(8)); headerSize = 16;
      } else if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < headerSize || length > size - offset || type === 'moof') throw new Error();
      if (type === 'ftyp') ftyp = true;
      if (type === 'moov') moov = true;
      if (type === 'mdat') { if (!ftyp || !moov || length <= headerSize) throw new Error(); media = true; }
      offset += length;
    }
    if (!ftyp || !moov || !media) throw new Error();
    return size;
  } catch { throw previewError('MediaMTX 返回的标准 MP4 不完整或不支持快速起播。'); }
  finally { fs.closeSync(fd); }
}

export function createPlaybackPreviewCache({ root, ttlMs = 5 * 60_000, maxBytes = 256 * 1024 * 1024,
  maxFileBytes = 64 * 1024 * 1024, maxConcurrent = 2, timeoutMs = 30_000, now = Date.now } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const entries = new Map(); let generating = 0;
  function sweep(reserve = 0) {
    const files = fs.readdirSync(root).flatMap(name => {
      if (!/^[a-f0-9]{64}(?:\.[a-f0-9-]+)?\.(?:mp4|part)$/.test(name)) return [];
      const file = path.join(root, name), stats = fs.lstatSync(file);
      if (!stats.isFile()) return [];
      const entry = entries.get(name.slice(0, 64));
      return [{ file, name, stats, protected: Boolean(entry && (entry.users || entry.pending)) }];
    }).sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
    let bytes = files.reduce((sum, file) => sum + file.stats.size, 0);
    for (const file of files) {
      if (file.protected || (now() - file.stats.mtimeMs < ttlMs && bytes + reserve <= maxBytes)) continue;
      fs.unlinkSync(file.file); bytes -= file.stats.size; entries.delete(file.name.slice(0, 64));
    }
    return bytes;
  }
  const timer = setInterval(() => { try { sweep(); } catch { /* Next request retries cleanup. */ } }, Math.min(ttlMs, 60_000));
  timer.unref();
  async function acquire(key, getResponse, { signal } = {}) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw previewError('回放缓存标识无效。', 400);
    if (signal?.aborted) throw abortError();
    const file = path.join(root, `${key}.mp4`);
    sweep();
    let entry = entries.get(key);
    if (entry?.controller?.signal.aborted) entry = null;
    if (!entry && fs.existsSync(file)) {
      const stats = fs.lstatSync(file);
      if (stats.isFile() && stats.size > 0 && stats.size <= maxFileBytes) {
        entry = { file, size: stats.size, users: 0, pending: false }; entries.set(key, entry);
      }
    }
    if (!entry) {
      if (generating >= maxConcurrent || sweep((generating + 1) * maxFileBytes) + (generating + 1) * maxFileBytes > maxBytes) {
        throw previewError('回放正在准备，请稍后重试。', 503);
      }
      entry = { file, users: 0, pending: true, controller: new AbortController() };
      entries.set(key, entry); generating++;
      const current = entry, part = path.join(root, `${key}.${randomUUID()}.part`);
      current.promise = (async () => {
        const timeout = setTimeout(() => current.controller.abort(), timeoutMs);
        try {
          const response = await getResponse(current.controller.signal);
          if (!response.ok || !response.body) { await response.body?.cancel(); throw previewError('MediaMTX 暂时无法读取这段录像。'); }
          const advertised = response.headers.get('content-length');
          if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxFileBytes)) {
            await response.body.cancel(); throw previewError('回放片段超过大小限制。');
          }
          let bytes = 0;
          await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length;
            done(bytes > maxFileBytes ? previewError('回放片段超过大小限制。') : null, chunk);
          } }), fs.createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal: current.controller.signal });
          if (advertised !== null && bytes !== Number(advertised)) throw previewError('回放片段下载不完整。');
          current.size = validatePreviewMp4(part);
          if (current.controller.signal.aborted) throw abortError();
          fs.renameSync(part, file); current.pending = false;
        } catch (error) {
          if (entries.get(key) === current) entries.delete(key);
          throw error;
        } finally {
          clearTimeout(timeout); generating--; fs.rmSync(part, { force: true });
        }
      })();
      // A disconnected client's promise still has a rejection handler.
      current.promise.catch(() => {});
    }
    entry.users++;
    let released = false, rejectAbort;
    const release = () => {
      if (released) return; released = true; signal?.removeEventListener('abort', aborted);
      entry.users--;
      if (!entry.users && entry.pending) entry.controller.abort();
    };
    const aborted = () => { release(); rejectAbort?.(abortError()); };
    const cancellation = new Promise((_resolve, reject) => { rejectAbort = reject; });
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      if (signal?.aborted) aborted();
      await Promise.race([entry.promise || Promise.resolve(), cancellation]);
      if (released) throw abortError();
      return { file: entry.file, size: entry.size, release };
    } catch (error) { release(); throw error; }
  }
  return { acquire, sweep, close() { clearInterval(timer); for (const entry of entries.values()) if (entry.pending) entry.controller.abort(); } };
}

export function parseByteRange(range, size) {
  if (!range) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(size - 1, last);
  return start >= size || start > end ? null : { start, end, status: 206 };
}

export function servePreviewFile(req, res, lease) {
  // No stable content validator is promised for a still-growing recording.
  // An If-Range precondition therefore falls back to the complete response.
  const range = req.get('if-range') ? null : req.get('range');
  const selected = parseByteRange(range, lease.size);
  res.set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff' });
  if (!selected) { lease.release(); return res.status(416).set('Content-Range', `bytes */${lease.size}`).end(); }
  const { start, end, status } = selected;
  res.status(status).set('Content-Length', String(end - start + 1));
  if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${lease.size}`);
  if (req.method === 'HEAD') { lease.release(); return res.end(); }
  const stream = fs.createReadStream(lease.file, { start, end });
  const close = () => { stream.destroy(); lease.release(); };
  res.once('close', close);
  stream.once('error', () => res.destroy());
  stream.once('close', () => { res.removeListener('close', close); lease.release(); });
  stream.pipe(res);
}
