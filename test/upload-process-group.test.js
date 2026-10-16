import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { launchUploadAccountAdapter } from '../lib/upload-account-adapter.js';
import { createManagedUploadSupervisor } from '../lib/managed-upload-supervisor.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) { const begin = Date.now(); while (!fn()) { if (Date.now() - begin > timeout) throw new Error('timeout'); await delay(15); } }
const free = file => spawnSync('/usr/bin/python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', file]).status === 0;
function setup(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-group-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const orphanCode = (pidFile, lockFile, exitLeader) => `import os,sys,time,signal,fcntl\nf=open(${JSON.stringify(lockFile)},'a+')\nfcntl.flock(f,fcntl.LOCK_EX)\npid=os.fork()\nif pid==0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n null=os.open('/dev/null',os.O_RDWR)\n for fd in (0,1,2):os.dup2(null,fd)\n open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\n while True:time.sleep(1)\n${exitLeader ? 'sys.exit(1)' : 'while True:time.sleep(1)'}\n`;

test('account stop and killNow reach TERM-ignoring same-group descendants after leader closes', { skip: process.platform !== 'linux' }, async t => {
  for (const mode of ['stop', 'killNow']) {
    const root = setup(t), ready = path.join(root, 'child.pid'), lock = path.join(root, 'provider.lock'); let child;
    const handle = launchUploadAccountAdapter({ provider: 'cloud189', mode: 'login', binary: '/fake', stageDir: root, credentialFile: path.join(root, 'config.json'), lockFile: lock, onEvent() {},
      spawnProcess: () => { child = spawn('/usr/bin/python3', ['-c', orphanCode(ready, lock, true)], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); return child; } });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    await until(() => fs.existsSync(ready)); await handle.closed; assert.equal(free(lock), false);
    await handle[mode](); await until(() => free(lock));
    assert.equal(free(lock), true, mode);
  }
});
for (const spontaneous of [false, true]) test(`managed supervisor cleans descendant on ${spontaneous ? 'spontaneous leader failure' : 'explicit stop'} before replacement`, { skip: process.platform !== 'linux' }, async t => {
  const root = setup(t), dataDir = path.join(root, 'data'), downloadsDir = path.join(root, 'downloads'), privateDir = path.join(dataDir, 'private', 'upload-accounts');
  fs.mkdirSync(privateDir, { recursive: true }); fs.mkdirSync(downloadsDir);
  fs.writeFileSync(path.join(privateDir, 'cloud189.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(privateDir, 'cloud189.connection.json'), JSON.stringify({ version: 1, generation: 'a'.repeat(32) }), { mode: 0o600 });
  const ready = path.join(root, 'child.pid'), lock = path.join(root, 'provider.lock'); let child; let spawns = 0;
  const state = { preparationOnly: false, recoveryReady: true, managedEnabled: true, bilibili: { enabled: false }, cloud189: { enabled: true } };
  const supervisor = createManagedUploadSupervisor({ releaseRoot: root, dataDir, downloadsDir, getState: () => state, stopGraceMs: 120,
    checkTools: () => ({ cloud189: '/fake', bilibili: '/fake' }),
    spawnProcess: () => { spawns++; child = spawn('/usr/bin/python3', ['-c', orphanCode(ready, lock, spontaneous)], { detached: true, stdio: 'ignore' }); return child; } });
  t.after(async () => { supervisor.killNow(); await supervisor.stop(); });
  supervisor.reconcile(); await until(() => fs.existsSync(ready)); assert.equal(free(lock), false);
  if (spontaneous) await until(() => supervisor.status().cloud189.state === 'stopping');
  else { state.cloud189.enabled = false; supervisor.reconcile(); }
  assert.equal(supervisor.status().cloud189.state, 'stopping');
  state.cloud189.enabled = true; supervisor.reconcile(); assert.equal(spawns, 1);
  state.cloud189.enabled = false; await supervisor.stop(); await until(() => free(lock));
  assert.equal(spawns, 1); assert.equal(free(lock), true);
});
