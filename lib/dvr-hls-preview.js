/** One bounded, authenticated native-HLS DVR preview. Never expose its directory. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';
import { dvrPreviewArgs, previewFailure } from './dvr-preview-stream.js';
import { parseByteRange } from './playback-preview.js';

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const cancelled = () => Object.assign(fail('回放请求已取消。', 409), { name: 'AbortError' });
const allowedFile = name => name === 'index.m3u8' || /^segment-\d{6}\.ts$/.test(name);
export const DVR_HLS_MAX_SECONDS = 120;
export const DVR_LIVE_HLS_MAX_SECONDS = 600;

// Historical playback keeps a fixed origin. Do not expose a sliding live window
// and assume Safari will begin at the user's selected time.
export function historicalHlsPlaylist(text) {
  if (!/^#EXTM3U\r?\n/.test(text) || !/^#EXT-X-PLAYLIST-TYPE:EVENT\r?$/m.test(text)
    || !/^#EXT-X-MEDIA-SEQUENCE:0\r?$/m.test(text) || /^#EXT-X-START:/m.test(text)) throw fail('HLS 预览索引无效。');
  return Buffer.from(text.replace(/^#EXTM3U\r?\n/, '$&#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n'));
}

export function liveHlsPlaylist(text) {
  if (!/^#EXTM3U\r?\n/.test(text) || !/^#EXT-X-MEDIA-SEQUENCE:\d+\r?$/m.test(text)
    || /^#EXT-X-(?:PLAYLIST-TYPE|START):/m.test(text)) throw fail('HLS 直播索引无效。');
  return Buffer.from(text);
}

export function dvrHlsArgs(url, duration, directory, { live = false } = {}) {
  if (!Number.isFinite(duration) || duration < 0.5 || duration > (live ? DVR_LIVE_HLS_MAX_SECONDS : DVR_HLS_MAX_SECONDS)) throw fail('HLS 预览每组时长须在 2 分钟以内。', 400);
  const args = dvrPreviewArgs(url, duration, 'compat');
  const output = args.slice(0, args.indexOf('-movflags'));
  // Historical DVRs can burst much faster than real time. Pace input and keep
  // every fragment of this bounded EVENT until ENDLIST/session cleanup.
  if (!live) output.splice(output.indexOf('-i'), 0, '-re');
  output[output.indexOf('-g') + 1] = '50';
  output[output.indexOf('-vf') + 1] = `setpts=PTS-STARTPTS,${output[output.indexOf('-vf') + 1]}`;
  return [...output, '-r', '25', '-level:v', '3.1', '-maxrate', '3M', '-bufsize', '6M', '-keyint_min', '50', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-f', 'hls', '-hls_time', '2', '-hls_list_size', live ? '6' : '0', ...(live ? ['-hls_delete_threshold', '2'] : ['-hls_playlist_type', 'event']),
    '-hls_flags', `independent_segments+temp_file${live ? '+delete_segments' : ''}`, '-hls_segment_options', 'mpegts_copyts=1', '-hls_segment_filename', path.join(directory, 'segment-%06d.ts'),
    '-y', path.join(directory, 'index.m3u8')];
}

export function createDvrHlsPreview({ root, ffmpegPath, spawn = spawnProcess, firstSegmentTimeoutMs = 15000,
  idleTimeoutMs = 20000, maxBytes = 64 * 1024 * 1024, maxSegmentBytes = 8 * 1024 * 1024,
  wallGraceMs = 45000, pollMs = 100, killGraceMs = 500, now = Date.now } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // This private directory is owned exclusively by this server's preview manager.
  for (const name of fs.readdirSync(root)) if (/^[a-f0-9-]{36}$/.test(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  let current = null, ticket = 0;
  const clients = new Map();
  function accept(client, generation) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(client || '') || !Number.isSafeInteger(Number(generation)) || Number(generation) < 1 || Number(generation) > 1e12) throw fail('预览请求标识无效。', 400);
    generation = Number(generation);
    for (const [id, value] of clients) if (now() - value.time > 15 * 60_000) clients.delete(id);
    if (generation < (clients.get(client)?.generation || 0)) throw fail('预览已切换。', 409);
    if (!clients.has(client) && clients.size >= 64) clients.delete(clients.keys().next().value);
    clients.set(client, { generation, time: now() });
    return generation;
  }
  async function begin({ url, urls, duration, live = false, client, generation, isCurrent = () => true, onFinish = () => {} }) {
    generation = accept(client, generation);
    const sources = [...new Set(urls || [url])];
    if (!sources.length || sources.length > (live ? 2 : 1) || sources.some(source => typeof source !== 'string' || !source)) throw fail('无效的 HLS 来源。', 400);
    const key = createHash('sha256').update(JSON.stringify([sources, duration, live, client, generation])).digest('hex');
    if (current?.key === key && !current.finished) return current;
    const request = ++ticket;
    if (current) await current.stop('superseded');
    if (request !== ticket || clients.get(client)?.generation !== generation || !isCurrent()) throw fail('预览已切换。', 409);
    const id = randomUUID(), directory = path.join(root, id);
    dvrHlsArgs(sources[0], duration, directory, { live }); // Validate before allocating the session.
    fs.mkdirSync(directory, { mode: 0o700 });
    let child, ended = false, finished = false, ready = false, stderr = '', finishError;
    const waiters = new Set();
    let resolveReady, rejectReady, resolveClosed, watch, wall, killTimer;
    const started = now(); let touched = started, attemptStarted = started, attempt = 0, retryPending = false;
    const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); readyPromise.catch(() => {});
    const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
    function cleanup() {
      clearInterval(watch); clearTimeout(wall); clearTimeout(killTimer);
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
      if (current === session) current = null;
      try { onFinish(session); } catch {}
      resolveClosed();
    }
    function stop(reason, error = cancelled()) {
      if (finished) return closedPromise;
      finished = true; finishError = error; rejectReady(error);
      clearInterval(watch); clearTimeout(wall); clearTimeout(killTimer);
      if (ended || !child) cleanup();
      else {
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => { if (!ended) { try { child.kill('SIGKILL'); } catch {} } }, killGraceMs); killTimer.unref?.();
      }
      return closedPromise;
    }
    const session = { id, key, live, client, generation, directory, get finished() { return finished; }, stop,
      killNow() {
        const closed = stop('server exiting');
        if (!ended && child) { try { child.kill('SIGKILL'); } catch {} }
        // The exit event cannot await a child close callback.
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
        return closed;
      },
      async wait(signal) {
        const waiter = { signal }; waiters.add(waiter);
        let onAbort;
        const abortPromise = new Promise((_resolve, reject) => { onAbort = () => { reject(cancelled()); if (!ready && [...waiters].every(item => item.signal?.aborted)) stop('client disconnected'); }; signal?.addEventListener('abort', onAbort, { once: true }); });
        try { if (signal?.aborted) throw cancelled(); await Promise.race([readyPromise, abortPromise]); if (signal?.aborted) throw cancelled(); }
        finally { signal?.removeEventListener('abort', onAbort); waiters.delete(waiter); if (signal?.aborted && !ready && !waiters.size) stop('client disconnected'); }
      },
      touch() { touched = now(); },
    };
    current = session;
    function launch() {
      if (finished) return;
      if (request !== ticket || clients.get(client)?.generation !== generation || !isCurrent()) { stop('superseded'); return; }
      ended = false; stderr = ''; finishError = null; retryPending = false; attemptStarted = now(); touched = now();
      try { child = spawn(ffmpegPath, dvrHlsArgs(sources[attempt++], duration, directory, { live }), { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch { ended = true; stop('spawn failed', fail('服务器无法启动 HLS 兼容预览。')); return; }
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
      child.once('error', () => { finishError = fail('服务器无法启动 HLS 兼容预览。'); });
      child.once('close', code => {
        ended = true; clearTimeout(killTimer);
        if (finished) { cleanup(); return; }
        if (!finishError && code === 0) inspect();
        if (finished) return;
        if (finishError || code !== 0 || !ready) {
          const error = finishError || fail(previewFailure(stderr));
          // Only a failed initial source may fall back. Never overlap recorder
          // sessions or splice a new source into an already published playlist.
          if (!ready && attempt < sources.length && request === ticket && clients.get(client)?.generation === generation && isCurrent()) {
            for (const name of fs.readdirSync(directory)) fs.rmSync(path.join(directory, name), { force: true });
            launch();
          } else stop('process failed', error);
        }
      });
    }
    function firstSegmentTimedOut() {
      if (!live || attempt >= sources.length) { stop('first segment timeout', fail('录像机未及时返回 HLS 画面，请重试。', 504)); return; }
      if (retryPending) return;
      retryPending = true; finishError = fail('录像机未及时返回 HLS 画面，请重试。', 504);
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { if (!ended) { try { child.kill('SIGKILL'); } catch {} } }, killGraceMs); killTimer.unref?.();
    }
    function inspect() {
      if (finished || retryPending) return;
      try {
        let bytes = 0;
        for (const name of fs.readdirSync(directory)) {
          let stat;
          try { stat = fs.lstatSync(path.join(directory, name)); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!stat.isFile() || stat.size > maxSegmentBytes) { stop('file limit', fail('HLS 预览超过片段大小限制。')); return; }
          bytes += stat.size;
        }
        if (bytes > maxBytes) { stop('total limit', fail('HLS 预览超过缓存大小限制。')); return; }
        const playlist = path.join(directory, 'index.m3u8');
        if (!ready && fs.existsSync(playlist)) {
          const text = (live ? liveHlsPlaylist : historicalHlsPlaylist)(fs.readFileSync(playlist, 'utf8')).toString(), files = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
          if (!text.startsWith('#EXTM3U') || files.some(name => !/^segment-\d{6}\.ts$/.test(name))) { stop('invalid playlist', fail('HLS 预览索引无效。')); return; }
          if (files.length && files.every(name => fs.existsSync(path.join(directory, name)) && fs.statSync(path.join(directory, name)).size > 0)) { ready = true; resolveReady(); }
        }
        if (!ready && now() - attemptStarted > firstSegmentTimeoutMs) firstSegmentTimedOut();
        else if (now() - touched > idleTimeoutMs) stop('viewer idle');
      } catch { stop('cache failed', fail('无法读取 HLS 预览缓存。')); }
    }
    launch();
    if (finished) return session;
    watch = setInterval(inspect, pollMs); watch.unref?.();
    wall = setTimeout(() => stop('duration limit'), (duration * 1000 + wallGraceMs)); wall.unref?.();
    return session;
  }
  function serve(req, res) {
    const { sessionId, filename } = req.params;
    if (!/^[a-f0-9-]{36}$/.test(sessionId || '') || !allowedFile(filename || '')) return res.status(404).end();
    const session = current;
    if (!session || session.id !== sessionId || session.finished) return res.status(410).end();
    const file = path.join(session.directory, filename);
    let stats, fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); stats = fs.fstatSync(fd); }
    catch { if (fd !== undefined) fs.closeSync(fd); return res.status(404).end(); }
    if (!stats.isFile() || stats.size < 1 || stats.size > maxSegmentBytes) { fs.closeSync(fd); return res.status(404).end(); }
    let playlist;
    if (filename === 'index.m3u8') {
      try { playlist = (session.live ? liveHlsPlaylist : historicalHlsPlaylist)(fs.readFileSync(fd, 'utf8')); }
      catch { fs.closeSync(fd); return res.status(502).end(); }
      fs.closeSync(fd); fd = undefined;
    }
    const size = playlist?.length ?? stats.size;
    session.touch();
    res.set({ 'Content-Type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
    // No stable validator is promised for this growing EVENT playlist.
    const range = parseByteRange(req.get('if-range') ? null : req.get('range'), size);
    if (!range) { if (fd !== undefined) fs.closeSync(fd); return res.status(416).set('Content-Range', `bytes */${size}`).end(); }
    res.status(range.status).set('Content-Length', String(range.end - range.start + 1));
    if (range.status === 206) res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    if (req.method === 'HEAD') { if (fd !== undefined) fs.closeSync(fd); return res.end(); }
    if (playlist) return res.end(playlist.subarray(range.start, range.end + 1));
    const stream = fs.createReadStream(file, { fd, start: range.start, end: range.end });
    const close = () => stream.destroy(); res.once('close', close);
    stream.once('close', () => res.removeListener('close', close)); stream.once('error', () => res.destroy()); stream.pipe(res);
  }
  return { accept, begin, serve, get current() { return current; },
    async stopClient(client, generation) { generation = accept(client, generation); if (current?.client === client && current.generation <= generation) await current.stop('client stopped'); },
    killNow() { ticket++; return current?.killNow(); },
    async close() { ticket++; if (current) await current.stop('server stopping'); },
  };
}
