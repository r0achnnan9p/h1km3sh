/** Real local processes and flock only. No DVR, media binaries, or external services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { acquireKernelExportLease, spawnExportProcess } from '../lib/export-process-lock.js';
import { runMedia } from '../lib/media-archive.js';

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../lib/export-process-lock.js')).href;
const linux = process.platform === 'linux';
const options = { skip: linux ? false : 'Kernel flock behavior is tested on Linux', timeout: 15_000 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'export-kernel-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function contender(directory) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireKernelExportLease } from ${JSON.stringify(moduleUrl)};
    try { const release = acquireKernelExportLease(${JSON.stringify(directory)}); console.log('acquired'); release(); }
    catch (error) { console.log(error.code); process.exitCode = 2; }
  `], { encoding: 'utf8', timeout: 5000 });
}

async function waitFile(file, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Fixture owner exited before readiness');
    await delay(10);
  }
  throw new Error('Fixture readiness timeout');
}

async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

function startOwner(directory, body) {
  return spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { acquireKernelExportLease, spawnExportProcess } from ${JSON.stringify(moduleUrl)};
    const directory = ${JSON.stringify(directory)};
    const release = acquireKernelExportLease(directory);
    ${body}
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
}

test('kernel lease serializes two independent processes on the same directory and releases after exit', options, async t => {
  const directory = fixture(t), ready = path.join(directory, 'ready');
  let owner;
  try {
    owner = startOwner(directory, `fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
    await waitFile(ready, owner);
    const busy = contender(directory);
    assert.equal(busy.error, undefined);
    assert.equal(busy.status, 2);
    assert.equal(busy.stdout.trim(), 'LOCK_BUSY');
    await stop(owner, 'SIGKILL');
    const next = contender(directory);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout.trim(), 'acquired');
  } finally { await stop(owner, 'SIGKILL'); }
});

test('an orphan export child retains the kernel lease after SIGKILL of its owner', options, async t => {
  const directory = fixture(t), ready = path.join(directory, 'child-pid'), finish = path.join(directory, 'finish-child'), done = path.join(directory, 'child-done');
  let owner, childPid;
  try {
    const childCode = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(finish)})) {
          fs.writeFileSync(${JSON.stringify(done)}, 'done'); clearInterval(timer);
        }
      }, 10);`;
    owner = startOwner(directory, `spawnExportProcess(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
    childPid = Number(await waitFile(ready, owner));
    assert.ok(Number.isInteger(childPid) && childPid > 1);
    await stop(owner, 'SIGKILL');
    assert.doesNotThrow(() => process.kill(childPid, 0), 'orphan must actually remain alive');
    const busy = contender(directory);
    assert.equal(busy.status, 2, busy.stderr);
    assert.equal(busy.stdout.trim(), 'LOCK_BUSY', 'parent death cannot authorize duplicate export');
    fs.writeFileSync(finish, 'finish');
    const deadline = Date.now() + 5000;
    let next;
    do {
      await delay(10);
      next = contender(directory);
      if (next.status === 0) break;
    } while (Date.now() < deadline);
    assert.equal(fs.readFileSync(done, 'utf8'), 'done');
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout.trim(), 'acquired');
    childPid = undefined;
  } finally {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    await stop(owner, 'SIGKILL');
  }
});

test('explicit owner release does not unlock a still-running inherited export child', options, async t => {
  const directory = fixture(t), ready = path.join(directory, 'ready');
  let release = acquireKernelExportLease(directory), child;
  try {
    child = spawnExportProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFile(ready, child);
    release(); release = undefined;
    assert.equal(contender(directory).stdout.trim(), 'LOCK_BUSY');
    await stop(child);
    assert.equal(contender(directory).stdout.trim(), 'acquired');
  } finally {
    await stop(child, 'SIGKILL');
    release?.();
  }
});

test('stale PID metadata cannot override a live kernel lease and the lock inode is not unlinked', options, t => {
  const directory = fixture(t), release = acquireKernelExportLease(directory);
  const lock = path.join(directory, '.export.lock'), inode = fs.statSync(lock).ino;
  try {
    fs.writeFileSync(path.join(directory, '.owner.json'), JSON.stringify({ pid: 1, startedAt: 0, token: 'stale' }));
    assert.throws(() => acquireKernelExportLease(directory), { code: 'LOCK_BUSY' });
    assert.equal(contender(directory).stdout.trim(), 'LOCK_BUSY');
  } finally { release(); }
  assert.equal(fs.statSync(lock).ino, inode);
  assert.equal(contender(directory).stdout.trim(), 'acquired');
  assert.equal(fs.statSync(lock).ino, inode);
});

test('missing flock fails closed rather than starting an unguarded export owner', options, t => {
  const directory = fixture(t), emptyPath = path.join(directory, 'empty-bin');
  fs.mkdirSync(emptyPath);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireKernelExportLease } from ${JSON.stringify(moduleUrl)};
    try { acquireKernelExportLease(${JSON.stringify(directory)}); console.log('unexpected'); process.exitCode = 1; }
    catch (error) { console.log(error.code); }
  `], { env: { ...process.env, PATH: emptyPath }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'LOCK_UNAVAILABLE');
});

for (const withProgress of [false, true]) test(`runMedia ${withProgress ? 'progress' : 'snapshot/no-progress'} child retains the lease and captured output`, options, async t => {
  const directory = fixture(t), ready = path.join(directory, 'media-pid'), finish = path.join(directory, 'finish-media');
  let release = acquireKernelExportLease(directory), pid, media;
  try {
    const code = `const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){
        console.log('fixture stdout'); console.error('fixture stderr'); clearInterval(timer);
      }},10);`;
    media = runMedia(process.execPath, ['-e', code], withProgress ? { onProgress() {}, durationSeconds: 1 } : {});
    media.catch(() => {});
    pid = Number(await waitFile(ready));
    release(); release = undefined;
    assert.equal(contender(directory).stdout.trim(), 'LOCK_BUSY');
    fs.writeFileSync(finish, 'finish');
    const result = await media;
    pid = undefined;
    assert.match(result.stdout, /fixture stdout/);
    assert.match(result.stderr, /fixture stderr/);
    assert.equal(contender(directory).stdout.trim(), 'acquired');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await media?.catch(() => {});
    release?.();
  }
});
