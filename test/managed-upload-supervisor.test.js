import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createManagedUploadSupervisor, verifyManagedUploadTools } from '../lib/managed-upload-supervisor.js';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-upload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), downloadsDir = path.join(root, 'downloads');
  fs.mkdirSync(path.join(dataDir, 'private/upload-accounts'), { recursive: true });
  fs.mkdirSync(downloadsDir);
  for (const name of ['bilibili', 'cloud189']) fs.writeFileSync(path.join(dataDir, `private/upload-accounts/${name}.json`), '{}', { mode: 0o600 });
  const coverPath = path.join(dataDir, 'cover.png'); fs.writeFileSync(coverPath, 'cover');
  const state = { preparationOnly: false, recoveryReady: true, managedEnabled: true,
    bilibili: { enabled: true, seasonId: 1, sectionId: 2, coverPath }, cloud189: { enabled: true } };
  const children = [], killed = [];
  let now = 0;
  const supervisor = createManagedUploadSupervisor({ releaseRoot: root, dataDir, downloadsDir, getState: () => state,
    checkTools: () => ({ bilibili: '/pinned/biliup', cloud189: '/pinned/cloud189' }), now: () => now,
    spawnProcess(binary, args, options) { const child = new EventEmitter(); child.pid = 900 + children.length; children.push({ child, binary, args, options }); return child; },
    killProcessGroup: (child, signal) => killed.push([child.pid, signal]), ...overrides,
  });
  t.after(() => { supervisor.stop(); for (const { child } of children) child.emit('close', 0); });
  return { root, dataDir, downloadsDir, state, children, killed, supervisor, advance: value => { now += value; } };
}
test('managed supervisor keeps preparation/recovery/explicit enablement gates closed', t => {
  const f = fixture(t);
  for (const field of ['preparationOnly', 'recoveryReady', 'managedEnabled']) {
    const old = f.state[field]; f.state[field] = field === 'preparationOnly';
    f.supervisor.reconcile(); assert.equal(f.children.length, 0); f.state[field] = old;
  }
  f.state.bilibili.enabled = false; f.state.cloud189.enabled = false;
  f.supervisor.reconcile(); assert.equal(f.children.length, 0);
});
test('managed workers use fixed CLI/env, separate groups, and no inherited secret or export descriptors', t => {
  const f = fixture(t); f.supervisor.reconcile(); f.supervisor.reconcile();
  assert.equal(f.children.length, 2);
  for (const child of f.children) {
    assert.equal(child.binary, '/usr/bin/python3'); assert.equal(child.options.detached, true);
    assert.deepEqual(child.options.stdio, ['ignore', 'ignore', 'ignore']);
    assert.equal(child.options.env.HIKCLIP_MCP_TOKEN, undefined);
    assert.equal(child.options.env.HIKCLIP_LOGIN_PASSWORD, undefined);
    assert.equal(child.options.env['189_MODE'], undefined);
    assert.ok(child.options.env.HOME.startsWith(path.join(f.dataDir, 'private/upload-accounts')));
  }
  assert.equal(f.children[1].options.env.CLOUD189_BACKEND, 'gowsp');
});
test('Bili requires both positive collection IDs and a real cover', t => {
  const f = fixture(t); f.state.bilibili.seasonId = 0;
  const status = f.supervisor.reconcile(); assert.equal(f.children.length, 1);
  assert.equal(status.bilibili.state, 'configuration_required');
  f.state.bilibili.seasonId = 1; fs.unlinkSync(f.state.bilibili.coverPath);
  assert.equal(f.supervisor.reconcile().bilibili.state, 'configuration_required');
});
test('credential removal stops child and cannot restart it; crash backs off', t => {
  const f = fixture(t); f.supervisor.reconcile();
  fs.unlinkSync(path.join(f.dataDir, 'private/upload-accounts/cloud189.json'));
  assert.equal(f.supervisor.reconcile().cloud189.state, 'stopping');
  assert.deepEqual(f.killed, [[901, 'SIGTERM']]); f.children[1].child.emit('close', 0);
  f.children[0].child.emit('close', 1); f.supervisor.reconcile(); assert.equal(f.children.length, 2);
  f.advance(10000); f.supervisor.reconcile(); assert.equal(f.children.length, 3);
});
test('setting edits do not interrupt live upload unexpectedly', t => {
  const f = fixture(t); f.supervisor.reconcile(); f.state.bilibili.sectionId = 3;
  assert.equal(f.supervisor.reconcile().bilibili.state, 'restart_required'); assert.equal(f.killed.length, 0);
});
test('tool verification enforces hashes and rejects tampered/symlink executables', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'config')); fs.mkdirSync(path.join(f.root, 'upload-tools'));
  const pins = { tools: {} }, manifest = { profile: 'managed-uploads-v1', platform: 'linux-x64', tools: {} };
  for (const provider of ['bilibili', 'cloud189']) {
    const filename = provider === 'bilibili' ? 'biliup' : 'cloud189';
    const pin = { filename, version: 'fixture', url: 'https://example.invalid/fixed', archiveSha256: 'a'.repeat(64) };
    pins.tools[provider] = pin;
    manifest.tools[provider] = { ...pin, fileSha256: crypto.createHash('sha256').update('fixture').digest('hex') };
    fs.writeFileSync(path.join(f.root, 'upload-tools', filename), 'fixture', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(f.root, 'config/upload-tools-pins.json'), JSON.stringify(pins));
  fs.writeFileSync(path.join(f.root, 'upload-tools/manifest.json'), JSON.stringify(manifest));
  assert.ok(verifyManagedUploadTools(f.root).cloud189.endsWith('/cloud189'));
  fs.writeFileSync(path.join(f.root, 'upload-tools/cloud189'), 'changed');
  assert.throws(() => verifyManagedUploadTools(f.root), /checksum/);
  fs.unlinkSync(path.join(f.root, 'upload-tools/cloud189'));
  fs.symlinkSync(path.join(f.root, 'upload-tools/biliup'), path.join(f.root, 'upload-tools/cloud189'));
  assert.throws(() => verifyManagedUploadTools(f.root), /executable/);
});

