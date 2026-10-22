import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runMedia } from '../lib/media-archive.js';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';
import { createStatusSetupCode } from '../lib/status-password-store.js';
import { acquireExportLease } from '../lib/export-recovery.js';

const repository = path.resolve(import.meta.dirname, '..');
const day = '2026-09-24';

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function freePort() {
  const server = net.createServer(), port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function closeServer(server) {
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-channel-runtime-'));
  let child, logs = '';
  const requests = [];
  const heldDiscovery = [];
  const media = { paths: [], recordings: [], offline: false, video: Buffer.alloc(0), holdDiscovery: false,
    releaseDiscovery() { this.holdDiscovery = false; for (const release of heldDiscovery.splice(0)) release(); } };
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url);
    if (url.pathname.startsWith('/v3/')) {
      if (media.offline) { res.writeHead(503); res.end('unavailable'); return; }
      const names = url.pathname === '/v3/paths/list' ? media.paths : url.pathname === '/v3/recordings/list' ? media.recordings : null;
      if (names) {
        const send = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ pageCount: names.length ? 1 : 0, itemCount: names.length, items: names.map(name => ({ name })) }));
        };
        if (media.holdDiscovery) heldDiscovery.push(send); else send();
        return;
      }
    }
    if (url.pathname === '/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ start: `${day}T20:00:00+08:00`, duration: 8 }]));
      return;
    }
    if (url.pathname === '/get') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': media.video.length });
      res.end(media.video); return;
    }
    res.writeHead(404); res.end();
  });
  const mediaPort = await listen(upstream), appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`, playbackUrl = `http://127.0.0.1:${mediaPort}`;
  const data = path.join(root, 'data'), archive = path.join(root, 'archive');
  const env = {
    ...process.env, TZ: 'Asia/Shanghai', PORT: String(appPort), NODE_TEST: '1',
    HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0', HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0',
    HIKVISION_DATA_DIR: data, HIKVISION_DOWNLOADS_DIR: path.join(root, 'downloads'),
    HIKVISION_RUNTIME_FILE: path.join(root, 'runtime.json'), HIKVISION_ARTIFACT_DIR: path.join(root, 'artifacts'), HIKVISION_ARCHIVE_DIR: archive,
    HIKVISION_MEDIAMTX_API_URL: playbackUrl, HIKVISION_MEDIAMTX_PLAYBACK_URL: playbackUrl,
    HIKCLIP_MCP_TOKEN: '', HIKCLIP_MCP_TOKEN_FILE: '', HIKCLIP_PUBLIC_BASE_URL: '', HIKCLIP_PUBLIC_PORT: '',
    HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '', HIKVISION_BILIUP_ENABLED: '0',
  };
  // The archive's default font is Alpine-specific; use an available system font on other hosts.
  const font = [process.env.HIKVISION_FONT_FILE, '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', 'C:/Windows/Fonts/arial.ttf'].find(value => value && fs.existsSync(value));
  if (font) env.HIKVISION_FONT_FILE = font;

  async function request(url, body, { origin = base, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await fetch(origin + url, { method, signal: AbortSignal.timeout(10_000), headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(force); }
  }
  async function start(extraEnv = {}, { waitForRecovery = true } = {}) {
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null, 'stop the prior isolated server before restarting');
    logs = '';
    child = spawn(process.execPath, ['server.js'], { cwd: repository, windowsHide: true, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
    child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, `server exited during startup: ${logs}`);
      try {
        const result = await request('/api/runtime-health');
        if (result.status === 200 && (!waitForRecovery || result.body.recoveryReady === true)) return;
      } catch { /* Wait for the child listener. */ }
      await delay(50);
    }
    assert.fail(`isolated server did not start: ${logs}`);
  }
  async function completed(taskId) {
    const deadline = Date.now() + 20_000;
    let task;
    while (Date.now() < deadline) {
      const result = await request(`/api/media-jobs/${taskId}`);
      task = result.body.task;
      if (['completed', 'error', 'cancelled'].includes(task?.status)) return task;
      await delay(50);
    }
    assert.fail(`task ${taskId} did not settle: ${JSON.stringify(task)}\n${logs}`);
  }
  t.after(async () => { await stop(); await closeServer(upstream); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, data, archive, base, playbackUrl, env, requests, media, start, stop, request, completed };
}

async function synthesize(f, camera = 'local-court') {
  const directory = path.join(f.archive, camera);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${day}_20-00-00-000000.mp4`);
  await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10', '-t', '8',
    '-c:v', 'libx264', '-threads', '1', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
  f.media.video = fs.readFileSync(file);
  return file;
}

function artifactFile(f, url) {
  const pathname = new URL(url, f.base).pathname;
  assert.ok(pathname.startsWith('/artifacts/'));
  return path.join(f.root, 'artifacts', pathname.slice('/artifacts/'.length));
}

async function assertPlayable(f, camera, archivePath = camera) {
  const segments = await f.request(`/console/api/playback/${camera}/segments?date=${day}`);
  assert.equal(segments.status, 200, JSON.stringify(segments.body));
  assert.equal(segments.body.segments.length, 1);
  const query = new URLSearchParams({ start: `${day}T20:00:01+08:00`, duration: '3', format: 'mp4' });
  const response = await fetch(`${f.base}/console/api/playback/${camera}/stream?${query}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /video\/mp4/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.media.video);
  const lastGet = f.requests.filter(url => url.pathname === '/get').at(-1);
  assert.equal(lastGet.searchParams.get('path'), archivePath);
  assert.equal(lastGet.searchParams.get('format'), 'mp4');
  assert.equal(f.requests.filter(url => url.pathname === '/list').at(-1).searchParams.get('path'), archivePath);
}

