import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-config-test-'));
process.env.HIKVISION_DATA_DIR = temp;
process.env.HIKVISION_ARCHIVE_DIR = path.join(temp, 'archive');
process.env.HIKVISION_MEDIAMTX_API_URL = '';
process.env.HIKVISION_MEDIAMTX_PLAYBACK_URL = 'http://127.0.0.1:0';
const { mountConsoleConfig, readPlaybackUrl, consoleConfigJsonError } = await import('../lib/console-config.js');
const { createPublicGateway, createStatusPasswordHash } = await import('../lib/mcp-security.js');
const { getAllDevices } = await import('../lib/device-store.js');
const { probeDevice, snapshotDevice } = await import('../lib/device-probe.js');

test('owner configuration: auth, CSRF, revisions, preparation, two DVRs, redaction, mappings and corrupt files', async () => {
  const app = express(); app.use(express.json()); app.use(consoleConfigJsonError); let busy = false, probes = 0, changed = '', probeFailure = false, snapshots = 0, holdProbe;
  mountConsoleConfig(app, { isBusy: () => busy, testDevice: async () => { probes++; if (holdProbe) await holdProbe; if (probeFailure) throw Object.assign(new Error('SECRET upstream'), { code: 'DVR_AUTH_FAILED' }); return { deviceInfo: { model: 'Mock' }, channels: [{ id: '101' }] }; }, snapshotDevice: async (device, channel) => { snapshots++; assert.equal(device.password, 'SECRET_A_ROTATED'); assert.equal(channel, '101'); return 'data:image/jpeg;base64,/9j/2Q=='; }, onPlaybackChange: value => { changed = value; } });
  const token = 'configuration-test-mcp-token-at-least-32-characters', origin = 'https://owner.example';
  const gateway = createPublicGateway(app, { token, baseUrl: `${origin}/isolated`, statusPasswordHash: createStatusPasswordHash('test-password-123') });
  const server = gateway.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie, config;
  const request = (route, method = 'GET', body, headers = {}) => fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), origin, 'content-type': 'application/json', ...(config?.csrfToken ? { 'x-csrf-token': config.csrfToken } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request('/console/api/config')).status, 401);
    assert.equal((await request('/console/api/config', 'GET', null, { authorization: `Bearer ${token}` })).status, 401);
    let response = await request('/status/login', 'POST', { password: 'test-password-123' }); cookie = response.headers.get('set-cookie').split(';')[0];
    response = await request('/console/api/config'); assert.equal(response.headers.get('cache-control'), 'no-store'); config = await response.json(); assert.equal(config.dvrs.length, 0);

    for (const badBody of ['{"password":REVIEW_SENTINEL_SECRET}', JSON.stringify({ password: 'REVIEW_SENTINEL_SECRET'.repeat(10000) })]) {
      const malformed = await fetch(base + '/console/api/dvrs', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': config.csrfToken }, body: badBody });
      assert.ok([400, 413].includes(malformed.status)); assert.match(malformed.headers.get('content-type'), /application\/json/);
      const body = await malformed.text(); assert.equal(body.includes('REVIEW_'), false); assert.equal(body.includes('SyntaxError'), false);
    }
    const first = { revision: config.revision, name: 'DVR A', ip: '127.0.0.1', httpPort: 18080, rtspPort: 18554, username: 'admin', password: 'SECRET_A' };
    assert.equal((await request('/console/api/dvrs', 'POST', first, { 'x-csrf-token': '' })).status, 403);
    assert.equal((await request('/console/api/dvrs', 'POST', first, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/devices')).status, 404);
    process.env.HIKCLIP_PREPARATION_ONLY = '1';
    assert.equal((await request('/console/api/dvrs', 'POST', first)).status, 409);
    assert.equal((await request('/console/api/DVRS', 'POST', first)).status, 404);
    assert.equal((await request('/console/api/%64vrs', 'POST', first)).status, 404);
    assert.equal(getAllDevices().devices.length, 0); delete process.env.HIKCLIP_PREPARATION_ONLY;
    probeFailure = true;
    response = await request('/console/api/dvrs', 'POST', first); assert.equal(response.status, 502);
    const failed = await response.json(); assert.equal(failed.forceSaveRequired, true); assert.equal(failed.code, 'DVR_AUTH_FAILED'); assert.equal(JSON.stringify(failed).includes('SECRET'), false);
    assert.equal(getAllDevices().devices.length, 0); assert.equal(fs.existsSync(path.join(temp, 'devices.json')), false);
    assert.equal((await request('/console/api/dvrs', 'POST', { ...first, ip: 'http://bad', forceSave: true })).status, 400);
    assert.equal((await request('/console/api/dvrs', 'POST', { ...first, forceSave: 'true' })).status, 400);
    response = await request('/console/api/dvrs', 'POST', { ...first, forceSave: true }); assert.equal(response.status, 200); config = await response.json();
    assert.equal(probes, 1); probeFailure = false;
    assert.equal(JSON.stringify(config).includes('SECRET_A'), false); assert.equal(config.dvrs[0].hasPassword, true); assert.equal(getAllDevices().activeDeviceId, null);
    const sameSnapshot = await (await request('/console/api/config')).json(); assert.equal(sameSnapshot.revision, config.revision);
    const publicDigest = crypto.createHash('sha256');
    for (const name of ['devices.json', 'cameras.json', 'console-sources.json']) {
      const file = path.join(temp, name); publicDigest.update(fs.existsSync(file) ? fs.readFileSync(file) : 'missing'); publicDigest.update('\0');
    }
    assert.notEqual(config.revision, publicDigest.digest('hex'));
    const moduleUrl = new URL('../lib/console-config.js', import.meta.url).href;
    const { stdout: separateRevision } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `const {configSnapshot} = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(configSnapshot().revision);`], { env: { ...process.env, HIKVISION_DATA_DIR: temp } });
    assert.notEqual(config.revision, separateRevision); assert.match(separateRevision, /^[a-f0-9]{64}$/);

    const id = config.dvrs[0].id;
    assert.equal((await request('/console/api/dvrs', 'POST', { ...first, name: 'stale' })).status, 409);
    response = await request('/console/api/dvrs', 'POST', { ...first, revision: config.revision, name: 'DVR B', httpPort: 28080, rtspPort: 28554, password: 'SECRET_B' }); config = await response.json(); assert.equal(config.dvrs.length, 2);
    response = await request(`/console/api/dvrs/${id}`, 'PATCH', { revision: config.revision, name: 'Renamed', password: '' }); config = await response.json(); assert.equal(config.dvrs[0].name, 'Renamed'); assert.equal(getAllDevices().devices[0].password, 'SECRET_A');
    const beforePassword = config.revision;
    response = await request(`/console/api/dvrs/${id}`, 'PATCH', { revision: config.revision, password: 'SECRET_A_ROTATED' }); config = await response.json();
    assert.notEqual(config.revision, beforePassword); assert.equal(JSON.stringify(config).includes('SECRET_A_ROTATED'), false);
    assert.equal((await request(`/console/api/dvrs/${id}`, 'PATCH', { revision: config.revision, ip: '192.0.2.2', password: '' })).status, 400);
    response = await request('/console/api/cameras', 'PUT', { revision: config.revision, cameras: [{ id: 'a', name: 'Camera A', deviceId: id, channel: '101', archivePath: 'front' }] }); config = await response.json(); assert.equal(config.cameras.length, 1);
    assert.equal((await request(`/console/api/dvrs/${id}`, 'DELETE', { revision: config.revision })).status, 409);
    busy = true; assert.equal((await request(`/console/api/dvrs/${id}`, 'PATCH', { revision: config.revision, rtspPort: 15554, password: 'FRESH' })).status, 409); busy = false;
    response = await request(`/console/api/dvrs/${id}/test`, 'POST', { revision: config.revision }); assert.equal(response.status, 200); assert.equal(probes, 3);
    process.env.HIKCLIP_PREPARATION_ONLY = '1'; assert.equal((await request(`/console/api/dvrs/${id}/test`, 'POST', { revision: config.revision })).status, 409); assert.equal(probes, 3); delete process.env.HIKCLIP_PREPARATION_ONLY;
    response = await request(`/console/api/dvrs/${id}/snapshot`, 'POST', { revision: config.revision, channel: '101' }); assert.equal(response.status, 200);
    assert.equal((await response.json()).imageDataUrl, 'data:image/jpeg;base64,/9j/2Q=='); assert.equal(snapshots, 1);
    assert.equal((await request(`/console/api/dvrs/${id}/snapshot`, 'POST', { revision: config.revision, channel: '101' }, { 'x-csrf-token': '' })).status, 403);
    assert.equal((await request(`/console/api/dvrs/${id}/snapshot`, 'POST', { revision: config.revision, channel: '../System/deviceInfo' })).status, 400);
    busy = true; assert.equal((await request(`/console/api/dvrs/${id}/snapshot`, 'POST', { revision: config.revision, channel: '101' })).status, 409); busy = false;
    process.env.HIKCLIP_PREPARATION_ONLY = '1'; assert.equal((await request(`/console/api/dvrs/${id}/snapshot`, 'POST', { revision: config.revision, channel: '101' })).status, 409); delete process.env.HIKCLIP_PREPARATION_ONLY;
    let release; holdProbe = new Promise(resolve => { release = resolve; });
    const pending = request('/console/api/dvrs', 'POST', { ...first, revision: config.revision, name: 'Pending' });
    while (probes < 4) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await request(`/console/api/dvrs/${id}/snapshot`, 'POST', { revision: config.revision, channel: '101' })).status, 409);
    assert.equal((await request(`/console/api/dvrs/${id}/test`, 'POST', { revision: config.revision })).status, 409);
    response = await request(`/console/api/dvrs/${id}`, 'PATCH', { revision: config.revision, name: 'Changed during test' }); config = await response.json();
    release(); holdProbe = null; assert.equal((await pending).status, 409); assert.equal(getAllDevices().devices.length, 2);
    for (const playbackUrl of ['http://user:SECRET@127.0.0.1:9996', 'file:///tmp/a', 'http://127.0.0.1:9996/a']) assert.equal((await request('/console/api/mediamtx', 'PUT', { revision: config.revision, playbackUrl })).status, 400);
    response = await request('/console/api/mediamtx', 'PUT', { revision: config.revision, playbackUrl: 'http://127.0.0.1:29996' }); config = await response.json(); assert.equal(changed, 'http://127.0.0.1:29996'); assert.equal(readPlaybackUrl(), changed);
    const oldBytes = fs.readFileSync(path.join(temp, 'devices.json'), 'utf8'); fs.writeFileSync(path.join(temp, 'devices.json'), '{SECRET_B bad JSON');
    response = await request('/console/api/config'); assert.equal(response.status, 400); assert.equal((await response.text()).includes('SECRET_B'), false);
    assert.equal((await request('/console/api/dvrs', 'POST', { ...first, revision: config.revision })).status, 400); assert.equal(fs.readFileSync(path.join(temp, 'devices.json'), 'utf8'), '{SECRET_B bad JSON');
    fs.writeFileSync(path.join(temp, 'devices.json'), oldBytes);
    fs.writeFileSync(path.join(temp, 'cameras.json'), '{broken'); assert.equal((await request('/console/api/cameras', 'PUT', { revision: config.revision, cameras: [] })).status, 400); assert.equal(fs.readFileSync(path.join(temp, 'cameras.json'), 'utf8'), '{broken');
  } finally { delete process.env.HIKCLIP_PREPARATION_ONLY; await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
});
test('probe uses explicit HTTP port, read-only endpoints, bounded buffers and safe failures', async () => {
  const calls = [], device = { ip: '127.0.0.1', httpPort: 18888, rtspPort: 19999, username: 'admin', password: 'SECRET' };
  const result = await probeDevice(device, { runImpl: async (cmd, args, options) => { calls.push({ cmd, args, options }); return { stdout: args.at(-1).endsWith('deviceInfo') ? '<DeviceInfo><model>Mock DVR</model></DeviceInfo>' : '<StreamingChannelList><StreamingChannel><id>101</id><channelName>Front</channelName></StreamingChannel></StreamingChannelList>' }; } });
  assert.equal(result.channels[0].id, '101'); assert.equal(calls.length, 2);
  for (const c of calls) { assert.ok(c.args.at(-1).startsWith('http://127.0.0.1:18888/ISAPI/')); assert.ok(c.options.timeout <= 10100); assert.equal(c.options.maxBuffer, 1048576); assert.equal(c.args.includes('-L'), false); }
  await assert.rejects(probeDevice(device, { runImpl: async () => { throw new Error('curl args SECRET'); } }), { message: 'Device test failed' });
});

