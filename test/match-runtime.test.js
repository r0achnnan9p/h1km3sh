import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runMedia } from '../lib/media-archive.js';
import { ffmpegPath } from '../lib/ffmpeg-paths.js';

test('disabled Biliup blocks legacy prepare and an existing draft even with a ready worker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-disabled-'));
  const downloads = path.join(root, 'downloads'), jobs = path.join(downloads, 'biliup_work', 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(downloads, 'fixture.mp4'), 'synthetic-video');
  fs.writeFileSync(path.join(downloads, 'biliup_work', 'worker-status.json'), JSON.stringify({
    checkedAt: Date.now() / 1000, binaryAvailable: true, credentialsPresent: true, coverAvailable: true,
  }));
  const id = '11111111-1111-4111-8111-111111111111', draft = { id, status: 'draft' };
  const jobFile = path.join(jobs, `${id}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(draft));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore', env: {
    ...process.env, PORT: String(port), NODE_TEST: '1', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0', HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0',
    HIKVISION_DATA_DIR: path.join(root, 'data'), HIKVISION_DOWNLOADS_DIR: downloads,
    HIKVISION_RUNTIME_FILE: path.join(root, 'runtime.json'), HIKVISION_ARTIFACT_DIR: path.join(root, 'artifacts'), HIKVISION_ARCHIVE_DIR: path.join(root, 'archive'),
    HIKVISION_MEDIAMTX_API_URL: '', HIKVISION_MEDIAMTX_PLAYBACK_URL: 'http://127.0.0.1:0',
    HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '', HIKCLIP_BASE_URL: '', HIKCLIP_PUBLIC_BIND: '127.0.0.1',
    HIKCLIP_MCP_TOKEN: '', HIKCLIP_MCP_TOKEN_FILE: '', HIKCLIP_PUBLIC_BASE_URL: '', HIKCLIP_PUBLIC_PORT: '', HIKVISION_BILIUP_ENABLED: '0',
  } });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) { try { ready = (await (await fetch(base + '/api/runtime-health')).json()).recoveryReady === true; } catch {} if (ready) break; await delay(100); }
  assert.ok(ready);
  for (const [endpoint, body] of [
    ['prepare', { filename: 'fixture.mp4', title: 'fixture' }],
    ['submit', { id, confirmed: true }],
  ]) {
    const response = await fetch(base + `/api/bilibili/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /worker.*尚未就绪/);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(jobFile, 'utf8')), draft);
  assert.deepEqual(fs.readdirSync(jobs), [`${id}.json`]);
});