test('account-derived readiness cannot bypass unavailable credentials, binding or active account changes', async () => {
  const { uploadAccountReady } = await import('../lib/managed-upload-supervisor.js');
  const ready = { available: true, credentialsPresent: true, bindingPresent: true, busy: false, state: 'connected' };
  assert.equal(uploadAccountReady(ready), true);
  // A persisted authenticated binding survives a server restart, whose display state is disconnected.
  assert.equal(uploadAccountReady({ ...ready, state: 'disconnected' }), true);
  for (const patch of [{ available: false }, { credentialsPresent: false }, { bindingPresent: false }, { busy: true }, { state: 'needs_login' }, { state: 'error' }]) assert.equal(uploadAccountReady({ ...ready, ...patch }), false);
  assert.equal(uploadAccountReady(null), false);
});

test('account promotion awaits provider process-group stop before continuing', async t => {
  const f = fixture(t); f.supervisor.reconcile();
  f.state.bilibili.enabled = false;
  let settled = false;
  const stopped = f.supervisor.stopProvider('bilibili').then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.equal(f.supervisor.status().bilibili.running, false);
  assert.ok(f.killed.some(([pid, signal]) => pid === f.children[0].child.pid && signal === 'SIGTERM'));
  await stopped;
  assert.equal(f.supervisor.status().bilibili.state, 'stopped');
  assert.equal(f.supervisor.status().cloud189.running, true);
  f.supervisor.reconcile(); assert.equal(f.children.length, 2);
});

