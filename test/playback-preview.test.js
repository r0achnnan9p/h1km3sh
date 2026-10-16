import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createPlaybackPreviewCache, previewIdentity, parseByteRange, servePreviewFile, validatePreviewMp4 } from '../lib/playback-preview.js';
import { createMediaMtxPlayback } from '../lib/mediamtx-playback.js';
import { runMedia } from '../lib/media-archive.js';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';
const box = (type, body = '') => { const b = Buffer.from(body), h = Buffer.alloc(8); h.writeUInt32BE(b.length + 8); h.write(type, 4); return Buffer.concat([h, b]); };
const mp4 = Buffer.concat([box('ftyp', 'isom'), box('moov'), box('mdat', '0123456789')]);
const identity = { sourceIdentity: 'a'.repeat(64), camera: 'D1', start: '2026-09-30T12:00:00Z', duration: 30 };
const key = extra => previewIdentity({ ...identity, ...extra });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playback-preview-'));
  const cache = createPlaybackPreviewCache({ root, ...options });
  t.after(() => { cache.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, cache };
}
const response = () => new Response(mp4, { headers: { 'content-length': String(mp4.length) } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('preview identity bounds duration and isolates source/camera/date/start', () => {
  for (const extra of [{ sourceIdentity: 'b'.repeat(64) }, { camera: 'D2' }, { start: '2026-10-01T12:00:00Z' }, { duration: 2 }]) assert.notEqual(key(extra), key());
  assert.equal(key({ start: '2026-09-30T20:00:00+08:00' }), key());
  for (const duration of [0, -1, 31, 21600, 'bad']) assert.throws(() => key({ duration }));
});
test('byte ranges cover Safari probes, suffix/open-ended, bounds and hostile ranges', () => {
  for (const [range, start, end, status] of [[null, 0, 9, 200], ['bytes=0-1', 0, 1, 206], ['bytes=3-', 3, 9, 206], ['bytes=-2', 8, 9, 206], ['bytes=8-99', 8, 9, 206]]) assert.deepEqual(parseByteRange(range, 10), { start, end, status });
  for (const range of ['bytes=-0', 'bytes=10-', 'bytes=2-1', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=999999999999999999999-']) assert.equal(parseByteRange(range, 10), null, range);
});
test('coalesces preparations and retains completed file after Safari probe disconnect', async t => {
  const { cache, root } = fixture(t); let calls = 0, finish;
  const get = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const a = cache.acquire(key(), get), b = cache.acquire(key(), get);
  finish(response()); const [one, two] = await Promise.all([a, b]);
  assert.equal(calls, 1); assert.equal(one.file, two.file); one.release(); two.release();
  const next = await cache.acquire(key(), () => assert.fail('must reuse completed probe file'));
  assert.deepEqual(fs.readFileSync(next.file), mp4); next.release(); assert.equal(fs.readdirSync(root).length, 1);
});
test('one cancelled waiter leaves another alive; last cancellation aborts upstream and cleans partials', async t => {
  const { cache, root } = fixture(t); let finish, upstreamSignal;
  const get = signal => { upstreamSignal = signal; return new Promise(resolve => { finish = resolve; }); };
  const ac = new AbortController(), bc = new AbortController();
  const a = cache.acquire(key(), get, { signal: ac.signal }), b = cache.acquire(key(), get, { signal: bc.signal });
  ac.abort(); await assert.rejects(a, { name: 'AbortError' }); assert.equal(upstreamSignal.aborted, false);
  finish(response()); const lease = await b; lease.release();
  const cc = new AbortController();
  const c = cache.acquire(key({ camera: 'D2' }), signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { signal: cc.signal });
  cc.abort(); await assert.rejects(c, { name: 'AbortError' }); await tick();
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.part')).length, 0);
});
test('rejects empty, truncated, fragmented, failed and over-budget upstream responses without caching', async t => {
  const { cache, root } = fixture(t, { maxFileBytes: mp4.length, maxBytes: mp4.length * 3 });
  for (const body of ['', mp4.subarray(0, -1), Buffer.concat([box('ftyp'), box('moof'), box('mdat', 'data')]), Buffer.alloc(mp4.length + 1)]) {
    await assert.rejects(cache.acquire(key(), async () => new Response(body)));
    assert.deepEqual(fs.readdirSync(root), []);
  }
  await assert.rejects(cache.acquire(key(), async () => new Response('no', { status: 503 })));
  await assert.rejects(cache.acquire(key(), async () => new Response(mp4, { headers: { 'content-length': '1' } })));
  assert.deepEqual(fs.readdirSync(root), []);
});
test('concurrency, TTL, disk limit and active-file protection remain bounded', async t => {
  let time = Date.now(); const { cache, root } = fixture(t, { now: () => time, ttlMs: 1000, maxConcurrent: 1, maxFileBytes: mp4.length, maxBytes: mp4.length * 2 });
  let finish; const pending = cache.acquire(key(), () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(cache.acquire(key({ camera: 'D2' }), response), error => error.status === 503);
  finish(response()); const first = await pending;
  time += 2000; cache.sweep(); assert.ok(fs.existsSync(first.file));
  first.release(); cache.sweep(); assert.deepEqual(fs.readdirSync(root), []);
  for (const camera of ['D1', 'D2', 'D3', 'D4']) { const lease = await cache.acquire(key({ camera }), response); lease.release(); }
  assert.ok(fs.readdirSync(root).length <= 2);
});
test('timeout stays active while the upstream body stalls', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.write(mp4.subarray(0, 12)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { cache, root } = fixture(t, { timeoutMs: 50 });
  const playback = createMediaMtxPlayback({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(cache.acquire(key(), signal => playback.get('D1', identity.start, 30, { format: 'mp4', signal })));
  assert.deepEqual(fs.readdirSync(root), []);
});
test('real H264/AAC faststart bytes are preserved, decoded and served as 200/206/416/HEAD', async t => {
  const { cache, root } = fixture(t); const original = path.join(root, 'synthetic.mp4');
  await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10', '-f', 'lavfi', '-i', 'sine=sample_rate=16000', '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-movflags', '+faststart', original]);
  const bytes = fs.readFileSync(original); validatePreviewMp4(original);
  const app = express(); let calls = 0;
  app.get('/stream', async (req, res) => { const lease = await cache.acquire(key(), async () => { calls++; return new Response(bytes); }); servePreviewFile(req, res, lease); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/stream`;
  const probe = await fetch(url, { headers: { Range: 'bytes=0-1' } }); assert.equal(probe.status, 206); assert.equal(probe.headers.get('content-length'), '2'); assert.equal(probe.headers.get('content-range'), `bytes 0-1/${bytes.length}`); assert.deepEqual(Buffer.from(await probe.arrayBuffer()), bytes.subarray(0, 2));
  const full = await fetch(url); assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  assert.equal((await fetch(url, { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), String(bytes.length));
  assert.equal((await fetch(url, { headers: { Range: 'bytes=0-1', 'If-Range': '"different"' } })).status, 200);
  assert.equal(calls, 1);
  const { stdout } = await runMedia(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate', '-of', 'json', path.join(root, `${key()}.mp4`)]);
  assert.deepEqual(JSON.parse(stdout).streams.map(s => s.codec_name), ['h264', 'aac']);
  await runMedia(ffmpegPath, ['-v', 'error', '-i', path.join(root, `${key()}.mp4`), '-f', 'null', '-']);
});
