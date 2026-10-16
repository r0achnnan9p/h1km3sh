import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t, env, seed = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-listener-'));
  seed(root);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env,
    HIKVISION_DATA_DIR: path.join(root, 'data'), HIKVISION_DOWNLOADS_DIR: path.join(root, 'downloads'),
    HIKVISION_ARCHIVE_DIR: path.join(root, 'archive'), HIKVISION_ARTIFACT_DIR: path.join(root, 'artifacts'),
    HIKVISION_MEDIAMTX_API_URL: '', HIKVISION_MEDIAMTX_PLAYBACK_URL: 'http://127.0.0.1:0',
    HIKVISION_RUNTIME_FILE: path.join(root, 'runtime.json'), HIKCLIP_PUBLIC_PORT: '', HIKCLIP_PUBLIC_BASE_URL: '',
    HIKCLIP_MCP_TOKEN: '', HIKCLIP_MCP_TOKEN_FILE: '', HIKCLIP_STATUS_PASSWORD_HASH: '', HIKCLIP_LOGIN_PASSWORD: '',
    HIKCLIP_PREPARATION_ONLY: '0', HIKVISION_BILIUP_ENABLED: '0', HIKCLIP_BIND: '127.0.0.1', HIKCLIP_SCHEDULER_ENABLED: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } fs.rmSync(root, { recursive: true, force: true }); });
  return { child, root, output: () => output };
}
test('production occupied main port exits without fallback or runtime publication', async t => {
  const busy = net.createServer().listen(0, '127.0.0.1'); await once(busy, 'listening');
  t.after(() => new Promise(resolve => busy.close(resolve)));
  const app = await fixture(t, { PORT: String(busy.address().port), NODE_ENV: 'production', HIKCLIP_PORT_FALLBACK: '' });
  const [code] = await once(app.child, 'exit');
  assert.equal(code, 1); assert.match(app.output(), /已被占用/); assert.doesNotMatch(app.output(), /尝试 \d/);
  assert.equal(fs.existsSync(path.join(app.root, 'runtime.json')), false);
});
test('loopback server starts with scheduler disabled and exposes matching runtime identity', async t => {
  const reserve = net.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const app = await fixture(t, { PORT: String(port), HIKCLIP_PORT_FALLBACK: '0', HIKCLIP_RELEASE_SHA: 'a'.repeat(40) });
  let identity;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/runtime-health`); if (response.ok) { identity = await response.json(); if (identity.recoveryReady) break; } } catch { /* wait for recovery, not just listener */ }
    await delay(50);
  }
  assert.ok(identity?.recoveryReady, app.output());
  assert.deepEqual(identity, { pid: app.child.pid, release: 'a'.repeat(40), preparationOnly: false, recoveryReady: true });
  assert.doesNotMatch(app.output(), /局域网|定时导出/);
  // Disabled scheduler must not even seed its enabled-by-default schedule.
  assert.equal(fs.existsSync(path.join(app.root, 'data', 'schedules.json')), false);
});

async function launchOnFreePort(t, env, seed, { expectBlocked = false } = {}) {
  const reserve = net.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const app = await fixture(t, { PORT: String(port), HIKCLIP_PORT_FALLBACK: '0', ...env }, seed);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/api/runtime-health`);
      if (response.ok) {
        const identity = await response.json();
        // A pending listener is neither successful recovery nor an observed failure.
        if (identity.recoveryReady || (expectBlocked && /无法读取导出恢复队列/.test(app.output()))) return { ...app, base, identity };
      }
    } catch { /* wait for a terminal recovery outcome */ }
    await delay(50);
  }
  assert.fail(app.output());
}
for (const mode of ['1', '0']) test(`profile ${mode} ${mode === '1' ? 'blocks' : 'allows'} explicit new device configuration`, async t => {
  const app = await launchOnFreePort(t, { HIKCLIP_PREPARATION_ONLY: mode });
  assert.equal(app.identity.preparationOnly, mode === '1');
  const response = await fetch(`${app.base}/api/devices`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'fixture', ip: '192.0.2.1', username: 'fixture', password: 'fixture-password' }) });
  assert.equal(response.status, mode === '1' ? 409 : 200);
  if (mode === '1') {
    assert.match((await response.json()).error, /HIKCLIP_PREPARATION_ONLY/);
    assert.equal(fs.existsSync(path.join(app.root, 'data/devices.json')), false);
  }
});
test('runtime health reports actual export recovery blockage', async t => {
  const app = await launchOnFreePort(t, { HIKCLIP_PREPARATION_ONLY: '0' }, root => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/export-queue'), 'not-a-directory');
  }, { expectBlocked: true });
  assert.equal(app.identity.recoveryReady, false);
});

test('preparation device gate follows Express route aliases without encoded-path bypass', async t => {
  const app = await launchOnFreePort(t, { HIKCLIP_PREPARATION_ONLY: '1' });
  const body = JSON.stringify({ name: 'fixture', ip: '192.0.2.1', username: 'fixture', password: 'fixture-password' });
  for (const [method, route, status] of [
    ['POST', '/API/devices', 409], ['POST', '/Api/DeViCeS/', 409],
    ['POST', '/API/DEVICES?alias=1', 409], ['PUT', '/API/DeViCeS/fixture', 409],
    ['PUT', '/API/DeViCeS/fixture/ACTIVATE', 409],
    ['POST', '/api/dev%69ces', 404], ['POST', '/api%2fdevices', 404],
    ['POST', '/api/devices%2f', 404],
  ]) {
    const response = await fetch(app.base + route, { method, headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status, `${method} ${route}`);
  }
  assert.equal(fs.existsSync(path.join(app.root, 'data/devices.json')), false);
});
