/** Real prefix-mounted gateway + SDK preview file server; download alone is synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createPublicGateway, createStatusPasswordHash } from '../lib/mcp-security.js';
import { createDvrSdkPreview } from '../lib/dvr-sdk-preview.js';

const token = 'test-only-sdk-gateway-token-abcdefghijklmnopqrstuvwxyz';
const origin = 'https://hik.example.com';
const box = (type, text = '') => { const b = Buffer.alloc(8 + text.length); b.writeUInt32BE(b.length); b.write(type, 4); b.write(text, 8); return b; };
const bytes = Buffer.concat([box('ftyp'), box('moov'), box('mdat', 'synthetic-private-recording')]);

for (const prefix of ['', '/h1km3sh']) test(`SDK private media and stop retain authentication and range semantics under ${prefix || 'root'} gateway`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-public-gateway-'));
  const manager = createDvrSdkPreview({ root, download: async ({ outputFile }) => {
    fs.writeFileSync(outputFile, bytes); return { actualDurationSeconds: 10 };
  } });
  const session = manager.begin({ device: { id: '11111111-1111-4111-8111-111111111111' }, channel: '201',
    startTime: '20261001T210000Z', endTime: '20261001T210010Z', client: 'gateway-client', generation: 1 });
  const metadata = await session.wait();
  const media = metadata.mediaUrl, stop = '/console/api/dvr-sdk-preview/stop';
  let stopCalls = 0;
  const app = express(); app.use(express.json());
  app.get('/console/api/dvr-sdk-preview/:sessionId/media.mp4', manager.serve);
  app.post(stop, async (req, res) => {
    stopCalls++; await manager.stopClient(req.body.client, req.body.generation); res.status(204).end();
  });
  // These handlers intentionally exist: gateway denial must happen before them.
  app.all('/console/api/dvr-sdk-preview/:sessionId/recording.ps', (_req, res) => res.send('must-stay-private'));
  app.get('/api/devices', (_req, res) => res.json({ password: 'must-stay-private' }));
  const publicApp = express();
  publicApp.use(prefix || '/', createPublicGateway(app, { token, baseUrl: origin + prefix,
    statusPasswordHash: createStatusPasswordHash('sdk-gateway-password') }));
  const server = publicApp.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  const request = (pathname, method = 'GET', headers = {}, body) => fetch(base + pathname, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await request(media, method)).status, 401);
    assert.equal((await request(media, method, { Authorization: `Bearer ${token}` })).status, 401);
  }
  const login = await request('/status/login', 'POST', { Origin: origin, 'Content-Type': 'application/json' }, { password: 'sdk-gateway-password' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), new RegExp(`Path=${prefix || '/'};`));
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const full = await request(media, 'GET', { Cookie });
  assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.match(full.headers.get('cache-control'), /no-store/); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const range = await request(media, 'GET', { Cookie, Range: 'bytes=2-9' });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 2-9/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 10));
  const head = await request(media, 'HEAD', { Cookie, Range: 'bytes=2-9' });
  assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '8'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await request(media, 'GET', { Cookie, Range: 'bytes=999999-' })).status, 416);
  for (const pathname of [media.replace('media.mp4', 'recording.ps'), media.replace(session.id, 'not-a-session'), '/api/devices']) {
    assert.equal((await request(pathname, 'GET', { Cookie })).status, 404);
  }
  assert.equal((await request(media, 'POST', { Cookie, Origin: origin })).status, 404);
  const payload = { client: 'gateway-client', generation: 2 };
  assert.equal((await request(stop, 'POST', { Origin: origin, 'Content-Type': 'application/json' }, payload)).status, 401);
  assert.equal((await request(stop, 'POST', { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' }, payload)).status, 401);
  assert.equal((await request(stop, 'POST', { Cookie, 'Content-Type': 'application/json' }, payload)).status, 403);
  assert.equal((await request(stop, 'POST', { Cookie, Origin: 'https://other.example', 'Content-Type': 'application/json' }, payload)).status, 403);
  assert.equal(stopCalls, 0); assert.equal(manager.current, session);
  assert.equal((await request(stop, 'POST', { Cookie, Origin: origin, 'Content-Type': 'application/json' }, payload)).status, 204);
  assert.equal(stopCalls, 1); assert.equal(manager.current, null);
  assert.equal((await request(media, 'GET', { Cookie })).status, 410);
  await request('/status/logout', 'POST', { Cookie, Origin: origin, 'Content-Type': 'application/json' }, {});
  assert.equal((await request(media, 'GET', { Cookie })).status, 401);
  assert.equal((await request(stop, 'POST', { Cookie, Origin: origin, 'Content-Type': 'application/json' }, payload)).status, 401);
  assert.equal(stopCalls, 1);
});
