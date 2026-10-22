import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createExportRecoveryStore, acquireExportLease, cameraRecoveryRequest, resolveRecoveryDevice } from '../lib/export-recovery.js';
import { publishExport, reconcilePublications } from '../lib/export-publication.js';
import { allocateArtifact, artifactWorkDir } from '../lib/artifacts.js';
import { captureOutputSource } from '../lib/output-library.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-recovery-'));
  const previous = process.env.HIKVISION_ARTIFACT_DIR;
  process.env.HIKVISION_ARTIFACT_DIR = path.join(root, 'artifacts');
  const downloadsDir = path.join(root, 'downloads'); fs.mkdirSync(downloadsDir);
  const storeRoot = path.join(root, 'queue'), store = createExportRecoveryStore(storeRoot);
  const task = { taskId: crypto.randomUUID(), status: 'queued', queuedAt: 10, filename: '比赛.mp4' };
  store.admit(task, { type: 'legacy', deviceId: 'device-1', endpoint: '192.0.2.1', options: { channel: '201' } });
  t.after(() => { if (previous === undefined) delete process.env.HIKVISION_ARTIFACT_DIR; else process.env.HIKVISION_ARTIFACT_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, downloadsDir, storeRoot, store, task };
}

test('admission is durable, ordered even in same millisecond, and strips secrets/controller', t => {
  const f = fixture(t), second = { ...f.task, taskId: crypto.randomUUID(), pass: 'never-save', controller: new AbortController() };
  f.store.admit(second, { type: 'legacy', deviceId: 'device-1' });
  const recovered = createExportRecoveryStore(f.storeRoot).load();
  assert.deepEqual(recovered.map(record => record.task.taskId), [f.task.taskId, second.taskId]);
  assert.equal(JSON.stringify(recovered).includes('never-save'), false);
  assert.equal(recovered[1].task.controller, undefined);
  assert.equal(fs.readdirSync(f.storeRoot).some(name => name.endsWith('.tmp')), false);
});

test('cancellation intent survives later in-flight state updates and process restart', t => {
  const f = fixture(t); f.store.cancel(f.task); f.store.update({ ...f.task, status: 'converting' });
  const record = createExportRecoveryStore(f.storeRoot).load()[0];
  assert.equal(record.cancelRequested, true);
});