test('automatic local channel needs no mapping or DVR: playback, real media exports, gaps, and restart recovery', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  await synthesize(f);
  await f.start();
  const camerasFile = path.join(f.data, 'cameras.json'), devicesFile = path.join(f.data, 'devices.json');
  assert.equal(fs.existsSync(camerasFile), false);
  assert.equal(fs.existsSync(devicesFile), false);
  const directory = await f.request('/api/cameras');
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.cameras, [{ id: 'local-court', name: 'local-court' }]);
  const bootstrap = await f.request('/console/api/bootstrap');
  assert.deepEqual(bootstrap.body.dvrs, []);
  assert.deepEqual(bootstrap.body.cameras.map(({ id, name }) => ({ id, name })), directory.body.cameras);
  assert.equal(bootstrap.body.cameras[0].dvrId, '');
  await assertPlayable(f, 'local-court');

  const completedTasks = [];
  for (const [operation, args] of [
    ['clip', { camera: 'local-court', start: `${day} 20:00:01`, end: `${day} 20:00:05` }],
    ['snapshot', { camera: 'local-court', datetime: `${day} 20:00:02` }],
    ['timeline', { camera: 'local-court', date: day, start: '20:00:01', interval: 1, count: 4 }],
  ]) {
    const result = await f.request(`/api/cameras/${operation}`, args);
    assert.equal(result.status, 202, JSON.stringify(result.body));
    const task = await f.completed(result.body.taskId);
    assert.equal(task.status, 'completed', JSON.stringify(task));
    assert.equal(task.source, 'mediamtx');
    assert.equal(task.camera, 'local-court');
    const response = await fetch(new URL(task.artifactUrl, f.base), { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 1000);
    const probe = await runMedia(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', artifactFile(f, task.artifactUrl)]);
    const metadata = JSON.parse(probe.stdout);
    assert.ok(metadata.streams[0].width >= 320);
    if (operation === 'clip') assert.ok(Number(metadata.format.duration) >= 3.8 && Number(metadata.format.duration) <= 4.3);
    else assert.equal(metadata.streams[0].codec_name, 'png');
    completedTasks.push(task);
  }
  assert.equal(fs.existsSync(camerasFile), false, 'discovery and exports must not persist optional mappings');
  assert.equal(fs.existsSync(devicesFile), false, 'local work must not synthesize a DVR');
  const original = completedTasks[0];
  const snapshot = JSON.parse(fs.readFileSync(path.join(f.data, 'export-queue', `${original.taskId}.json`), 'utf8'));
  assert.equal(snapshot.request.forceArchive, true);
  assert.deepEqual(snapshot.request.camera, { id: 'local-court', name: 'local-court', archivePath: 'local-court' });
  assert.equal(snapshot.request.deviceId, undefined);
  assert.equal(snapshot.request.endpoint, undefined);
  assert.equal(snapshot.request.plan.source, 'mediamtx');
  assert.match(snapshot.request.sourceIdentity, /^[a-f0-9]{64}$/);

  // An active legacy DVR must never become an implicit fallback for an unbound path.
  let dvrConnections = 0;
  const trap = net.createServer(socket => { dvrConnections++; socket.destroy(); });
  const dvrPort = await listen(trap);
  t.after(() => closeServer(trap));
  const device = await f.request('/api/devices', { name: 'unused default DVR', ip: '127.0.0.1', httpPort: dvrPort, rtspPort: dvrPort, username: 'fixture', password: 'fixture-only' });
  assert.equal(device.status, 200);
  for (const [operation, args] of [
    ['clip', { camera: 'local-court', start: `${day} 20:00:06`, end: `${day} 20:00:10` }],
    ['snapshot', { camera: 'local-court', datetime: `${day} 21:00:00` }],
    ['timeline', { camera: 'local-court', date: day, start: '21:00:00', interval: 1, count: 2 }],
  ]) {
    const result = await f.request(`/api/cameras/${operation}`, args);
    assert.equal(result.status, 202, JSON.stringify(result.body));
    const task = await f.completed(result.body.taskId);
    assert.equal(task.status, 'error', JSON.stringify(task));
    assert.equal(task.failureCode, operation === 'clip' ? 'MEDIAMTX_GAPS' : 'MEDIAMTX_EMPTY');
    assert.equal(task.artifactUrl, undefined);
  }
  assert.equal(dvrConnections, 0, 'local-only gaps must not contact even the active DVR');

  // Seed one unfinished admission from a real request snapshot while the isolated process is stopped.
  await f.stop();
  const taskId = crypto.randomUUID(), filename = 'recovered automatic channel.mp4';
  const request = { ...snapshot.request, filename };
  const record = { version: 1, order: 100, publications: [], request, task: {
    taskId, cameraJob: true, kind: 'clip', queuedAt: Date.now(), status: 'queued', camera: 'local-court',
    sourceIdentity: request.sourceIdentity, start: original.start, end: original.end, filename,
  } };
  fs.writeFileSync(path.join(f.data, 'export-queue', `${taskId}.json`), JSON.stringify(record));
  f.media.offline = true;
  await f.start();
  const recovered = await f.completed(taskId);
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.source, 'mediamtx');
  assert.equal(recovered.sourceIdentity, original.sourceIdentity);
  assert.equal(recovered.filename, filename);
  assert.ok(fs.statSync(path.join(f.root, 'downloads', filename)).size > 1000);
  assert.equal(dvrConnections, 0);
  assert.equal(fs.existsSync(camerasFile), false);
  assert.deepEqual((await f.request('/api/cameras')).body.cameras, directory.body.cameras);
});

