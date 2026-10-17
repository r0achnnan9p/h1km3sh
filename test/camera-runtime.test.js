import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runMedia } from '../lib/media-archive.js';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';

test('真实 HTTP MCP：目录、截图、拼图、视频、下载、并发守卫与取消', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-runtime-test-'));
  let child, playbackServer;
  try {
    const recorder = path.join(directory, 'archive', 'd1');
    fs.mkdirSync(recorder, { recursive: true });
    await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10', '-t', '8',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(recorder, '2026-09-24_20-00-00-000000.mp4')]);
    const catalog = new Map([['d1', [{ start: '2026-09-24T12:00:00.000Z', duration: 8 }]]]);
    const playbackRequests = [];
    playbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://catalog.example.test');
      if (url.pathname !== '/list' || !catalog.has(url.searchParams.get('path'))) { res.writeHead(404); res.end(); return; }
      const start = Date.parse(url.searchParams.get('start')), end = Date.parse(url.searchParams.get('end'));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { res.writeHead(400); res.end(); return; }
      playbackRequests.push({ path: url.searchParams.get('path'), start, end });
      // Playback /list returns intersecting catalog intervals in absolute time;
      // the adapter must clip them to the requested wall-clock selection.
      const rows = catalog.get(url.searchParams.get('path')).filter(row => Date.parse(row.start) < end && Date.parse(row.start) + row.duration * 1000 > start);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(rows));
    });
    playbackServer.listen(0, '127.0.0.1'); await once(playbackServer, 'listening');
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true,
      env: { ...process.env, PORT: String(port), NODE_TEST: '1', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0',
        HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0', HIKVISION_DATA_DIR: path.join(directory, 'data'),
        HIKVISION_RUNTIME_FILE: path.join(directory, 'runtime.json'), HIKVISION_DOWNLOADS_DIR: path.join(directory, 'downloads'), HIKVISION_ARCHIVE_DIR: path.join(directory, 'archive'),
        HIKVISION_MEDIAMTX_API_URL: '', HIKVISION_MEDIAMTX_PLAYBACK_URL: `http://127.0.0.1:${playbackServer.address().port}`, HIKVISION_BILIUP_ENABLED: '0',
        HIKVISION_ARTIFACT_DIR: path.join(directory, 'artifacts'), HIKCLIP_MCP_TOKEN: '', HIKCLIP_MCP_TOKEN_FILE: '',
        HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '', HIKCLIP_BASE_URL: '',
        HIKCLIP_PUBLIC_BASE_URL: '', HIKCLIP_PUBLIC_PORT: '', HIKCLIP_PUBLIC_BIND: '127.0.0.1' }, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    async function request(url, body) {
      const res = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      return { status: res.status, payload: await res.json() };
    }
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await request('/api/runtime-health')).payload.recoveryReady === true) { ready = true; break; } } catch { /* 等待启动与恢复 */ }
      await delay(100);
    }
    assert.ok(ready, '测试服务应启动');
    const secret = 'runtime-fixture-private-password';
    const { payload: added } = await request('/api/devices', { name: 'fixture DVR', ip: '192.0.2.1', username: 'admin', password: secret });
    fs.writeFileSync(path.join(directory, 'data', 'cameras.json'), JSON.stringify({ cameras: [
      { id: 'door', name: '门口', deviceId: added.device.id, channel: '101', archivePath: 'd1' },
    ] }));
    let id = 0;
    async function tool(name, args) {
      const { payload } = await request('/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
      assert.equal(payload.result.isError, false);
      const text = payload.result.content[0].text;
      assert.ok(!text.includes(secret));
      return payload.result.structuredContent || text;
    }
    async function completed(taskId) {
      for (let i = 0; i < 100; i++) {
        const { payload } = await request('/api/status');
        const task = payload.activeTasks.find((item) => item.taskId === taskId);
        if (['completed', 'error', 'cancelled'].includes(task?.status)) return task;
        await delay(50);
      }
      assert.fail('任务未在预期时间内结束');
    }
    assert.deepEqual(JSON.parse(await tool('list_cameras', {})).cameras, [{ id: 'door', name: '门口' }]);
    for (const [name, args] of [
      ['get_video_clip', { camera: '门口', start: '2026-09-24 20:00:01', end: '2026-09-24 20:00:05' }],
      ['get_snapshot', { camera: 'door', datetime: '2026-09-24 20:00:02' }],
      ['create_timeline_sheet', { camera: 'door', date: '2026-09-24', start: '20:00:01', interval: 1, count: 4 }],
    ]) {
      const job = await tool(name, args);
      const task = await completed(job.taskId);
      assert.equal(task.status, 'completed');
      assert.equal(task.source, 'mediamtx');
      const response = await fetch(base + task.artifactUrl);
      assert.equal(response.status, 200);
      assert.ok((await response.arrayBuffer()).byteLength > 1000);
      assert.equal((await tool('get_export_status', { taskId: job.taskId })).artifactUrl, task.artifactUrl);
    }
    const stopped = await request('/api/cameras/timeline', { camera: 'door', date: '2026-09-24', start: '20:00:00', interval: 1, count: 8 });
    await request('/api/export/stop', { taskId: stopped.payload.taskId });
    const cancelled = await completed(stopped.payload.taskId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.artifactUrl, undefined);
    assert.equal((await fetch(base + '/artifacts/.work/private.png')).status, 404);
    assert.equal((await request('/api/cameras/clip', { camera: 'door', start: 'bad', end: 'bad' })).status, 400);
    const gapsDir = path.join(directory, 'archive', 'gaps'); fs.mkdirSync(gapsDir);
    for (const second of ['00', '08']) await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10', '-t', '2',
      '-c:v', 'libx264', '-g', '10', '-bf', '0', path.join(gapsDir, `2026-09-24_21-00-${second}.mp4`)]);
    fs.writeFileSync(path.join(directory, 'data', 'cameras.json'), JSON.stringify({ cameras: [
      { id: 'gap', name: '缺口镜头', deviceId: added.device.id, channel: '201', archivePath: 'gaps' },
    ] }));
    catalog.set('gaps', [
      { start: '2026-09-24T13:00:00.000Z', duration: 2 },
      { start: '2026-09-24T13:00:08.000Z', duration: 2 },
    ]);
    const gapRequest = { source: 'mediamtx', camera: 'gap', start: '2026-09-24 21:00:00', end: '2026-09-24 21:00:10' };
    const before = (await request('/api/status')).payload.activeTasks.length;
    const blocked = await request('/console/api/export', gapRequest);
    assert.equal(blocked.status, 409); assert.equal(blocked.payload.code, 'MEDIAMTX_GAPS');
    assert.equal(blocked.payload.coverage.missingSeconds, 6); assert.equal(blocked.payload.coverage.availableSeconds, 4);
    assert.deepEqual(blocked.payload.coverage.missingIntervals.map(({ start, end }) => [start, end]), [['2026-09-24 21:00:02', '2026-09-24 21:00:08']]);
    assert.deepEqual(playbackRequests.at(-1), { path: 'gaps', start: Date.parse('2026-09-24T13:00:00Z'), end: Date.parse('2026-09-24T13:00:10Z') });
    assert.equal((await request('/api/status')).payload.activeTasks.length, before, 'unaccepted gaps must not enqueue anything');
    const accepted = await request('/console/api/export', { ...gapRequest, acceptGaps: true }); assert.equal(accepted.status, 202);
    const gapTask = await completed(accepted.payload.taskId); assert.equal(gapTask.status, 'completed');
    assert.equal(gapTask.source, 'mediamtx'); assert.equal(gapTask.acceptGaps, true); assert.equal(gapTask.coverage.hasGaps, true);
    assert.equal(gapTask.coverage.requestedSeconds, 10); assert.equal(gapTask.coverage.availableSeconds, 4); assert.match(gapTask.message, /含缺口/);
    const artifactFile = path.join(directory, 'artifacts', gapTask.artifactUrl.replace('/artifacts/', ''));
    const probe = await runMedia(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', artifactFile]);
    const actualSeconds = Number(JSON.parse(probe.stdout).format.duration);
    assert.ok(actualSeconds >= 3.8 && actualSeconds <= 4.3, `gap output must contain retained footage, got ${actualSeconds}`);
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'data', 'export-queue', `${gapTask.taskId}.json`), 'utf8'));
    assert.equal(snapshot.request.forceArchive, true); assert.equal(snapshot.request.args.acceptGaps, true); assert.equal(snapshot.task.coverage.missingSeconds, 6);
    const empty = await request('/console/api/export', { ...gapRequest, start: '2026-09-24 21:00:03', end: '2026-09-24 21:00:07', acceptGaps: true });
    assert.equal(empty.status, 422); assert.equal(empty.payload.code, 'MEDIAMTX_EMPTY');

  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    if (playbackServer) { const closed = new Promise(resolve => playbackServer.close(resolve)); playbackServer.closeAllConnections(); await closed; }
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('camera-runtime-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

