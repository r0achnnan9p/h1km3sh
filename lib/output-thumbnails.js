/** Lazy, bounded stills. No public files or persisted video copies are created. */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ffmpegPath } from './ffmpeg-paths.js';
import { resolveLibraryOutput } from './output-library.js';

import { thumbnailVersion } from './output-thumbnail-version.js';
const failure = (status, message) => Object.assign(new Error(message), { status });

export function extractOutputThumbnail(file, { timeoutMs = 10000, maxBytes = 512 * 1024, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let fd, child, timer, bytes = 0, chunks = [], error;
    try {
      fd = fs.openSync(file.full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (thumbnailVersion({ ...file, stats: fs.fstatSync(fd) }) !== thumbnailVersion(file)) throw failure(409, '成片已更新，请刷新。');
      // An inherited descriptor pins the checked inode on Unix, even during rename/delete.
      const input = process.platform === 'linux' ? '/proc/self/fd/3' : process.platform === 'darwin' ? '/dev/fd/3' : file.full;
      child = spawnProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '67108864',
        '-threads', '1', '-filter_threads', '1', '-probesize', '5000000', '-analyzeduration', '2000000', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', input,
        '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease',
        '-threads', '1', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'ignore', fd], windowsHide: true });
      fs.closeSync(fd); fd = undefined;
      timer = setTimeout(() => { error = failure(504, '缩略图生成超时。'); child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { error = failure(422, '缩略图超出大小限制。'); chunks = []; child.kill('SIGKILL'); }
        else if (!error) chunks.push(chunk);
      });
      child.once('error', err => { error = failure(503, '缩略图服务暂不可用。'); });
      child.once('close', code => {
        clearTimeout(timer);
        if (error) return reject(error);
        const image = Buffer.concat(chunks);
        if (code !== 0 || image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) return reject(failure(422, '此成片暂时无法生成缩略图。'));
        resolve(image);
      });
    } catch (error) { if (fd !== undefined) fs.closeSync(fd); clearTimeout(timer); reject(error); }
  });
}

export function createOutputThumbnails({ root, isReady = () => true, isBusy = () => false, generate = extractOutputThumbnail,
  concurrency = 2, maxPending = 32, maxEntries = 128, maxCacheBytes = 32 * 1024 * 1024, failureTtlMs = 30000 } = {}) {
  const cache = new Map(), pending = new Map(), queue = [];
  let running = 0, cacheBytes = 0;
  function remember(key, entry) {
    cache.set(key, entry); cacheBytes += entry.image?.length || 0;
    while (cache.size > maxEntries || cacheBytes > maxCacheBytes) {
      const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).image?.length || 0; cache.delete(oldest);
    }
  }
  function current(id) {
    if (!isReady()) throw failure(503, '成片库正在恢复，请稍后重试。');
    const file = resolveLibraryOutput(root, id);
    if (!file) throw failure(404, '成片不存在。');
    if (isBusy(file)) throw failure(409, '成片尚未就绪。');
    return file;
  }
  function pump() {
    while (running < concurrency && queue.length) {
      const { id, key, resolve, reject } = queue.shift(); running++;
      Promise.resolve().then(async () => {
        const file = current(id);
        if (thumbnailVersion(file) !== key) throw failure(409, '成片已更新，请刷新。');
        const image = await generate(file);
        if (thumbnailVersion(current(id)) !== key) throw failure(409, '成片已更新，请刷新。');
        if (!Buffer.isBuffer(image) || image.length > 512 * 1024) throw failure(422, '缩略图超出大小限制。');
        remember(key, { image }); return image;
      }).then(resolve, error => {
        if ([422, 503, 504].includes(error.status)) remember(key, { error, expires: Date.now() + failureTtlMs });
        reject(error);
      }).finally(() => { pending.delete(key); running--; pump(); });
    }
  }
  async function get(id) {
    const key = thumbnailVersion(current(id)), entry = cache.get(key);
    if (entry?.image) { cache.delete(key); cache.set(key, entry); return entry.image; }
    if (entry?.expires > Date.now()) throw entry.error;
    if (entry) cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxPending) throw failure(503, '缩略图生成繁忙，请稍后重试。');
    const promise = new Promise((resolve, reject) => queue.push({ id, key, resolve, reject }));
    pending.set(key, promise); pump(); return promise;
  }
  return { get };
}

export function mountOutputThumbnails(app, options) {
  const thumbnails = createOutputThumbnails(options);
  app.get('/console/api/outputs/:id/thumbnail', async (req, res) => {
    // Recheck auth at the console gateway on every request, including cache hits.
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    try { res.type('image/jpeg').send(await thumbnails.get(req.params.id)); }
    catch (error) { if ([409, 503, 504].includes(error.status)) res.set('Retry-After', '5'); res.status(error.status || 500).end(); }
  });
  return thumbnails;
}
