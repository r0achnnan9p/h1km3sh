import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskProgressPresentation, uploadProgressCaption } from '../public/task-presentation.js';
import { runMedia } from '../lib/media-archive.js';
import { ffmpegPath } from '../lib/ffmpeg-paths.js';
import { createStatusSetupCode } from '../lib/status-password-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function waitForServer(url, child, getLogs, appBase) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`测试服务器意外退出：${getLogs()}`);
    try {
      const health = await fetch(appBase + '/api/runtime-health');
      if (health.ok && (await health.json()).recoveryReady === true) return await fetch(url);
    } catch { /* 等待启动与恢复 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务器启动超时：${getLogs()}`);
}

async function request(base, pathname, { method = 'GET', cookie, origin, body, headers = {} } = {}) {
  return fetch(base + pathname, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

test('公网录像控制台贯通认证、摄像头回放、成片保护、上传和安全缓存清理', { timeout: 30_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-camera-console-'));
  const dataDir = path.join(temp, 'data'), downloadsDir = path.join(temp, 'downloads');
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(downloadsDir, { recursive: true });
  const dvrId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(dataDir, 'devices.json'), JSON.stringify({ activeDeviceId: dvrId, devices: [
    { id: dvrId, name: 'DVR1', ip: '192.0.2.20', username: 'test-user', password: 'test-password' },
  ] }));
  fs.writeFileSync(path.join(dataDir, 'cameras.json'), JSON.stringify({ cameras: [
    { id: 'D2', name: 'D2', deviceId: dvrId, channel: '201', archivePath: 'mediamtx-d2' },
  ] }));
  const videoPath = path.join(downloadsDir, 'recording.mp4'); fs.writeFileSync(videoPath, 'abcdefgh');
  fs.writeFileSync(path.join(downloadsDir, 'existing.mp4'), 'already here');
  const completeCache = path.join(downloadsDir, 'complete.hikraw'); fs.writeFileSync(completeCache, 'complete'); fs.writeFileSync(completeCache + '.done', '');
  const partialCache = path.join(downloadsDir, 'partial.hikraw'); fs.writeFileSync(partialCache, 'partial');
  const cameraDir = path.join(downloadsDir, 'camera_0123456789abcdef'); fs.mkdirSync(cameraDir);
  const nestedCache = path.join(cameraDir, 'nested.hikraw'); fs.writeFileSync(nestedCache, 'nested'); fs.writeFileSync(nestedCache + '.done', '');
  const workerDir = path.join(downloadsDir, 'cloud189_work'); fs.mkdirSync(workerDir);
  fs.writeFileSync(path.join(workerDir, 'worker-status.json'), JSON.stringify({ binaryAvailable: true, authenticated: true, checkedAt: Date.now() / 1000 }));

  const biliWorkerDir = path.join(downloadsDir, 'biliup_work'); fs.mkdirSync(biliWorkerDir);
  fs.writeFileSync(path.join(biliWorkerDir, 'worker-status.json'), JSON.stringify({ binaryAvailable: true, credentialsPresent: true, coverAvailable: true, checkedAt: Date.now() / 1000 }));

  const previewFixture = path.join(temp, 'preview.mp4');
  await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10', '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', previewFixture]);
  const previewBytes = fs.readFileSync(previewFixture);
  let requestedMediaPath = '', requestedMediaFormat = '';
  const mediaServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requestedMediaPath = url.searchParams.get('path') || '';
    if (url.pathname === '/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ start: '2026-09-27T12:00:00+08:00', duration: 90, url: 'http://internal.invalid/not-for-client' }]));
      return;
    }
    if (url.pathname === '/get') {
      requestedMediaFormat = url.searchParams.get('format') || '';
      res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(requestedMediaFormat === 'mp4' ? previewBytes : 'fake-fmp4'); return;
    }
    res.writeHead(404); res.end();
  });
  const mediaPort = await listen(mediaServer);
  const appPort = await freePort(), publicPort = await freePort();
  const origin = 'https://camera.example.test';
  const publicUrl = `${origin}/zl-camera`;
  const token = 'runtime-test-mcp-token-12345678901234567890';
  const setup = createStatusSetupCode(path.join(dataDir, 'public-console-auth.json'));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env,
    PORT: String(appPort), NODE_TEST: '1', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0',
    HIKCLIP_PUBLIC_PORT: String(publicPort), HIKCLIP_PUBLIC_BIND: '127.0.0.1',
    HIKCLIP_PUBLIC_BASE_URL: publicUrl, HIKCLIP_MCP_TOKEN: token, HIKCLIP_MCP_TOKEN_FILE: '', HIKCLIP_BASE_URL: '',
    HIKVISION_DATA_DIR: dataDir, HIKVISION_DOWNLOADS_DIR: downloadsDir,
    HIKVISION_RUNTIME_FILE: path.join(temp, 'runtime.json'), HIKVISION_ARTIFACT_DIR: path.join(temp, 'artifacts'),
    HIKVISION_ARCHIVE_DIR: path.join(temp, 'archive'), HIKVISION_MEDIAMTX_API_URL: '',
    HIKVISION_MEDIAMTX_PLAYBACK_URL: `http://127.0.0.1:${mediaPort}`,
    HIKVISION_BILIUP_ENABLED: '1', HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '',
    HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-5000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-5000); });
  const publicBase = `http://127.0.0.1:${publicPort}`, appBase = `http://127.0.0.1:${appPort}`;
  try {
    const rootResponse = await waitForServer(publicBase + '/', child, () => logs, appBase);
    assert.equal(rootResponse.status, 200);
    const csp = rootResponse.headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data:;/);
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /script-src[^;]*data:/);
    const dashboard = await rootResponse.text();
    assert.match(dashboard, /<title>H1kM3sh<\/title>/);
    assert.doesNotMatch(dashboard, /<title>[^<]*录像控制台/);
    assert.match(dashboard, /apple-mobile-web-app-capable/);
    assert.match(dashboard, /console-icon-v2\.svg/);
    assert.match(dashboard, /site-v2\.webmanifest/);
    assert.match(dashboard, /href="\/zl-camera\/console\.css"/);
    assert.match(dashboard, /src="\/zl-camera\/console\.js"/);
    const tunnelConfig = fs.readFileSync(path.join(root, 'deploy/cloudflared.example.yml'), 'utf8');
    assert.ok(tunnelConfig.includes('console-icon(-v1)?\\.png'));
    assert.ok(tunnelConfig.includes('site(-v1)?\\.webmanifest'));
    const tunnelPathPattern = new RegExp(tunnelConfig.split('path: ')[1].split('\n')[0].trim());
    const sampleDvr = '12345678-1234-1234-1234-123456789abc';
    for (const route of ['config', 'cameras', 'mediamtx', 'dvrs', `dvrs/${sampleDvr}`, ...['test', 'snapshot', 'channels', 'segments', 'stream'].map(action => `dvrs/${sampleDvr}/${action}`), 'export/stop']) {
      assert.ok(tunnelPathPattern.test(`/console/api/${route}`), route);
    }
    assert.equal(tunnelPathPattern.test('/api/devices'), false);
    assert.equal(tunnelPathPattern.test(`/console/api/dvrs/${sampleDvr}/arbitrary`), false);

    assert.match(dashboard, /id="boot-view" role="status" aria-live="polite"/);
    assert.match(dashboard, /检查已保存的登录状态/);
    assert.match(dashboard, /id="boot-retry"[^>]*hidden/);
    assert.match(dashboard, /id="auth-view" hidden/);
    assert.match(dashboard, /id="replay-player" muted playsinline webkit-playsinline/);
    assert.match(dashboard, /id="playback-mute"/);
    assert.doesNotMatch(dashboard, /id="replay-player"[^>]*controls/);
    assert.match(dashboard, /id="playback-toggle"/);
    assert.match(dashboard, /id="timeline-overview"/);
    assert.match(dashboard, /id="selection-help"/);
    assert.match(dashboard, /id="scrub-time-overlay"/);
    assert.match(dashboard, /id="playback-source"/);
    assert.match(dashboard, /id="dvr-select"/);
    assert.doesNotMatch(dashboard, /id="date-prev"|id="date-next"/);
    assert.equal((await fetch(publicBase + '/console.css')).status, 200);
    assert.equal((await fetch(publicBase + '/console.js')).status, 200);
    assert.equal((await fetch(publicBase + '/touch-controls.js')).status, 200);
    const uiModule = await fetch(publicBase + '/ui-primitives.js');
    assert.equal(uiModule.status, 200); assert.match(await uiModule.text(), /export function iconSvg/);
    assert.equal((await fetch(publicBase + '/output-player.js')).status, 200);
    assert.equal((await fetch(publicBase + '/output-download.js')).status, 200);
    const replayControlsModule = await fetch(publicBase + '/replay-controls.js');
    assert.equal(replayControlsModule.status, 200);
    assert.match(await replayControlsModule.text(), /export function createReplayControls/);
    const coverageModule = await fetch(publicBase + '/playback-coverage.js');
    assert.equal(coverageModule.status, 200);
    assert.match(await coverageModule.text(), /export function findCoverageGap/);
    const taskPresentationModule = await fetch(publicBase + '/task-presentation.js');
    assert.equal(taskPresentationModule.status, 200);
    assert.match(await taskPresentationModule.text(), /草稿和队列等待不伪装成正在处理/);
    assert.equal((await fetch(publicBase + '/console-icon.png')).status, 200);
    const manifest = await fetch(publicBase + '/site.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json()).display, 'standalone');
    assert.equal((await fetch(publicBase + '/console-icon-v1.png')).status, 200);
    for (const icon of ['console-icon-v2.svg', 'console-icon-v2-192.png', 'console-icon-v2-512.png', 'apple-touch-icon-v2.png']) assert.equal((await fetch(publicBase + '/' + icon)).status, 200);
    const versionedManifest = await fetch(publicBase + '/site-v2.webmanifest');
    assert.equal(versionedManifest.status, 200);
    const manifestData = await versionedManifest.json();
    assert.equal(manifestData.display, 'standalone');
    assert.equal(manifestData.name, 'H1kM3sh');
    assert.equal(manifestData.short_name, 'H1kM3sh');
    assert.equal(manifestData.start_url, './');
    assert.equal(manifestData.scope, './');
    assert.equal(manifestData.icons[0].src, './console-icon-v2-192.png');
    assert.deepEqual(manifestData.icons.map(icon => icon.sizes), ['192x192', '512x512', 'any']);
    const consoleScript = await (await fetch(publicBase + '/console.js')).text();
    assert.match(consoleScript, /new URL\('\.', import\.meta\.url\)/);
    assert.match(consoleScript, /taskProgressPresentation\(task\)/);
    assert.match(consoleScript, /preserveRange: true/);
    assert.match(consoleScript, /console\/api\/dvrs/);
    assert.match(consoleScript, /listCoverageGaps\(state\.segments, state\.inMs, state\.outMs\)/);
    assert.doesNotMatch(consoleScript, /selection-gap-warning/);
    assert.match(consoleScript, /function prefersStandardMp4\(\)/);
    assert.match(consoleScript, /function handlePlaybackError\(\)/);
    assert.match(consoleScript, /function showScrubTime\(ms, context = ''\)/);
    assert.equal((await request(publicBase, '/console/api/bootstrap')).status, 401);
    assert.equal((await request(publicBase, '/console/api/cache')).status, 401);
    assert.equal((await request(publicBase, '/console/api/export/stop', { method: 'POST', origin, body: { taskId: 'missing' } })).status, 401);
    assert.equal((await request(publicBase, `/console/api/dvrs/${dvrId}/channels`)).status, 401);
    assert.equal((await request(publicBase, '/api/devices')).status, 404);

    const setupResponse = await request(publicBase, '/console/api/setup', { method: 'POST', origin, body: { code: setup.code, password: 'camera-short-pass' } });
    assert.equal(setupResponse.status, 200);
    const login = await request(publicBase, '/status/login', { method: 'POST', origin, body: { password: 'camera-short-pass' } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await request(publicBase, '/console/api/export/stop', { method: 'POST', cookie, origin: 'https://other.example', body: { taskId: 'missing' } })).status, 403);
    assert.equal((await request(publicBase, '/console/api/export/stop', { method: 'POST', cookie, origin, body: { taskId: 'missing' } })).status, 404);

    const bootstrap = await (await request(publicBase, '/console/api/bootstrap', { cookie })).json();
    assert.deepEqual(bootstrap.cameras, [{ id: 'D2', name: 'D2', dvrId, dvrName: 'DVR1', channel: '201' }]);
    assert.deepEqual(bootstrap.dvrs, [{ id: dvrId, name: 'DVR1' }]);
    assert.doesNotMatch(JSON.stringify({ cameras: bootstrap.cameras, dvrs: bootstrap.dvrs }), /192\.0\.2\.20|test-user|test-password/);
    assert.match(bootstrap.configRevision, /^[a-f0-9]{64}$/);
    const initialConfig = await (await request(publicBase, '/console/api/config', { cookie })).json();
    assert.equal(bootstrap.configRevision, initialConfig.revision);
    // A same-ID endpoint change in another session must invalidate playback's
    // initial configuration baseline without exposing endpoints or credentials.
    const devicesPath = path.join(dataDir, 'devices.json'), savedDevices = fs.readFileSync(devicesPath, 'utf8');
    try {
      const changedDevices = JSON.parse(savedDevices); changedDevices.devices[0].ip = '192.0.2.21';
      fs.writeFileSync(devicesPath, JSON.stringify(changedDevices));
      const changedBootstrap = await (await request(publicBase, '/console/api/bootstrap', { cookie })).json();
      const changedConfig = await (await request(publicBase, '/console/api/config', { cookie })).json();
      assert.notEqual(changedBootstrap.configRevision, bootstrap.configRevision);
      assert.equal(changedBootstrap.configRevision, changedConfig.revision);
      assert.deepEqual(changedBootstrap.dvrs, bootstrap.dvrs);
      assert.doesNotMatch(JSON.stringify(changedBootstrap), /192\.0\.2\.21|test-user|test-password/);
    } finally { fs.writeFileSync(devicesPath, savedDevices); }
    assert.ok(bootstrap.outputs.some(file => file.filename === 'recording.mp4'));
    assert.equal((await request(publicBase, '/console/api/playback/D1/segments?date=2026-09-27', { cookie })).status, 404);
    const segments = await request(publicBase, '/console/api/playback/D2/segments?date=2026-09-27', { cookie });
    assert.equal(segments.status, 200); assert.equal(requestedMediaPath, 'mediamtx-d2');
    assert.deepEqual((await segments.json()).segments, [{ start: '2026-09-27T04:00:00.000Z', duration: 90 }]);
    const playback = await request(publicBase, '/console/api/playback/D2/stream?start=2026-09-27T04%3A00%3A00.000Z&duration=3', { cookie });
    assert.equal(playback.status, 200); assert.equal(await playback.text(), 'fake-fmp4'); assert.equal(requestedMediaPath, 'mediamtx-d2');
    assert.equal(requestedMediaFormat, 'fmp4');
    const safariPlayback = await request(publicBase, '/console/api/playback/D2/stream?start=2026-09-27T04%3A00%3A00.000Z&duration=3&format=mp4', { cookie });
    assert.equal(safariPlayback.status, 200); assert.equal(requestedMediaFormat, 'mp4');
    assert.deepEqual(Buffer.from(await safariPlayback.arrayBuffer()), previewBytes);
    const previewUrl = '/console/api/playback/D2/stream?start=2026-09-27T04%3A00%3A00.000Z&duration=3&format=mp4';
    assert.equal((await request(publicBase, previewUrl)).status, 401);
    assert.equal((await request(publicBase, previewUrl, { method: 'HEAD' })).status, 401);
    const head = await request(publicBase, previewUrl, { method: 'HEAD', cookie });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(previewBytes.length));
    const probe = await request(publicBase, previewUrl, { cookie, headers: { Range: 'bytes=0-1' } });
    assert.equal(probe.status, 206); assert.equal(probe.headers.get('accept-ranges'), 'bytes');
    assert.equal(probe.headers.get('content-range'), `bytes 0-1/${previewBytes.length}`);
    assert.deepEqual(Buffer.from(await probe.arrayBuffer()), previewBytes.subarray(0, 2));
    assert.equal((await request(publicBase, previewUrl, { cookie, headers: { Range: 'bytes=999999999-' } })).status, 416);
    assert.equal((await request(publicBase, previewUrl.replace('duration=3', 'duration=31'), { cookie })).status, 400);
    assert.equal((await request(publicBase, '/playback-preview/anything.mp4', { cookie })).status, 404);
    assert.equal(fs.readdirSync(path.join(dataDir, 'playback-preview')).length, 1);

    assert.equal((await request(publicBase, `/console/api/dvrs/${dvrId}/segments?date=invalid&channel=201`, { cookie })).status, 400);
    assert.equal((await request(publicBase, `/console/api/dvrs/${dvrId}/stream?channel=201&start=2026-09-27T04%3A00%3A00.000Z&duration=999999`, { cookie })).status, 400);

    const outputId = Buffer.from('recording.mp4').toString('base64url');
    const ranged = await request(publicBase, `/console/api/outputs/${outputId}/stream`, { cookie, headers: { Range: 'bytes=1-3' } });
    assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'bcd');
    assert.match(ranged.headers.get('content-disposition'), /^inline;/);
    const attachment = await request(publicBase, `/console/api/outputs/${outputId}/stream?download=1`, { cookie, headers: { Range: 'bytes=1-3' } });
    assert.equal(attachment.status, 206); assert.equal(await attachment.text(), 'bcd');
    assert.match(attachment.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''recording\.mp4$/);
    const uploadSettings = await (await request(publicBase, '/console/api/settings', { cookie })).json();
    assert.equal(uploadSettings.integrations.bilibiliAuthState, 'unverified');
    assert.equal((await request(publicBase, '/console/api/settings', { method: 'PUT', cookie, origin, headers: { 'x-csrf-token': uploadSettings.csrfToken }, body: { bilibiliTitlePrefix: '测试', bilibiliExtraTags: ['集锦'] } })).status, 400);
    const bili = await request(publicBase, `/console/api/outputs/${outputId}/upload/bilibili`, { method: 'POST', cookie, origin, body: {} });
    assert.equal(bili.status, 202);
    const biliJob = (await bili.json()).job;
    assert.deepEqual({ tid: biliJob.tid, tags: biliJob.tags, onlySelf: biliJob.onlySelf, collectionName: biliJob.collectionName },
      { tid: 249, tags: ['足球'], onlySelf: true, collectionName: '足球' });
    assert.equal(biliJob.title, 'recording');
    assert.equal((await request(publicBase, `/console/api/outputs/${outputId}/upload/bilibili`, { method: 'POST', cookie, origin, body: {} })).status, 409);
    assert.equal((await request(publicBase, `/console/api/outputs/${outputId}`, { method: 'PUT', cookie, origin, body: { newName: 'renamed.mp4' } })).status, 409);
    assert.equal((await request(publicBase, `/console/api/outputs/${outputId}`, { method: 'DELETE', cookie, origin })).status, 409);
    const biliJobFile = path.join(downloadsDir, 'biliup_work', 'jobs', `${biliJob.id}.json`);
    // Exact worker-shaped evidence must survive disk -> protected HTTP -> presentation.
    const measured = { ...biliJob, status: 'uploading', stage: 'uploading', stagePercent: 50, progress: 50,
      progressUnit: 'bytes', uploadedBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024,
      uploadSpeed: 512 * 1024, progressUpdatedAt: Date.now() };
    fs.writeFileSync(biliJobFile, JSON.stringify(measured));
    const liveUpload = (await (await request(publicBase, '/console/api/tasks', { cookie })).json()).uploads.find(job => job.id === biliJob.id);
    assert.equal(liveUpload.stage, 'uploading'); assert.equal(liveUpload.totalBytes, 2 * 1024 * 1024);
    assert.equal(taskProgressPresentation(liveUpload).percent, 50);
    assert.match(uploadProgressCaption(liveUpload), /50%.*1\.0 MiB \/ 2\.0 MiB.*512\.0 KiB\/s/);
    fs.writeFileSync(biliJobFile, JSON.stringify({ ...measured, stage: 'submitting', stagePercent: null, uploadSpeed: null }));
    const submitting = (await (await request(publicBase, '/console/api/tasks', { cookie })).json()).uploads.find(job => job.id === biliJob.id);
    assert.equal(taskProgressPresentation(submitting).hasPercent, false);
    assert.match(uploadProgressCaption(submitting), /等待稿件确认/);
    fs.writeFileSync(biliJobFile, JSON.stringify({ ...biliJob, status: 'completed' }));

    const savedSettings = await request(publicBase, '/console/api/settings', { method: 'PUT', cookie, origin, headers: { 'x-csrf-token': uploadSettings.csrfToken }, body: { cloud189TargetPath: '/H1kM3sh' } });
    assert.equal(savedSettings.status, 200); assert.equal((await savedSettings.json()).settings.cloud189TargetPath, '/H1kM3sh');
    const cloud = await request(publicBase, `/console/api/outputs/${outputId}/upload/cloud189`, { method: 'POST', cookie, origin, body: {} });
    assert.equal(cloud.status, 202);
    const cloudJob = (await cloud.json()).job; assert.equal(cloudJob.targetPath, '/H1kM3sh');
    assert.equal((await request(publicBase, `/console/api/outputs/${outputId}/upload/bilibili`, { method: 'POST', cookie, origin, body: {} })).status, 409);
    assert.equal((await request(publicBase, `/console/api/outputs/${outputId}`, { method: 'DELETE', cookie, origin })).status, 409);
    const cloudJobFile = path.join(downloadsDir, 'cloud189_work', 'jobs', `${cloudJob.id}.json`);
    fs.writeFileSync(cloudJobFile, JSON.stringify({ ...cloudJob, status: 'completed' }));
    assert.equal((await request(publicBase, `/console/api/outputs/${outputId}`, { method: 'PUT', cookie, origin, body: { newName: 'existing.mp4' } })).status, 409);
    assert.equal((await request(publicBase, `/console/api/outputs/${outputId}`, { method: 'PUT', cookie, origin, body: { newName: '天行者 vs 金茂悦  2026-09-30' } })).status, 200);
    const renamedId = Buffer.from('天行者 vs 金茂悦  2026-09-30.mp4').toString('base64url');
    assert.equal((await request(publicBase, `/console/api/outputs/${renamedId}/stream`, { cookie })).status, 200);
    assert.equal((await request(publicBase, `/console/api/outputs/${renamedId}/recover-rename`, { method: 'POST', cookie, origin })).status, 200);
    assert.equal((await request(publicBase, `/console/api/outputs/${renamedId}`, { method: 'DELETE', cookie, origin })).status, 200);

    const clear = await request(publicBase, '/console/api/cache', { method: 'DELETE', cookie, origin, body: {} });
    assert.equal(clear.status, 200);
    const clearResult = await clear.json(); assert.equal(clearResult.deletedCount, 2);
    assert.equal(fs.existsSync(completeCache), false); assert.equal(fs.existsSync(nestedCache), false); assert.equal(fs.existsSync(partialCache), true);
    const localComplete = path.join(downloadsDir, 'local-complete.hikraw'); fs.writeFileSync(localComplete, 'local'); fs.writeFileSync(localComplete + '.done', '');
    const localClear = await request(appBase, '/api/cache', { method: 'DELETE' });
    assert.equal(localClear.status, 200); assert.equal((await localClear.json()).deletedCount, 1);
    assert.equal(fs.existsSync(localComplete), false); assert.equal(fs.existsSync(partialCache), true);
    const localCache = await (await request(appBase, '/api/cache')).json();
    assert.ok(localCache.files.some(file => file.filename === 'partial.hikraw' && !file.complete));
    assert.equal(localCache.files.some(file => file.filename === 'complete.hikraw'), false);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => mediaServer.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('环境管理密码无需初始化码直接登录，改密提示明确且设置不泄露密码', { timeout: 20_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-console-env-'));
  const appPort = await freePort(), publicPort = await freePort();
  const dataDir = path.join(temp, 'data'), downloadsDir = path.join(temp, 'downloads');
  const password = 'test1234'; // Test-only fixture, never a deployment credential.
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: {
    ...process.env, PORT: String(appPort), NODE_TEST: '1', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0',
    HIKCLIP_PUBLIC_PORT: String(publicPort), HIKCLIP_PUBLIC_BIND: '127.0.0.1',
    HIKCLIP_PUBLIC_BASE_URL: 'https://camera.example.test/h1km3sh',
    HIKCLIP_MCP_TOKEN: 'runtime-test-independent-token-1234567890', HIKCLIP_MCP_TOKEN_FILE: '', HIKCLIP_BASE_URL: '',
    HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: password,
    HIKVISION_DATA_DIR: dataDir, HIKVISION_DOWNLOADS_DIR: downloadsDir,
    HIKVISION_RUNTIME_FILE: path.join(temp, 'runtime.json'), HIKVISION_ARTIFACT_DIR: path.join(temp, 'artifacts'),
    HIKVISION_ARCHIVE_DIR: path.join(temp, 'archive'), HIKVISION_MEDIAMTX_API_URL: '',
    HIKVISION_MEDIAMTX_PLAYBACK_URL: 'http://127.0.0.1:0',
    HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0', HIKVISION_BILIUP_ENABLED: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${publicPort}`, origin = 'https://camera.example.test';
  try {
    await waitForServer(base + '/', child, () => logs, `http://127.0.0.1:${appPort}`);
    assert.deepEqual(await (await request(base, '/console/api/auth')).json(), { configured: true });
    const login = await request(base, '/status/login', { method: 'POST', origin, body: { password } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const bootstrap = await request(base, '/console/api/bootstrap', { cookie });
    assert.equal(bootstrap.status, 200);
    const bootstrapData = await bootstrap.json();
    assert.equal(bootstrapData.passwordManaged, true);
    assert.doesNotMatch(JSON.stringify(bootstrapData), /test1234|pbkdf2:/);
    const settings = await request(base, '/console/api/settings', { cookie });
    assert.equal(settings.status, 200); assert.doesNotMatch(await settings.text(), /test1234|pbkdf2:/);
    const change = await request(base, '/console/api/password', { method: 'POST', cookie, origin, body: { oldPassword: password, password: 'changed123' } });
    assert.equal(change.status, 400); assert.match((await change.json()).error, /HIKCLIP_LOGIN_PASSWORD.*重启/);
    const setup = await request(base, '/console/api/setup', { method: 'POST', origin, body: { code: 'unused', password: 'changed123' } });
    assert.equal(setup.status, 400); assert.match((await setup.json()).error, /HIKCLIP_LOGIN_PASSWORD/);
    assert.equal(fs.existsSync(path.join(dataDir, 'public-console-auth.json')), false);
    assert.doesNotMatch(logs, /test1234|pbkdf2:/);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
