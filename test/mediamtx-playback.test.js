import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaMtxPlayback } from '../lib/mediamtx-playback.js';

test('MediaMTX 日期查询只返回当前日有效录像段，不暴露上游 URL', async () => {
  const seen = [];
  const playback = createMediaMtxPlayback({ baseUrl: 'http://mediamtx.local:9996', fetchImpl: async url => {
    seen.push(new URL(url));
    return new Response(JSON.stringify([
      { start: '2026-09-26T15:50:00Z', duration: 3600, url: 'http://internal/get?secret=x' },
      { start: '2026-09-27T16:00:00Z', duration: 60 },
      { start: 'not-a-date', duration: 20 },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const segments = await playback.list('D2', '2026-09-27');
  assert.deepEqual(segments, [{ start: '2026-09-26T16:00:00.000Z', duration: 3000 }]);
  assert.equal(seen[0].pathname, '/list'); assert.equal(seen[0].searchParams.get('path'), 'D2');
  assert.equal(seen[0].searchParams.get('start'), '2026-09-27T00:00:00+08:00');
  assert.equal(JSON.stringify(segments).includes('internal'), false);
  await assert.rejects(playback.list('D2', '2026-02-30'));
});

test('MediaMTX 播放代理支持 fMP4 和标准 MP4，摄像头、时长与格式必须有效', async () => {
  const actual = [];
  const playback = createMediaMtxPlayback({ baseUrl: 'http://mediamtx.local:9996', fetchImpl: async url => { actual.push(new URL(url)); return new Response('video'); } });
  const response = await playback.get('D1', '2026-09-27T12:00:00.000Z', 60);
  assert.equal(await response.text(), 'video'); assert.equal(actual[0].pathname, '/get');
  assert.equal(actual[0].searchParams.get('path'), 'D1'); assert.equal(actual[0].searchParams.get('format'), 'fmp4');
  await playback.get('D1', '2026-09-27T12:00:00.000Z', 60, { format: 'mp4' });
  assert.equal(actual[1].searchParams.get('format'), 'mp4');
  await assert.rejects(playback.get('../secret', '2026-09-27T12:00:00Z', 60));
  await assert.rejects(playback.get('D1', 'bad', 60)); await assert.rejects(playback.get('D1', '2026-09-27T12:00:00Z', 99999));
  await assert.rejects(playback.get('D1', '2026-09-27T12:00:00Z', 60, { format: 'hls' }));
  assert.throws(() => createMediaMtxPlayback({ baseUrl: 'http://user:pass@evil.local:9996' }));
});


test('MediaMTX list bounds response bodies and keeps timeout through body read', async () => {
  const playback = createMediaMtxPlayback({ maxBodyBytes: 32, fetchImpl: async () => new Response('[' + ' '.repeat(64) + ']') });
  await assert.rejects(playback.list('D1', '2026-09-27'), /响应过大/);
  const http = await import('node:http');
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const slow = createMediaMtxPlayback({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 100 });
    await assert.rejects(slow.list('D1', '2026-09-27'));
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});


test('MediaMTX range preflight handles cross-day wall time, long overlaps and strips private fields', async () => {
  const requests = [];
  const playback = createMediaMtxPlayback({ baseUrl: 'http://mediamtx.example:9996', fetchImpl: async url => {
    requests.push(new URL(url));
    return Response.json([
      { start: '2025-12-30T16:00:00Z', duration: 172770, file: '/private/recording.mp4', secret: 'not-for-clients' },
      { start: '2026-01-01T16:00:15Z', duration: 60 },
      { start: '2026-01-01T16:03:00Z', duration: 20 },
      { start: 'invalid', duration: 20 },
      { start: '2026-01-01T16:00:00Z', duration: -10 },
    ]);
  } });
  const result = await playback.listRange('archive-a', '2026-01-01 23:59:00', '2026-01-02 00:01:00');
  assert.equal(requests[0].searchParams.get('path'), 'archive-a');
  assert.equal(requests[0].searchParams.get('start'), '2026-01-01T15:59:00.000Z');
  assert.equal(requests[0].searchParams.get('end'), '2026-01-01T16:01:00.000Z');
  assert.deepEqual(result, [
    { startMs: Date.UTC(2026, 0, 1, 23, 59), endMs: Date.UTC(2026, 0, 1, 23, 59, 30) },
    { startMs: Date.UTC(2026, 0, 2, 0, 0, 15), endMs: Date.UTC(2026, 0, 2, 0, 1) },
  ]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  await assert.rejects(playback.listRange('archive-a', '2026-01-01T00:00:00Z', '2026-01-02 00:00:00'));
});

test('range preflight treats missing footage as empty and reports bounded catalog failures safely', async () => {
  const args = ['archive-a', '2026-01-01 10:00:00', '2026-01-01 10:01:00'];
  assert.deepEqual(await createMediaMtxPlayback({ fetchImpl: async () => new Response(null, { status: 404 }) }).listRange(...args), []);
  for (const fetchImpl of [
    async () => new Response('private upstream detail', { status: 500 }),
    async () => new Response('{broken-json'),
    async () => new Response('[' + ' '.repeat(100) + ']'),
    async () => { throw new Error('http://private.example/credential'); },
  ]) {
    await assert.rejects(createMediaMtxPlayback({ fetchImpl, maxBodyBytes: 64 }).listRange(...args), error => {
      assert.equal(error.status, 502); assert.match(error.message, /无法核验 MediaMTX 录像目录/);
      assert.equal(error.message.includes('private'), false); return true;
    });
  }
});

test('range preflight propagates caller cancellation and stops slow directory bodies at its deadline', async () => {
  const http = await import('node:http');
  const sockets = new Set();
  let received;
  const requestStarted = new Promise(resolve => { received = resolve; });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); received();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const args = ['archive-a', '2026-01-01 10:00:00', '2026-01-01 10:01:00'];
    const controller = new AbortController();
    const pending = createMediaMtxPlayback({ baseUrl }).listRange(...args, { signal: controller.signal });
    await requestStarted; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(createMediaMtxPlayback({ baseUrl, timeoutMs: 100 }).listRange(...args), error => error.status === 504 && /超时/.test(error.message));
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});