test('HTTP discovery refreshes API paths/recordings, retains outage catalog, and only explicit alias save writes mappings', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.archive, 'local-path'), { recursive: true });
  fs.mkdirSync(path.join(f.archive, 'invalid folder'));
  f.media.paths = ['live-path'];
  f.media.recordings = ['recorded-path', 'api-only-recording', 'live-path', '../invalid'];
  await synthesize(f, 'recorded-path');
  const publicPort = await freePort(), publicBase = `http://127.0.0.1:${publicPort}`;
  const publicOrigin = 'https://automatic-camera.example.test';
  const setup = createStatusSetupCode(path.join(f.data, 'public-console-auth.json'));
  await f.start({ HIKCLIP_PUBLIC_PORT: String(publicPort), HIKCLIP_PUBLIC_BIND: '127.0.0.1', HIKCLIP_PUBLIC_BASE_URL: publicOrigin,
    HIKCLIP_MCP_TOKEN: 'automatic-channel-runtime-token-1234567890' });
  const expected = ['api-only-recording', 'live-path', 'local-path', 'recorded-path'];
  assert.deepEqual((await f.request('/api/cameras')).body.cameras.map(camera => camera.id), expected);
  assert.ok(f.requests.some(url => url.pathname === '/v3/paths/list'));
  assert.ok(f.requests.some(url => url.pathname === '/v3/recordings/list'));
  assert.equal(fs.existsSync(path.join(f.data, 'cameras.json')), false);

  const authHeaders = { Origin: publicOrigin };
  const configured = await f.request('/console/api/setup', { code: setup.code, password: 'runtime-camera-password' }, { origin: publicBase, headers: authHeaders });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const login = await f.request('/status/login', { password: 'runtime-camera-password' }, { origin: publicBase, headers: authHeaders });
  assert.equal(login.status, 200);
  authHeaders.Cookie = login.headers.get('set-cookie').split(';')[0];
  const ownerRequest = (url, body, method) => f.request(url, body, { origin: publicBase, headers: authHeaders, ...(method ? { method } : {}) });

  // Each public catalog entry point must refresh newly available paths itself.
  f.media.paths.push('settings-only');
  let config = await ownerRequest('/console/api/config');
  assert.equal(config.status, 200, JSON.stringify(config.body));
  assert.deepEqual(config.body.cameras, []);
  assert.deepEqual(config.body.dvrs, []);
  assert.ok(config.body.channels.some(camera => camera.id === 'settings-only'));
  f.media.recordings.push('bootstrap-only');
  const bootstrap = await ownerRequest('/console/api/bootstrap');
  assert.ok(bootstrap.body.cameras.some(camera => camera.id === 'bootstrap-only'));
  const before = (await f.request('/api/cameras')).body.cameras;
  f.media.offline = true;
  assert.deepEqual((await f.request('/api/cameras')).body.cameras, before);
  assert.deepEqual((await ownerRequest('/console/api/bootstrap')).body.cameras.map(({ id, name }) => ({ id, name })), before);
  config = await ownerRequest('/console/api/config');
  assert.deepEqual(config.body.channels.map(({ id, name }) => ({ id, name })), before);
  assert.equal(fs.existsSync(path.join(f.data, 'cameras.json')), false);
  await assertPlayable(f, 'api-only-recording');
  await assertPlayable(f, 'recorded-path');

  const clipArgs = { camera: 'recorded-path', start: `${day} 20:00:01`, end: `${day} 20:00:04` };
  const clip = await f.request('/api/cameras/clip', clipArgs);
  assert.equal(clip.status, 202, JSON.stringify(clip.body));
  const beforeRename = await f.completed(clip.body.taskId);
  assert.equal(beforeRename.status, 'completed', JSON.stringify(beforeRename));
  assert.equal(fs.existsSync(path.join(f.data, 'cameras.json')), false);

  authHeaders['x-csrf-token'] = config.body.csrfToken;
  const saved = await ownerRequest('/console/api/cameras', { revision: config.body.revision, cameras: [
    { id: 'recorded-path', name: 'Recorded court', archivePath: 'recorded-path' },
  ] }, 'PUT');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'cameras.json'), 'utf8')), { cameras: [
    { id: 'recorded-path', name: 'Recorded court', archivePath: 'recorded-path' },
  ] });
  const after = (await f.request('/api/cameras')).body.cameras;
  assert.equal(after.length, before.length);
  assert.deepEqual(after.find(camera => camera.id === 'recorded-path'), { id: 'recorded-path', name: 'Recorded court' });
  assert.deepEqual(after.filter(camera => camera.id !== 'recorded-path').sort((a, b) => a.id.localeCompare(b.id)),
    before.filter(camera => camera.id !== 'recorded-path').sort((a, b) => a.id.localeCompare(b.id)));
  await assertPlayable(f, 'recorded-path');
  const reused = await f.request('/api/cameras/clip', { ...clipArgs, camera: 'Recorded court' });
  assert.equal(reused.status, 202, JSON.stringify(reused.body));
  assert.equal(reused.body.reused, true, 'renaming an optional alias must preserve existing source cache identity');
  const afterRename = await f.completed(reused.body.taskId);
  assert.equal(afterRename.sourceIdentity, beforeRename.sourceIdentity);
  assert.equal(new URL(afterRename.artifactUrl).pathname, new URL(beforeRename.artifactUrl).pathname);
  assert.equal(fs.existsSync(path.join(f.data, 'devices.json')), false);
});