test('真实 HTTP：双镜头全部交付、固定私密投稿草稿、自动结果页与持久化恢复', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'match-runtime-')); let child;
  try {
    for (const [id, color] of [['D1', 'red'], ['D2', 'blue']]) {
      const dir = path.join(root, 'archive', id); fs.mkdirSync(dir, { recursive: true });
      await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=10`, '-t', '5', '-c:v', 'libx264', '-g', '10', '-bf', '0', path.join(dir, '2026-09-24_20-20-00.mp4')]);
    }
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(r => listener.close(r));
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore', env: {
      ...process.env, PORT: String(port), NODE_TEST: '1', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0', HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0',
      HIKVISION_DATA_DIR: path.join(root, 'data'), HIKVISION_DOWNLOADS_DIR: path.join(root, 'downloads'),
      HIKVISION_RUNTIME_FILE: path.join(root, 'runtime.json'), HIKVISION_ARTIFACT_DIR: path.join(root, 'artifacts'), HIKVISION_ARCHIVE_DIR: path.join(root, 'archive'),
      HIKVISION_MEDIAMTX_API_URL: '', HIKVISION_MEDIAMTX_PLAYBACK_URL: 'http://127.0.0.1:0',
      HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '', HIKCLIP_BASE_URL: '', HIKCLIP_PUBLIC_BIND: '127.0.0.1',
      HIKCLIP_MCP_TOKEN: '', HIKCLIP_MCP_TOKEN_FILE: '', HIKCLIP_PUBLIC_BASE_URL: '', HIKCLIP_PUBLIC_PORT: '', HIKVISION_BILIUP_ENABLED: '1',
    } });
    const base = `http://127.0.0.1:${port}`;
    async function api(url, body) {
      const response = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      return { status: response.status, body: await response.json() };
    }
    let ready = false;
    for (let i = 0; i < 60; i++) { try { ready = (await api('/api/runtime-health')).body.recoveryReady === true; } catch {} if (ready) break; await delay(100); }
    assert.ok(ready);
    const device = (await api('/api/devices', { ip: '192.0.2.1', username: 'fixture', password: 'private-fixture' })).body.device;
    fs.writeFileSync(path.join(root, 'data', 'cameras.json'), JSON.stringify({ cameras: ['D1', 'D2'].map((id, index) => ({ id, name: id, deviceId: device.id, channel: `${index + 1}01`, archivePath: id })) }));
    const request = { cameras: ['D1', 'D2'], start: '2026-09-24 20:20:01', end: '2026-09-24 20:20:04', matchup: '天行者 队内' };
    const first = await api('/api/cameras/match', request);
    const sameInFlight = await api('/api/cameras/match', request);
    assert.equal(sameInFlight.body.taskId, first.body.taskId, '同一进行中请求应复用任务，而非提前宣称文件完成');
    const response = await api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_match_videos', arguments: request } });
    const result = response.body.result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.taskId, first.body.taskId);
    assert.equal(result.structuredContent.status, 'completed');
    assert.deepEqual(result.structuredContent.files.map(f => f.filename).sort(), ['天行者 队内 D1 2026-09-24.mp4', '天行者 队内 D2 2026-09-24.mp4']);
    for (const file of result.structuredContent.files) assert.ok(fs.statSync(path.join(root, 'downloads', file.filename)).size > 1000);
    const taskId = result.structuredContent.taskId;
    const json = await api(`/media-jobs/${taskId}?format=json`);
    assert.equal(json.body.files.length, 2);
    assert.ok((await (await fetch(base + `/media-jobs/${taskId}`)).text()).includes('setTimeout(refresh,3000)'));
    const draftInput = { filename: result.structuredContent.files[0].filename, title: '天行者 队内', tid: 171, tags: ['错误'], onlySelf: false };
    const workerDir = path.join(root, 'downloads', 'biliup_work');
    const workerFile = path.join(workerDir, 'worker-status.json');
    assert.equal((await api('/api/bilibili/prepare', draftInput)).status, 400, '没有 worker 时旧 API 也不能创建投稿草稿');
    fs.mkdirSync(workerDir, { recursive: true });
    const readyWorker = () => ({ checkedAt: Date.now() / 1000, binaryAvailable: true, credentialsPresent: true, coverAvailable: true });
    fs.writeFileSync(workerFile, JSON.stringify(readyWorker()));
    const draft = (await api('/api/bilibili/prepare', draftInput)).body.job;
    assert.equal(draft.status, 'draft'); assert.equal(draft.tid, 249); assert.deepEqual(draft.tags, ['足球']); assert.equal(draft.onlySelf, true);
    for (const observation of [
      { ...readyWorker(), checkedAt: Date.now() / 1000 - 151 },
      { ...readyWorker(), checkedAt: Date.now() / 1000 + 60 },
      { ...readyWorker(), binaryAvailable: false },
      { ...readyWorker(), credentialsPresent: false },
      { ...readyWorker(), coverAvailable: false },
      { ...readyWorker(), binaryAvailable: 'true' },
      null,
    ]) {
      if (observation) fs.writeFileSync(workerFile, JSON.stringify(observation));
      else fs.unlinkSync(workerFile);
      assert.equal((await api('/api/bilibili/prepare', draftInput)).status, 400, 'prepare 必须每次重读 worker 就绪状态');
      const blocked = await api('/api/bilibili/submit', { id: draft.id, confirmed: true });
      assert.equal(blocked.status, 400, '草稿建立后 worker 失效也不能提交');
      assert.match(blocked.body.error, /worker.*尚未就绪/);
      assert.equal((await api(`/api/bilibili/status/${draft.id}`)).body.job.status, 'draft', '拒绝提交不能改变草稿');
    }
    fs.writeFileSync(workerFile, JSON.stringify(readyWorker()));
    assert.equal((await api('/api/bilibili/submit', { id: draft.id, confirmed: false })).status, 400, 'worker 就绪不能绕过明确确认');
    const submitted = await api('/api/bilibili/submit', { id: draft.id, confirmed: true });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.job.status, 'queued');
    assert.equal((await api('/api/bilibili/submit', { id: draft.id, confirmed: true })).body.job.id, draft.id, '重复提交不新建任务');
    assert.equal(JSON.stringify(result).includes('private-fixture'), false);
    assert.ok(fs.existsSync(path.join(root, 'data', 'media-jobs', `${taskId}.json`)));
    const original = new Map(result.structuredContent.files.map(file => [file.filename, file]));
    for (const camera of ['D1', 'D2']) {
      const single = await api('/mcp', { jsonrpc: '2.0', id: camera, method: 'tools/call', params: { name: 'get_video_clip', arguments: {
        camera, start: request.start, end: request.end,
      } } });
      assert.equal(single.body.result.structuredContent.status, 'completed');
      assert.equal(new URL(single.body.result.structuredContent.artifactUrl, base).pathname,
        new URL(original.get(`天行者 队内 ${camera} 2026-09-24.mp4`).artifactUrl, base).pathname,
        '逐个调用单镜头工具也应复用已有全场成品');
    }
    const legacy = await api('/api/export', {
      ip: device.ip, user: 'fixture', pass: 'private-fixture', channel: '101',
      startTime: '20260924T202001Z', endTime: '20260924T202004Z', method: 'mp4download',
    });
    assert.equal(legacy.body.reused, true, JSON.stringify(legacy));
    assert.equal(legacy.body.filename, '天行者 队内 D1 2026-09-24.mp4');
    assert.equal((await api('/api/status')).body.activeTasks.find(task => task.taskId === legacy.body.taskId).status, 'completed');
    const reused = await api('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_match_videos', arguments: request } });
    assert.equal(reused.body.result.structuredContent.status, 'completed');
    assert.deepEqual(reused.body.result.structuredContent.files.map(file => new URL(file.artifactUrl, base).pathname), result.structuredContent.files.map(file => new URL(file.artifactUrl, base).pathname));
    const changedRange = await api('/api/cameras/match', { ...request, start: '2026-09-24 20:20:02' });
    assert.equal(changedRange.status, 409, '同名但时间不同不能误用旧成品');
    const d1 = original.get('天行者 队内 D1 2026-09-24.mp4');
    fs.unlinkSync(path.join(root, 'downloads', d1.filename));
    const partial = await api('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_match_videos', arguments: request } });
    assert.equal(partial.body.result.structuredContent.status, 'completed');
    assert.equal(new URL(partial.body.result.structuredContent.files.find(f => f.camera === 'D2').artifactUrl, base).pathname, new URL(original.get('天行者 队内 D2 2026-09-24.mp4').artifactUrl, base).pathname);
    assert.notEqual(new URL(partial.body.result.structuredContent.files.find(f => f.camera === 'D1').artifactUrl, base).pathname, new URL(d1.artifactUrl, base).pathname);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