test('mock DVR servers on separate ports receive only bounded read-only probes', async () => {
  const http = await import('node:http');
  const seen = [[], []], servers = seen.map((requests, i) => http.createServer((req, res) => {
    requests.push([req.method, req.url]); res.setHeader('content-type', 'application/xml');
    res.end(req.url.endsWith('deviceInfo') ? `<DeviceInfo><model>Mock ${i}</model></DeviceInfo>` : `<StreamingChannelList><StreamingChannel><id>${i + 1}01</id></StreamingChannel></StreamingChannelList>`);
  }));
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  try {
    const results = await Promise.all(servers.map(server => probeDevice({ ip: '127.0.0.1', httpPort: server.address().port, rtspPort: 15554, username: 'fake-user', password: 'fake-password' })));
    assert.deepEqual(results.map(r => r.channels[0].id), ['101', '201']);
    for (const requests of seen) assert.deepEqual(requests, [['GET', '/ISAPI/System/deviceInfo'], ['GET', '/ISAPI/Streaming/channels']]);
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
});

test('DVR authentication failures stay safe upstream errors, never console session 401', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => { res.writeHead(401, { 'content-type': 'text/html' }); res.end('private-device-response SECRET'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(probeDevice({ ip: '127.0.0.1', httpPort: server.address().port, username: 'fake-user', password: 'SECRET' }), error => {
      assert.equal(error.message, 'Device test failed'); assert.equal(error.code, 'DVR_AUTH_FAILED'); assert.equal(String(error).includes('SECRET'), false); return true;
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('snapshot is bounded, channel validated, JPEG-only and never exposes upstream errors', async () => {
  const device = { ip: '127.0.0.1', httpPort: 18888, username: 'admin', password: 'SECRET' }, calls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(await snapshotDevice(device, '101', { runImpl: async (cmd, args, options) => { calls.push({ cmd, args, options }); return { stdout: jpeg }; } }), 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(calls[0].args.at(-1), 'http://127.0.0.1:18888/ISAPI/Streaming/channels/101/picture');
  assert.equal(calls[0].args.includes('-L'), false); assert.equal(calls[0].options.timeout, 8100); assert.equal(calls[0].options.maxBuffer, 4194304); assert.equal(calls[0].options.encoding, 'buffer');
  await assert.rejects(snapshotDevice(device, '101\r\n', { runImpl: async () => assert.fail('must not contact invalid channel') }));
  for (const stdout of [Buffer.from('<html>SECRET</html>'), Buffer.alloc(4194305), 'not a buffer']) {
    await assert.rejects(snapshotDevice(device, '101', { runImpl: async () => ({ stdout }) }), { message: 'Device snapshot failed', code: 'DVR_SNAPSHOT_FAILED' });
  }
  await assert.rejects(snapshotDevice(device, '101', { runImpl: async () => { throw { stderr: 'returned error: 401 SECRET' }; } }), { message: 'Device snapshot failed', code: 'DVR_AUTH_FAILED' });
});

test('mock DVR snapshot uses saved HTTP origin and exactly one read-only picture request', async () => {
  const http = await import('node:http'), requests = [], jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const server = http.createServer((req, res) => { requests.push([req.method, req.url]); res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(jpeg); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(await snapshotDevice({ ip: '127.0.0.1', httpPort: server.address().port, username: 'fake', password: 'fake' }, '201'), 'data:image/jpeg;base64,/9j/2Q==');
    assert.deepEqual(requests, [['GET', '/ISAPI/Streaming/channels/201/picture']]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
