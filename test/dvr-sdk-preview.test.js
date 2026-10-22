import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { dvrExportFailure } from '../lib/dvr-export-errors.js';
import { createDvrSdkPreview } from '../lib/dvr-sdk-preview.js';

const request = { device: { ip: 'fixture.invalid', user: 'secret-user', pass: 'secret-pass' }, channel: 1,
  startTime: '20261001T120000Z', endTime: '20261001T120030Z', client: 'client-fixture', generation: 1 };
const box = (type, payload = '') => { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(type, 4); b.write(payload, 8); return b; };
const mp4 = Buffer.concat([box('ftyp'), box('moov'), box('mdat', 'fixture-media-bytes')]);
const tick = () => delay(0);
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-preview-'));
  const calls = [];
  const manager = createDvrSdkPreview({ root, download: args => new Promise((resolve, reject) => {
    const call = { ...args, finish(bytes = mp4) { fs.writeFileSync(args.outputFile, bytes); resolve({ actualDurationSeconds: 29.8, secret: 'not public' }); }, reject };
    calls.push(call);
  }), ...options });
  t.after(async () => { for (const c of calls) c.reject(new Error('cleanup')); await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, root, calls };
}

test('begin reserves immediately; ready only follows completed MP4 and metadata contains no credentials', async t => {
  const { manager, calls, root } = fixture(t);
  const session = manager.begin(request);
  assert.equal(manager.current, session); assert.equal(typeof session.then, 'undefined');
  assert.equal(session.ready, false); assert.equal(session.finished, false);
  assert.equal(manager.begin(request), session);
  await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].preview, true);
  calls[0].finish(); const metadata = await session.wait();
  assert.equal(session.ready, true); assert.equal(session.finished, false);
  assert.equal(metadata.actualDurationSeconds, 29.8); assert.equal(metadata.timingAccuracy, 'unverified-keyframe');
  assert.equal(metadata.mediaUrl, `/console/api/dvr-sdk-preview/${session.id}/media.mp4`);
  assert.doesNotMatch(JSON.stringify(metadata), /secret|fixture.invalid|sdk-preview-/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  await session.stop(); assert.equal(manager.current, null); assert.deepEqual(fs.readdirSync(root), []);
});

test('supersession aborts immediately but waits for downloader settlement before any new SDK call', async t => {
  const { manager, calls, root } = fixture(t);
  const first = manager.begin(request); await tick();
  const second = manager.begin({ ...request, generation: 2 });
  const third = manager.begin({ ...request, generation: 3 });
  assert.equal(manager.current, third); assert.equal(calls[0].signal.aborted, true);
  let stopped = false; const stopping = first.stop().then(() => { stopped = true; });
  await tick(); assert.equal(calls.length, 1); assert.equal(stopped, false);
  assert.equal(fs.existsSync(first.directory), true);
  calls[0].finish(); await stopping; await tick();
  assert.equal(calls.length, 2); assert.equal(fs.existsSync(first.directory), false);
  await assert.rejects(second.wait(), { name: 'AbortError' });
  calls[1].finish(); await third.wait();
  await manager.stopClient(request.client, 2); assert.equal(manager.current, third);
  await assert.rejects(first.wait(), { name: 'AbortError' });
  assert.deepEqual(fs.readdirSync(root), [third.id]);
});

test('new canceled generation tombstones stale begin and cannot stop another client', async t => {
  const { manager, calls } = fixture(t);
  const first = manager.begin(request); await tick();
  const second = manager.begin({ ...request, generation: 2 });
  const stopping = manager.stopClient(request.client, 3);
  assert.throws(() => manager.begin({ ...request, generation: 2 }), { name: 'AbortError' });
  assert.throws(() => manager.begin({ ...request, generation: 3 }), { name: 'AbortError' });
  calls[0].finish(); await stopping; assert.equal(calls.length, 1);
  await assert.rejects(first.wait(), { name: 'AbortError' }); await assert.rejects(second.wait(), { name: 'AbortError' });
  const other = manager.begin({ ...request, client: 'other-client' });
  await manager.stopClient(request.client, 4); assert.equal(manager.current, other);
  await tick(); calls[1].finish(); await other.wait();
});

test('canceling all waiters while preparing aborts but retains files until process closes', async t => {
  const { manager, root, calls } = fixture(t); const a = new AbortController(), b = new AbortController();
  const session = manager.begin(request); await tick();
  const aw = session.wait(a.signal), bw = session.wait(b.signal);
  a.abort(); await assert.rejects(aw, { name: 'AbortError' }); assert.equal(calls[0].signal.aborted, false);
  b.abort(); await assert.rejects(bw, { name: 'AbortError' }); assert.equal(calls[0].signal.aborted, true);
  assert.equal(fs.existsSync(session.directory), true);
  calls[0].finish(); await session.stop(); assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => manager.begin(request), { name: 'AbortError' });
});

test('download failures and invalid MP4 clean up with a fixed safe error', async t => {
  const { manager, root, calls } = fixture(t);
  const failed = manager.begin(request); await tick();
  calls[0].reject(new Error('secret-pass device diagnostic'));
  await assert.rejects(failed.wait(), error => error.status === 502 && !/secret|diagnostic/.test(error.message));
  await failed.stop(); assert.deepEqual(fs.readdirSync(root), []);
  const invalid = manager.begin({ ...request, generation: 2 }); await tick();
  calls[1].finish(Buffer.from('not a valid mp4'));
  await assert.rejects(invalid.wait(), error => error.status === 502);
  await invalid.stop(); assert.deepEqual(fs.readdirSync(root), []);
});