async function recoveryReady(f) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await f.request('/api/runtime-health')).body.recoveryReady) return;
    await delay(50);
  }
  assert.fail('recovery gate did not become ready');
}

test('slow discovery startup blocks export and source writes until recovery owns its lease', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.media.holdDiscovery = true;
  const publicPort = await freePort(), publicBase = `http://127.0.0.1:${publicPort}`, publicOrigin = 'https://startup-camera.example.test';
  await f.start({ HIKCLIP_PUBLIC_PORT: String(publicPort), HIKCLIP_PUBLIC_BIND: '127.0.0.1', HIKCLIP_PUBLIC_BASE_URL: publicOrigin,
    HIKCLIP_MCP_TOKEN: 'startup-channel-runtime-token-1234567890', HIKCLIP_LOGIN_PASSWORD: 'startup-fixture-password' }, { waitForRecovery: false });
  assert.equal((await f.request('/api/runtime-health')).body.recoveryReady, false);
  const login = await f.request('/status/login', { password: 'startup-fixture-password' }, { origin: publicBase, headers: { Origin: publicOrigin } });
  assert.equal(login.status, 200);
  const headers = { Origin: publicOrigin, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const settings = await f.request('/console/api/settings', undefined, { origin: publicBase, headers });
  assert.equal(settings.status, 200); headers['X-CSRF-Token'] = settings.body.csrfToken;
  for (const route of ['/api/export', '/api/cameras/clip', '/console/api/export']) {
    const response = await f.request(route, {});
    assert.equal(response.status, 503, `${route}: ${JSON.stringify(response.body)}`);
    assert.match(response.body.error, /初始化/);
  }
  for (const [route, method] of [['/api/devices', 'POST'], ['/api/devices/missing', 'PUT'], ['/api/devices/missing', 'DELETE'], ['/api/devices/missing/activate', 'PUT']]) {
    assert.equal((await f.request(route, {}, { method })).status, 503, route);
  }
  for (const [route, method, body] of [['/console/api/cameras', 'PUT', { cameras: [] }], ['/console/api/mediamtx', 'PUT', { playbackUrl: f.playbackUrl }], ['/console/api/dvrs', 'POST', {}], ['/console/api/settings', 'PUT', {}]]) {
    const response = await f.request(route, { revision: 'not-yet-ready', ...body }, { origin: publicBase, headers, method });
    assert.equal(response.status, 503, `${route}: ${JSON.stringify(response.body)}`);
  }
  assert.equal((await f.request('/api/runtime-health')).body.recoveryReady, false);
  assert.equal(fs.existsSync(path.join(f.data, 'devices.json')), false);
  assert.equal(fs.existsSync(path.join(f.data, 'cameras.json')), false);
  assert.equal(fs.existsSync(path.join(f.data, 'console-sources.json')), false);
  assert.equal(fs.existsSync(path.join(f.data, 'export-queue', '.export.lock')), false, 'lease not yet acquired during held discovery');
  f.media.releaseDiscovery(); await recoveryReady(f);
  const created = await f.request('/api/devices', { name: 'after recovery', ip: '192.0.2.100', username: 'fixture', password: 'fixture-only' });
  assert.equal(created.status, 200);
});

