/** Real console admission + queue, with a local catalog and controllable synthetic file probes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('HTTP gap preflight is fast, disconnected requests never enter the queue, and accepted file checks remain cancellable', { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-gap-http-'));
  let child, catalog, catalogMode = 'partial', heldResponse;
  const sockets = new Set();
  try {
    const data = path.join(dir, 'data'), archive = path.join(dir, 'archive', 'archive-a');
    fs.mkdirSync(data); fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(data, 'cameras.json'), JSON.stringify({ cameras: [{ id: 'camera-a', name: 'Camera A', archivePath: 'archive-a' }] }));
    fs.writeFileSync(path.join(archive, '2026-01-01_10-00-00.mp4'), 'synthetic recording');
    catalog = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://catalog.example');
      if (url.pathname !== '/list') { res.writeHead(404); res.end(); return; }
      assert.equal(url.searchParams.get('path'), 'archive-a');
      if (catalogMode === 'hold') { heldResponse = res; res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); return; }
      if (catalogMode === 'error') { res.writeHead(500); res.end('private upstream fixture'); return; }
      const start = Date.parse(url.searchParams.get('start'));
      const rows = catalogMode === 'empty' ? [] : catalogMode === 'complete'
        ? [{ start: new Date(start).toISOString(), duration: 60 }]
        : [{ start: new Date(start).toISOString(), duration: 20 }, { start: new Date(start + 30_000).toISOString(), duration: 30 }];
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(rows));
    });
    catalog.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve));

    const realArchive = pathToFileURL(path.join(root, 'lib/media-archive.js')).href;
    const mock = path.join(dir, 'archive.mjs');
    fs.writeFileSync(mock, `
      export * from ${JSON.stringify(realArchive + '?actual')};
      import { createMediaArchive as actual } from ${JSON.stringify(realArchive + '?actual')};
      import fs from 'node:fs'; import path from 'node:path';
      const dir = ${JSON.stringify(dir)};
      const log = value => fs.appendFileSync(path.join(dir, 'probes'), JSON.stringify(value) + '\\n');
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      export function createMediaArchive(options = {}) {
        return actual({ ...options, run: async (_binary, args, { signal }) => {
          if (!args.includes('format=duration')) throw new Error('test must never produce a video');
          log({ phase: 'started', file: path.basename(args.at(-1)) });
          while (!signal.aborted && !fs.existsSync(path.join(dir, 'probe-mode'))) await delay(10);
          if (signal.aborted) { log({ phase: 'cancelled' }); throw new Error('cancelled fixture probe'); }
          log({ phase: 'finished' });
          return { stdout: JSON.stringify({ format: { duration: 20 } }) };
        } });
      }
    `);
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(loader, `export async function resolve(specifier, context, next) {
      const result = await next(specifier, context);
      return result.url === ${JSON.stringify(realArchive)} ? { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true } : result;
    }`);
    const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    child = spawn(process.execPath, ['--loader', loader, 'server.js'], { cwd: root, env: { ...process.env,
      PORT: String(port), NODE_TEST: '1', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_PORT_FALLBACK: '0',
      HIKCLIP_SCHEDULER_ENABLED: '0', HIKCLIP_PREPARATION_ONLY: '0', HIKVISION_DATA_DIR: data,
      HIKVISION_DOWNLOADS_DIR: path.join(dir, 'downloads'), HIKVISION_ARTIFACT_DIR: path.join(dir, 'artifacts'),
      HIKVISION_ARCHIVE_DIR: path.join(dir, 'archive'), HIKVISION_MEDIAMTX_API_URL: '',
      HIKVISION_MEDIAMTX_PLAYBACK_URL: `http://127.0.0.1:${catalog.address().port}`,
      HIKVISION_RUNTIME_FILE: path.join(dir, 'runtime.json'), HIKCLIP_PUBLIC_BASE_URL: '', HIKCLIP_PUBLIC_PORT: '',
      HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '', HIKCLIP_BASE_URL: '', HIKCLIP_PUBLIC_BIND: '127.0.0.1',
      HIKVISION_BILIUP_ENABLED: '0', HIKVISION_CLOUD189_ENABLED: '0', HIKCLIP_MANAGED_UPLOADS_ENABLED: '0',
      HIKCLIP_MCP_TOKEN: '', HIKCLIP_MCP_TOKEN_FILE: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
    const base = `http://127.0.0.1:${port}`;
    async function request(url, payload, signal = AbortSignal.timeout(5_000)) {
      const response = await fetch(base + url, { signal, ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
      return { status: response.status, value: await response.json() };
    }
    async function until(check) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const result = await check(); if (result) return result;
        if (child.exitCode !== null) throw new Error(logs); await delay(10);
      }
      throw new Error('condition did not settle: ' + logs);
    }
    const allTasks = async () => (await request('/console/api/tasks')).value.tasks;
    const task = async id => (await allTasks()).find(item => item.taskId === id);
    const probes = () => fs.existsSync(path.join(dir, 'probes')) ? fs.readFileSync(path.join(dir, 'probes'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    await until(async () => { try { return (await request('/api/runtime-health')).value.recoveryReady === true; } catch { return false; } });
    const payload = { source: 'mediamtx', camera: 'camera-a', start: '2026-01-01 10:00:00', end: '2026-01-01 10:01:00' };

    const denied = await request('/console/api/export', { ...payload, coverage: { complete: true } });
    assert.equal(denied.status, 409); assert.equal(denied.value.code, 'MEDIAMTX_GAPS');
    assert.deepEqual(denied.value.coverage.missingIntervals.map(({ start, end }) => [start, end]), [['2026-01-01 10:00:20', '2026-01-01 10:00:30']]);
    assert.equal((await allTasks()).length, 0); assert.equal(probes().length, 0);

    catalogMode = 'hold';
    const controller = new AbortController();
    const disconnected = request('/console/api/export', { ...payload, acceptGaps: true }, controller.signal);
    const rejected = assert.rejects(disconnected, { name: 'AbortError' });
    await until(() => heldResponse); controller.abort(); await rejected;
    await until(() => heldResponse.destroyed);
    assert.equal((await allTasks()).length, 0, 'a cancelled directory preflight must not admit a hidden task');
    assert.equal(probes().length, 0);

    catalogMode = 'partial';
    const accepted = await request('/console/api/export', { ...payload, acceptGaps: true });
    assert.equal(accepted.status, 202); assert.ok(accepted.value.taskId);
    await until(() => probes().some(probe => probe.phase === 'started'));
    const checking = await task(accepted.value.taskId);
    assert.match(checking.message, /核验所选时段的录像文件/); assert.equal(checking.progress, null);
    assert.equal(fs.existsSync(path.join(dir, 'probe-mode')), false, 'HTTP returns while real file verification is still pending');
    const duplicate = await request('/console/api/export', { ...payload, acceptGaps: true });
    assert.equal(duplicate.value.taskId, accepted.value.taskId);
    assert.equal((await allTasks()).length, 1, 'accepted repeated clicks share one queued/executing task');
    assert.equal(probes().filter(probe => probe.phase === 'started').length, 1);
    await request('/console/api/export/stop', { taskId: accepted.value.taskId });
    await until(async () => (await task(accepted.value.taskId)).status === 'cancelled');
    assert.equal(probes().filter(probe => probe.phase === 'cancelled').length, 1);

    catalogMode = 'complete'; fs.writeFileSync(path.join(dir, 'probe-mode'), 'short');
    fs.writeFileSync(path.join(archive, '2026-01-01_10-02-00.mp4'), 'synthetic shorter recording');
    const changedFiles = await request('/console/api/export', { ...payload, start: '2026-01-01 10:02:00', end: '2026-01-01 10:03:00' });
    assert.equal(changedFiles.status, 202);
    const failed = await until(async () => { const current = await task(changedFiles.value.taskId); return current?.status === 'error' ? current : null; });
    assert.equal(failed.failureCode, 'MEDIAMTX_GAPS'); assert.equal(failed.coverage.missingSeconds, 40);
    assert.equal((await request('/console/api/bootstrap')).value.outputs.length, 0, 'invalid footage must not publish a video');

    catalogMode = 'empty';
    const empty = await request('/console/api/export', { ...payload, acceptGaps: true });
    assert.equal(empty.status, 422); assert.equal(empty.value.code, 'MEDIAMTX_EMPTY');
    catalogMode = 'error';
    const unavailable = await request('/console/api/export', payload);
    assert.equal(unavailable.status, 502); assert.match(unavailable.value.error, /无法核验/);
    assert.equal(JSON.stringify(unavailable.value).includes('private'), false);
    assert.equal((await allTasks()).length, 2);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    for (const socket of sockets) socket.destroy();
    if (catalog) await new Promise(resolve => catalog.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
