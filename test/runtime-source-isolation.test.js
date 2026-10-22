/** A deployment host may itself run MediaMTX. Tests must never discover its sources. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const repository = path.resolve(import.meta.dirname, '..');

test('runtime fixtures ignore inherited host MediaMTX API, Playback and archive sources', { timeout: 90_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-poison-'));
  const hostArchive = path.join(root, 'host-archive'); fs.mkdirSync(hostArchive);
  for (const name of ['d1', 'd2', 'migration-check', 'wang']) fs.mkdirSync(path.join(hostArchive, name));
  const requests = [];
  const host = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ itemCount: 4, pageCount: 1, items: ['d1', 'd2', 'migration-check', 'wang'].map(name => ({ name })) }));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const hostUrl = `http://127.0.0.1:${host.address().port}`;
  const files = ['camera-runtime', 'public-console-runtime', 'native-listener', 'match-runtime', 'export-queue-http', 'camera-store', 'console-config'];
  const env = { ...process.env,
    HIKVISION_ARCHIVE_DIR: hostArchive, HIKVISION_MEDIAMTX_API_URL: hostUrl, HIKVISION_MEDIAMTX_PLAYBACK_URL: hostUrl,
    HIKCLIP_BIND: '127.0.0.1', HIKCLIP_SCHEDULER_ENABLED: '0',
  };
  // This is a new test runner, not an individual child test dispatched by ours.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', ...files.map(name => `test/${name}.test.js`)], {
    cwd: repository, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-25000); }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-25000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    const closed = new Promise(resolve => host.close(resolve)); host.closeAllConnections(); await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `isolated nested runtime suite failed:\n${output}`);
  assert.match(output, /真实 HTTP MCP/, 'the nested runner must execute actual runtime tests');
  assert.match(output, /profile 0 allows explicit new device configuration/);
  assert.deepEqual(requests, [], 'fixtures must not contact even a reachable host MediaMTX API or Playback endpoint');
  assert.deepEqual(fs.readdirSync(hostArchive).sort(), ['d1', 'd2', 'migration-check', 'wang']);
  for (const name of fs.readdirSync(hostArchive)) assert.deepEqual(fs.readdirSync(path.join(hostArchive, name)), []);
});