test('lease contention keeps startup writes blocked until the actual owner releases it', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  let release = acquireExportLease(path.join(f.data, 'export-queue'));
  t.after(() => release?.());
  await f.start({}, { waitForRecovery: false });
  const deadline = Date.now() + 5000;
  let status;
  while (Date.now() < deadline) {
    status = await f.request('/api/status');
    if (status.body.activeTasks.some(task => task.status === 'error' && /持有导出队列/.test(task.message))) break;
    await delay(25);
  }
  assert.ok(status.body.activeTasks.some(task => task.status === 'error' && /持有导出队列/.test(task.message)), JSON.stringify(status.body));
  assert.equal((await f.request('/api/runtime-health')).body.recoveryReady, false);
  for (const route of ['/api/export', '/api/cameras/clip', '/console/api/export', '/api/devices']) {
    const response = await f.request(route, {});
    assert.equal(response.status, 503, route); assert.match(response.body.error, /持有导出队列/);
  }
  assert.equal(fs.existsSync(path.join(f.data, 'devices.json')), false);
  assert.equal(fs.readdirSync(path.join(f.data, 'export-queue')).some(name => name.endsWith('.json')), false);
  release(); release = null;
  await recoveryReady(f);
  assert.equal((await f.request('/api/runtime-health')).body.recoveryReady, true);
});