test('one corrupt record is visible and does not drop other queued work or erase evidence', t => {
  const f = fixture(t), id = crypto.randomUUID(), file = path.join(f.storeRoot, `${id}.json`);
  fs.writeFileSync(file, '{broken');
  const records = createExportRecoveryStore(f.storeRoot).load();
  assert.equal(records.length, 2); assert.equal(records.find(record => record.task.taskId === id).corrupt, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('source snapshot preserves DVR/channel/archive selection without credentials', () => {
  const camera = { id: 'D1', name: '镜头', deviceId: 'device-1', channel: '301', archivePath: 'D1' };
  const device = { id: 'device-1', ip: '192.0.2.1', password: 'never-save', username: 'secret' };
  const request = cameraRecoveryRequest('clip', { camera: 'D1', start: '2026-01-01 10:00:00', end: '2026-01-01 10:01:00', pass: 'never-save' }, camera, device, true, 'a.mp4');
  assert.equal(request.camera.channel, '301'); assert.equal(request.forceDvr, true);
  assert.equal(JSON.stringify(request).includes('never-save'), false);
  assert.equal(resolveRecoveryDevice(request, () => device), device);
  assert.throws(() => resolveRecoveryDevice(request, () => null), /原录像机/);
  assert.throws(() => resolveRecoveryDevice(request, () => ({ ...device, ip: '192.0.2.2' })), /原录像机/);
});

test('crash after artifact rename resumes named publication without another export', async t => {
  const f = fixture(t), artifact = allocateArtifact('clip'), bytes = Buffer.from('complete fixture video');
  fs.writeFileSync(artifact.file, bytes);
  f.store.publication(f.task.taskId, { key: f.task.filename, artifact: { url: artifact.url }, filename: f.task.filename, selected: { source: 'hikvision', camera: 'D1' }, size: bytes.length, identity: fs.statSync(artifact.file) });
  const store = createExportRecoveryStore(f.storeRoot), record = store.load()[0];
  const result = await reconcilePublications({ record, store, downloadsDir: f.downloadsDir });
  assert.equal(result.length, 1); assert.equal(result[0].camera, 'D1');
  assert.deepEqual(fs.readFileSync(path.join(f.downloadsDir, f.task.filename)), bytes);
  const again = await reconcilePublications({ record: store.get(f.task.taskId), store, downloadsDir: f.downloadsDir });
  assert.equal(again[0].artifactUrl, artifact.url); assert.equal(fs.readdirSync(f.downloadsDir).length, 1);
});

test('partial artifacts and unrelated collided outputs are preserved and not delivered', async t => {
  const f = fixture(t), artifact = allocateArtifact('clip'); fs.writeFileSync(artifact.file, 'partial');
  const publication = { key: f.task.filename, artifact: { url: artifact.url }, filename: f.task.filename, selected: {}, size: 100, identity: fs.statSync(artifact.file) };
  f.store.publication(f.task.taskId, publication);
  await assert.rejects(reconcilePublications({ record: f.store.get(f.task.taskId), store: f.store, downloadsDir: f.downloadsDir }), /大小/);
  assert.equal(fs.existsSync(path.join(f.downloadsDir, f.task.filename)), false);
  fs.writeFileSync(path.join(f.downloadsDir, f.task.filename), 'unrelated');
  f.store.publication(f.task.taskId, { ...publication, size: 7 });
  await assert.rejects(reconcilePublications({ record: f.store.get(f.task.taskId), store: f.store, downloadsDir: f.downloadsDir }));
  assert.equal(fs.readFileSync(path.join(f.downloadsDir, f.task.filename), 'utf8'), 'unrelated');
  assert.equal(fs.readFileSync(artifact.file, 'utf8'), 'partial');
});

test('crash before completed artifact has no publication to reuse', async t => {
  const f = fixture(t), artifact = allocateArtifact('clip');
  f.store.publication(f.task.taskId, { key: f.task.filename, artifact: { url: artifact.url }, filename: f.task.filename, selected: {}, size: 10 });
  assert.deepEqual(await reconcilePublications({ record: f.store.get(f.task.taskId), store: f.store, downloadsDir: f.downloadsDir }), []);
});

test('publication preserves UUID artifact, cancellation retains completed bytes, and never publishes partial copy', async t => {
  const f = fixture(t), artifact = allocateArtifact('clip'), work = artifactWorkDir(), outputFile = path.join(work, 'ready.mp4');
  fs.writeFileSync(outputFile, 'ready');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(publishExport({ ...f, taskId: f.task.taskId, artifact, outputFile, key: 'one', filename: f.task.filename, selected: {}, signal: controller.signal }));
  assert.equal(fs.readFileSync(artifact.file, 'utf8'), 'ready');
  assert.equal(fs.existsSync(path.join(f.downloadsDir, f.task.filename)), false);
});

test('recovery snapshots follow verified rename even after task ages out of activeTasks', t => {
  const f = fixture(t), before = path.join(f.downloadsDir, f.task.filename), after = path.join(f.downloadsDir, '新名.mp4');
  fs.writeFileSync(before, 'ready'); const source = captureOutputSource(f.downloadsDir, before);
  f.store.update({ ...f.task, status: 'completed', size: 5 });
  fs.renameSync(before, after); const target = captureOutputSource(f.downloadsDir, after);
  f.store.renameOutput({ source, target });
  assert.equal(createExportRecoveryStore(f.storeRoot).load()[0].task.filename, '新名.mp4');
});

test('same-size replacement artifact never satisfies a prior publication checkpoint', async t => {
  const f = fixture(t), artifact = allocateArtifact('clip'); fs.writeFileSync(artifact.file, 'first');
  f.store.publication(f.task.taskId, { key: f.task.filename, artifact: { url: artifact.url }, filename: f.task.filename, selected: {}, size: 5, identity: fs.statSync(artifact.file) });
  const replacement = `${artifact.file}.replacement`; fs.writeFileSync(replacement, 'other'); fs.renameSync(replacement, artifact.file);
  await assert.rejects(reconcilePublications({ record: f.store.get(f.task.taskId), store: f.store, downloadsDir: f.downloadsDir }), /身份/);
  assert.equal(fs.existsSync(path.join(f.downloadsDir, f.task.filename)), false);
});

test('same data directory refuses two live recovery owners and releases normally', t => {
  const f = fixture(t), release = acquireExportLease(f.storeRoot);
  try { assert.throws(() => acquireExportLease(f.storeRoot), /仍持有导出队列/); }
  finally { release(); }
  const next = acquireExportLease(f.storeRoot); next();
});

test('reused container PID does not block a new process incarnation', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.storeRoot, '.owner.json'), JSON.stringify({ pid: process.pid, startedAt: 1, token: 'previous-process' }));
  const release = acquireExportLease(f.storeRoot); release();
});