test('generation guard prevents preparation and post-download resurrection', async t => {
  const { manager, calls } = fixture(t);
  let valid = false;
  const first = manager.begin({ ...request, isCurrent: () => valid });
  await assert.rejects(first.wait(), { name: 'AbortError' }); assert.equal(calls.length, 0);
  valid = true; const second = manager.begin({ ...request, generation: 2, isCurrent: () => valid });
  await tick(); valid = false; calls[0].finish(); await assert.rejects(second.wait(), { name: 'AbortError' });
  await second.stop(); assert.equal(manager.current, null);
});

test('range and HEAD serve only the current completed MP4 with private no-store', async t => {
  const { manager, calls } = fixture(t); const app = express();
  app.get('/console/api/dvr-sdk-preview/:sessionId/:filename', (req, res) => manager.serve(req, res));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = manager.begin(request), url = `${base}/console/api/dvr-sdk-preview/${session.id}/media.mp4`;
  assert.equal((await fetch(url)).status, 425);
  await tick(); calls[0].finish(); await session.wait();
  const ranged = await fetch(url, { headers: { Range: 'bytes=8-15' } });
  assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), mp4.subarray(8, 16));
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(mp4.length));
  assert.equal((await fetch(url.replace('media.mp4', 'secret.raw'))).status, 404);
  await session.stop(); assert.equal((await fetch(url)).status, 410);
});

test('ready preview expires when idle and duration/input bounds reject before download', async t => {
  const { manager, calls, root } = fixture(t, { idleTimeoutMs: 25 });
  assert.throws(() => manager.begin({ ...request, endTime: '20261001T120031Z' }), error => error.status === 400);
  assert.throws(() => manager.begin({ ...request, client: '../unsafe' }), error => error.status === 400);
  assert.throws(() => manager.begin({ ...request, startTime: '20260230T120000Z' }), error => error.status === 400);
  const session = manager.begin(request); await tick(); calls[0].finish(); await session.wait();
  await delay(50); assert.equal(session.finished, true); assert.deepEqual(fs.readdirSync(root), []);
});


test('beforeDownload cancellation keeps the global gate until external preview teardown settles', async t => {
  const { manager, calls, root } = fixture(t);
  let release, entered = false;
  const teardown = new Promise(resolve => { release = resolve; });
  const first = manager.begin({ ...request, beforeDownload: async () => { entered = true; await teardown; } });
  await tick(); assert.equal(entered, true); assert.equal(calls.length, 0);
  let stopped = false; const stopping = manager.stopClient(request.client, 1).then(() => { stopped = true; });
  const second = manager.begin({ ...request, generation: 2 });
  await tick(); assert.equal(calls.length, 0); assert.equal(stopped, false);
  release(); await stopping; await tick(); assert.equal(calls.length, 1);
  await assert.rejects(first.wait(), { name: 'AbortError' });
  calls[0].finish(); await second.wait();
  assert.deepEqual(fs.readdirSync(root), [second.id]);
});


test('same generation cannot coalesce different non-secret request identities or disturb current work', async t => {
  const { manager, calls } = fixture(t);
  const first = manager.begin(request); await tick();
  for (const changed of [{ device: { ...request.device, id: 'other-device' } }, { channel: 2 },
    { startTime: '20261001T120001Z' }, { endTime: '20261001T120029Z' }]) {
    assert.throws(() => manager.begin({ ...request, ...changed }), error => error.status === 409);
    assert.equal(manager.current, first); assert.equal(calls[0].signal.aborted, false);
  }
  assert.equal(manager.begin(request), first);
  assert.equal(manager.begin({ ...request, device: { ...request.device, pass: 'changed-secret' } }), first);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  calls[0].finish(); await first.wait();
});


test('preview exposes only the closed public failure message and code, never downloader fields', async t => {
  const { manager, root, calls } = fixture(t);
  const codes = ['DVR_SDK_DOWNLOAD_TIMEOUT', 'DVR_SDK_MULTIPART', 'DVR_SDK_BYTE_LIMIT', 'DVR_SDK_PROCESS_TIMEOUT', 'DVR_SDK_INVALID_REQUEST'];
  for (const [index, code] of [...codes, 'UNKNOWN_NATIVE_CODE', '__proto__'].entries()) {
    const session = manager.begin({ ...request, generation: index + 1 });
    await tick();
    calls[index].reject(Object.assign(new Error('secret-pass /private/native/path'), {
      code, status: 401, stage: '/private/native/path', stderr: 'secret-pass',
      failureDiagnostics: { method: 'PLAY', rtspStatus: 453 },
    }));
    await assert.rejects(session.wait(), error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, codes.includes(code) ? code : undefined);
      assert.equal(error.message, codes.includes(code) ? dvrExportFailure({ code }).message : 'SDK 预览准备失败，请检查 SDK 配置及录像后重试。');
      assert.doesNotMatch(JSON.stringify(error) + error.message, /secret-pass|private\/native|stderr|rtspStatus/);
      assert.equal(error.stage, undefined);
      return true;
    });
    await session.stop();
    assert.equal(manager.current, null);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});
