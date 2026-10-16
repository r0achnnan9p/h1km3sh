import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { ffmpegPath } from '../lib/ffmpeg-paths.js';
import { outputId, listOutputLibrary } from '../lib/output-library.js';
import { createOutputThumbnails, extractOutputThumbnail, mountOutputThumbnails } from '../lib/output-thumbnails.js';
import { createPublicGateway, createStatusPasswordHash } from '../lib/mcp-security.js';
const jpeg = Buffer.from([255, 216, 255, 217]);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-still-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const add = name => { fs.writeFileSync(path.join(root, name), 'fake mp4'); return outputId(name); };
  return { root, add };
}
test('real synthetic MP4 produces a bounded JPEG; invalid video is negative-cached', async t => {
  const { root, add } = fixture(t);
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-t', '1', '-threads', '1', '-c:v', 'mpeg4', path.join(root, 'synthetic.mp4')]);
  let calls = 0; const cache = createOutputThumbnails({ root, generate: file => { calls++; return extractOutputThumbnail(file); } });
  const image = await cache.get(outputId('synthetic.mp4'));
  assert.equal(image.subarray(0, 2).toString('hex'), 'ffd8'); assert.ok(image.length < 512 * 1024);
  assert.equal(await cache.get(outputId('synthetic.mp4')), image); assert.equal(calls, 1);
  const invalid = add('invalid.mp4');
  await assert.rejects(cache.get(invalid), { status: 422 }); await assert.rejects(cache.get(invalid), { status: 422 }); assert.equal(calls, 2);
});
test('replacement, rename, delete and busy/readiness states cannot return stale cached images', async t => {
  const { root, add } = fixture(t); const id = add('one.mp4'); let count = 0, ready = true, busy = false;
  const cache = createOutputThumbnails({ root, isReady: () => ready, isBusy: () => busy, generate: async () => { count++; return jpeg; } });
  const firstUrl = listOutputLibrary(root)[0].thumbnailUrl;
  await cache.get(id); fs.writeFileSync(path.join(root, 'one.mp4'), 'different content'); await cache.get(id);
  assert.equal(count, 2); assert.notEqual(listOutputLibrary(root)[0].thumbnailUrl, firstUrl);
  busy = true; await assert.rejects(cache.get(id), { status: 409 }); busy = false;
  ready = false; await assert.rejects(cache.get(id), { status: 503 }); ready = true;
  fs.renameSync(path.join(root, 'one.mp4'), path.join(root, 'two.mp4')); await assert.rejects(cache.get(id), { status: 404 });
  await cache.get(outputId('two.mp4')); assert.equal(count, 3);
  fs.unlinkSync(path.join(root, 'two.mp4')); await assert.rejects(cache.get(outputId('two.mp4')), { status: 404 });
});
test('rejects traversal, URLs, symlinks, nested paths and incomplete outputs', async t => {
  const { root, add } = fixture(t); add('one.mp4');
  fs.symlinkSync(path.join(root, 'one.mp4'), path.join(root, 'link.mp4'));
  let calls = 0; const cache = createOutputThumbnails({ root, generate: async () => { calls++; return jpeg; } });
  for (const input of ['../one.mp4', '/tmp/one.mp4', 'https://example.com/a.mp4', 'a/b/c.mp4', 'link.mp4', 'one.hikraw']) await assert.rejects(cache.get(outputId(input)), { status: 404 });
  await assert.rejects(cache.get('../anything'), { status: 404 }); assert.equal(calls, 0);
  assert.equal(listOutputLibrary(root, { inProgress: new Set(['one.mp4']) })[0].thumbnailUrl, null);
});
test('single-flight deduplicates requests and global queue bounds concurrency and pending work', async t => {
  const { root, add } = fixture(t); let running = 0, peak = 0, calls = 0; const release = [];
  const cache = createOutputThumbnails({ root, concurrency: 1, maxPending: 2, generate: async () => {
    calls++; running++; peak = Math.max(peak, running); await new Promise(resolve => release.push(resolve)); running--; return jpeg;
  } });
  const id = add('one.mp4'), second = add('two.mp4'), third = add('three.mp4');
  const a = cache.get(id), b = cache.get(id), c = cache.get(second);
  await assert.rejects(cache.get(third), { status: 503 }); await new Promise(setImmediate);
  assert.equal(calls, 1); release.shift()(); await Promise.all([a, b]); await new Promise(setImmediate);
  assert.equal(calls, 2); release.shift()(); await c; assert.equal(peak, 1);
});
test('change during extraction is rejected and does not populate cache', async t => {
  const { root, add } = fixture(t); const id = add('one.mp4');
  const cache = createOutputThumbnails({ root, generate: async () => { fs.unlinkSync(path.join(root, 'one.mp4')); return jpeg; } });
  await assert.rejects(cache.get(id), { status: 404 });
});
test('LRU storage is bounded and invalidated on mutation', async t => {
  const { root, add } = fixture(t); let calls = 0;
  const cache = createOutputThumbnails({ root, maxEntries: 1, generate: async () => { calls++; return jpeg; } });
  const a = add('one.mp4'), b = add('two.mp4'); await cache.get(a); await cache.get(b); await cache.get(a); assert.equal(calls, 3);
});
test('public gateway requires console session for thumbnails including cached responses', async t => {
  const { root, add } = fixture(t); const id = add('one.mp4'); const app = express(); let calls = 0;
  mountOutputThumbnails(app, { root, generate: async () => { calls++; return jpeg; } });
  const origin = 'https://thumbnails.example', password = 'test-only-thumbnail-password';
  const server = createPublicGateway(app, { token: 'test-only-thumbnail-token-123456789', baseUrl: origin,
    statusPasswordHash: createStatusPasswordHash(password), getStatus: () => ({ tasks: [] }) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, url = `${base}/console/api/outputs/${id}/thumbnail`;
  assert.equal((await fetch(url)).status, 401); assert.equal(calls, 0);
  const login = await fetch(`${base}/status/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 2; i++) { const response = await fetch(url, { headers: { cookie } }); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/jpeg/); assert.match(response.headers.get('cache-control'), /no-store/); }
  assert.equal(calls, 1); assert.equal((await fetch(url)).status, 401);
});

test('decoder time and output bounds kill the subprocess; spawn errors stay controlled', async t => {
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  const { resolveLibraryOutput } = await import('../lib/output-library.js');
  const { root, add } = fixture(t); const file = resolveLibraryOutput(root, add('one.mp4'));
  let kills = 0;
  const process = mode => {
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { kills++; setImmediate(() => child.emit('close', null)); };
    if (mode === 'overflow') setImmediate(() => child.stdout.end(Buffer.alloc(20)));
    if (mode === 'error') setImmediate(() => { child.emit('error', new Error('missing ffmpeg')); child.emit('close', -1); });
    return child;
  };
  await assert.rejects(extractOutputThumbnail(file, { timeoutMs: 10, spawnProcess: () => process('hang') }), { status: 504 });
  await assert.rejects(extractOutputThumbnail(file, { maxBytes: 10, spawnProcess: () => process('overflow') }), { status: 422 });
  await assert.rejects(extractOutputThumbnail(file, { spawnProcess: () => process('error') }), { status: 503 });
  assert.equal(kills, 2);
});