test('account promotion fails closed when a worker group remains alive after escalation', async t => {
  const f = fixture(t, { isProcessGroupAlive: () => true, stopGraceMs: 1 });
  f.supervisor.reconcile(); f.state.bilibili.enabled = false;
  await assert.rejects(f.supervisor.stopProvider('bilibili'), /still stopping/);
});
test('read-only verification gets fixed script UUID private env and bounded output', async t => {
  let launched;
  const f = fixture(t, { spawnProcess(binary,args,options) { const child = new EventEmitter(); child.pid=909; child.stdout=new EventEmitter(); launched={child,binary,args,options}; return child; } });
  const id='00000000-0000-4000-8000-000000000001';
  const pending=f.supervisor.verifyCloud189(id,()=>true);
  assert.deepEqual(launched.args,[path.join(f.root,'scripts/cloud189-worker.py'),'--verify-job',id]);
  assert.equal(launched.options.env.HIKCLIP_UPLOAD_GENERATION_REQUIRED,'1');
  assert.equal(launched.options.env.CLOUD189_BINARY,'/pinned/cloud189');
  assert.equal(launched.options.env.CLOUD189_CONFIG_FILE,path.join(f.dataDir,'private/upload-accounts/cloud189.json'));
  assert.deepEqual(launched.options.stdio,['ignore','pipe','ignore']);
  launched.child.stdout.emit('data',Buffer.from('{"ok":true,"code":"CLOUD_REMOTE_VERIFIED"}')); launched.child.emit('close',0);
  assert.deepEqual(await pending,{ok:true,code:'CLOUD_REMOTE_VERIFIED'});
  const oversized=f.supervisor.verifyCloud189(id,()=>true); launched.child.stdout.emit('data',Buffer.alloc(4097));
  assert.equal((await oversized).ok,false); assert.deepEqual(f.killed.at(-1),[909,'SIGKILL']);
});
test('verification rejects inactive owner and kills its group on revocation', async t => {
  let launched, active=true;
  const f=fixture(t,{spawnProcess() { const child=new EventEmitter();child.pid=919;child.stdout=new EventEmitter();launched=child;return child;}});
  const id='00000000-0000-4000-8000-000000000001';
  assert.equal((await f.supervisor.verifyCloud189(id,()=>false)).ok,false);assert.equal(launched,undefined);
  const pending=f.supervisor.verifyCloud189(id,()=>active);active=false;
  assert.equal((await pending).ok,false);assert.deepEqual(f.killed.at(-1),[919,'SIGKILL']);
});
test('disconnect drains verification descendants even after helper leader exit and refuses overlap', async t => {
  let child, alive=true, launches=0;
  const f=fixture(t,{stopGraceMs:60,isProcessGroupAlive:()=>alive,
    spawnProcess() { launches++;child=new EventEmitter();child.pid=929;child.stdout=new EventEmitter();return child; }});
  const id='00000000-0000-4000-8000-000000000001';
  const pending=f.supervisor.verifyCloud189(id,()=>true);
  assert.equal((await f.supervisor.verifyCloud189(id,()=>true)).ok,false);assert.equal(launches,1);
  child.stdout.emit('data',Buffer.from('{"ok":false,"code":"VERIFY_UNAVAILABLE"}'));child.emit('close',2);await pending;
  assert.equal((await f.supervisor.verifyCloud189(id,()=>true)).ok,false);assert.equal(launches,1);
  await assert.rejects(f.supervisor.stopProvider('cloud189'),/verification is still stopping/);
  alive=false;await f.supervisor.stopProvider('cloud189');
  assert.ok(f.killed.some(([,signal])=>signal==='SIGKILL'));
});
test('verification output uses an enumerated code contract', async t => {
  let child;
  const f=fixture(t,{spawnProcess() { child=new EventEmitter();child.pid=939;child.stdout=new EventEmitter();return child;}});
  const pending=f.supervisor.verifyCloud189('00000000-0000-4000-8000-000000000001',()=>true);
  child.stdout.emit('data',Buffer.from('{"ok":false,"code":"private-provider-string"}'));child.emit('close',2);
  assert.deepEqual(await pending,{ok:false,code:'VERIFY_UNAVAILABLE'});
});

test('archive and restore use local-only environment without login tools; retry needs current account', async t => {
  let launched;
  const f = fixture(t, { isProcessGroupAlive: () => false, checkTools: () => { throw new Error('no provider tools'); },
    spawnProcess(binary, args, options) { const child = new EventEmitter(); child.pid = 949; child.stdout = new EventEmitter(); launched = { child, args, options }; return child; } });
  f.state.cloud189.enabled = false;
  fs.unlinkSync(path.join(f.dataDir, 'private/upload-accounts/cloud189.json'));
  const id = '00000000-0000-4000-8000-000000000001';
  for (const [action, code] of [['archive', 'CLOUD_RECORD_ARCHIVED'], ['restore', 'CLOUD_RECORD_RESTORED']]) {
    const pending = f.supervisor.recoverCloud189(action, id, () => true);
    assert.deepEqual(launched.args, [path.join(f.root, 'scripts/cloud189-worker.py'), `--${action}-job`, id]);
    assert.equal(launched.options.env.CLOUD189_CONFIG_FILE, undefined);
    assert.equal(launched.options.env.CLOUD189_BINARY, undefined);
    assert.equal(launched.options.env.HIKCLIP_UPLOAD_GENERATION_REQUIRED, '1');
    launched.child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, code }))); launched.child.emit('close', 0);
    assert.deepEqual(await pending, { ok: true, code });
  }
  assert.equal((await f.supervisor.recoverCloud189('retry', id, () => true)).ok, false);
  assert.equal((await f.supervisor.recoverCloud189('arbitrary', id, () => true)).ok, false);
});
