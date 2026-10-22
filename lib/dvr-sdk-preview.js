/** One private completed MP4 preview. SDK teardown must settle before replacement. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dvrExportFailure, isDvrExportError } from './dvr-export-errors.js';
import { compactToMs, msToCompact } from './hik-time.js';
import { servePreviewFile, validatePreviewMp4 } from './playback-preview.js';

export const DVR_SDK_PREVIEW_MAX_SECONDS = 30;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const cancelled = () => Object.assign(fail('回放请求已取消。', 409), { name: 'AbortError' });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function createDvrSdkPreview({ root, download, idleTimeoutMs = 5 * 60_000,
  maxFileBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof download !== 'function') throw new TypeError('download is required');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  // This directory is exclusively owned by this manager, never a downloads mount.
  for (const name of fs.readdirSync(root)) if (uuid.test(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  let current = null, closed = false;
  const clients = new Map();
  function validate(client, generation) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(client || '') || !Number.isSafeInteger(Number(generation))
      || Number(generation) < 1 || Number(generation) > 1e12) throw fail('预览请求标识无效。', 400);
    return Number(generation);
  }
  function begin({ device, channel, startTime, endTime, client, generation, isCurrent = () => true,
    onFinish = () => {}, beforeDownload = () => {}, curlDigest, onProgress }) {
    generation = validate(client, generation);
    if (closed) throw cancelled();
    for (const value of [startTime, endTime]) {
      if (!/^\d{8}T\d{6}Z$/.test(value || '') || !Number.isFinite(compactToMs(value))
        || msToCompact(compactToMs(value)) !== value) throw fail('回放时间无效。', 400);
    }
    const duration = (compactToMs(endTime) - compactToMs(startTime)) / 1000;
    if (duration <= 0 || duration > DVR_SDK_PREVIEW_MAX_SECONDS) throw fail('SDK 预览每组时长须在 30 秒以内。', 400);
    if (!/^\d{1,8}$/.test(String(channel)) || Number(channel) < 1) throw fail('回放通道无效。', 400);
    const previous = clients.get(client);
    if (previous && (generation < previous.generation || (generation === previous.generation && previous.cancelled))) throw cancelled();
    // Fingerprint only non-secret request fields. A generation names one exact
    // request; credentials are never cached or incorporated into its identity.
    const fingerprint = createHash('sha256').update(JSON.stringify([device?.id ?? null, String(channel), startTime, endTime])).digest('hex');
    if (current?.client === client && current.generation === generation && !current.finished) {
      if (current.fingerprint !== fingerprint) throw fail('同一预览请求标识不能用于不同录像。', 409);
      return current;
    }
    // Keep generation tombstones for this manager's lifetime; evicting them lets
    // delayed requests resurrect canceled sessions. Reject new clients at capacity.
    if (!previous && clients.size >= 4096) throw fail('预览客户端数量已达上限。', 503);
    clients.set(client, { generation, cancelled: false });
    const predecessor = current?.stop('superseded') || Promise.resolve();
    const id = randomUUID(), directory = path.join(root, id), file = path.join(directory, 'media.mp4');
    const controller = new AbortController();
    let finished = false, ready = false, cleaned = false, timer, metadata, operation, waiterCount = 0;
    let resolveReady, rejectReady;
    const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    readyPromise.catch(() => {});
    function invalidate(error = cancelled()) {
      if (finished) return;
      finished = true; ready = false; clearTimeout(timer); controller.abort(); rejectReady(error);
      if (clients.get(client)?.generation === generation) clients.set(client, { generation, cancelled: true });
    }
    function cleanup() {
      if (cleaned) return;
      cleaned = true; clearTimeout(timer);
      fs.rmSync(directory, { recursive: true, force: true });
      if (current === session) current = null;
      try { onFinish(session); } catch { /* Completion observers cannot retain a session. */ }
    }
    function stop() {
      invalidate();
      return operation.then(cleanup);
    }
    function touch() {
      clearTimeout(timer);
      timer = setTimeout(() => { void stop().catch(() => {}); }, idleTimeoutMs);
      timer.unref?.();
    }
    const session = { id, client, generation, directory, fingerprint,
      get finished() { return finished; }, get ready() { return ready; }, stop, killNow: stop,
      async wait(signal) {
        waiterCount++;
        let abort;
        const cancellation = new Promise((_resolve, reject) => { abort = () => reject(cancelled()); signal?.addEventListener('abort', abort, { once: true }); });
        try {
          if (signal?.aborted) throw cancelled();
          const value = await Promise.race([readyPromise, cancellation]);
          if (signal?.aborted || finished) throw cancelled();
          return value;
        } finally {
          signal?.removeEventListener('abort', abort); waiterCount--;
          if (signal?.aborted && !ready && !waiterCount) void stop().catch(() => {});
        }
      }, touch,
    };
    // Reserve synchronously, before waiting for any prior SDK process to exit.
    current = session;
    operation = Promise.resolve().then(async () => {
      await predecessor;
      await beforeDownload();
      if (finished || current !== session || !isCurrent()) throw cancelled();
      fs.mkdirSync(directory, { mode: 0o700 });
      const result = await download({ device, channel, startTime, endTime, outputFile: file,
        signal: controller.signal, preview: true, curlDigest, onProgress });
      if (finished || controller.signal.aborted || current !== session || !isCurrent()) throw cancelled();
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size < 1 || stat.size > maxFileBytes) throw fail('SDK 预览文件无效或超过大小限制。');
      validatePreviewMp4(file); fs.chmodSync(file, 0o600);
      const actualDurationSeconds = Number(result?.actualDurationSeconds);
      if (!Number.isFinite(actualDurationSeconds) || actualDurationSeconds <= 0) throw fail('SDK 预览时长无效。');
      metadata = Object.freeze({ sessionId: id, mediaUrl: `/console/api/dvr-sdk-preview/${id}/media.mp4`,
        transport: 'hcnetsdk', timingAccuracy: 'unverified-keyframe', requestedStartTime: startTime,
        requestedEndTime: endTime, actualDurationSeconds });
      session.size = stat.size; ready = true; touch(); resolveReady(metadata);
    }).catch(error => {
      // Downloader diagnostics can contain credentials, native paths or device text.
      if (error?.name === 'AbortError') invalidate(cancelled());
      else if (isDvrExportError(error)) {
        const failure = dvrExportFailure(error);
        invalidate(Object.assign(fail(failure.message), { code: failure.failureCode }));
      } else invalidate(fail('SDK 预览准备失败，请检查 SDK 配置及录像后重试。'));
    }).finally(() => { if (finished) cleanup(); });
    return session;
  }
  async function stopClient(client, generation) {
    generation = validate(client, generation);
    const previous = clients.get(client);
    if (previous && previous.generation > generation) return;
    if (!previous && clients.size >= 4096) throw fail('预览客户端数量已达上限。', 503);
    clients.set(client, { generation, cancelled: true });
    if (current?.client === client && current.generation <= generation) await current.stop('client stopped');
  }
  function serve(req, res) {
    const { sessionId, filename } = req.params;
    if (!uuid.test(sessionId || '') || (filename !== undefined && filename !== 'media.mp4')) return res.status(404).end();
    const session = current;
    if (!session || session.id !== sessionId || session.finished) return res.status(410).end();
    if (!session.ready) return res.status(425).end();
    session.touch();
    return servePreviewFile(req, res, { file: path.join(session.directory, 'media.mp4'), size: session.size, release() {} });
  }
  return { begin, stopClient, serve, get current() { return current; },
    async close() { closed = true; if (current) await current.stop('server stopping'); },
    killNow() { closed = true; return current?.stop('server exiting'); },
  };
}
