import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCloud189Queue, normalizeCloud189TargetPath } from '../lib/cloud189-queue.js';

test('天翼云盘队列只接受成片库 MP4 和安全的云盘目录，待核实任务锁住文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud189-queue-'));
  try {
    fs.mkdirSync(path.join(root, 'camera_0123456789abcdef'));
    const relative = path.join('camera_0123456789abcdef', '球赛.mp4');
    fs.writeFileSync(path.join(root, relative), 'video');
    const queue = createCloud189Queue(root);
    assert.equal(normalizeCloud189TargetPath(' /足球录像/本周 '), '/足球录像/本周');
    for (const targetPath of ['', '/', '//server/share', '/../private', '/folder\nsecret']) assert.throws(() => normalizeCloud189TargetPath(targetPath));
    const job = queue.enqueue({ filename: relative, targetPath: '/足球录像' });
    assert.equal(job.status, 'queued'); assert.equal(queue.isBusy(relative), true);
    assert.equal(queue.list()[0].remoteFilename, '球赛.mp4');
    const file = path.join(root, 'cloud189_work', 'jobs', `${job.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')); saved.status = 'unknown'; fs.writeFileSync(file, JSON.stringify(saved));
    assert.equal(queue.isBusy(relative), true);
    assert.throws(() => queue.enqueue({ filename: '../secret.mp4', targetPath: '/足球录像' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('busy Cloud189 tasks beyond the displayed history remain protected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud189-history-'));
  try {
    fs.writeFileSync(path.join(root, 'old.mp4'), 'video');
    const queue = createCloud189Queue(root);
    const active = queue.enqueue({ filename: 'old.mp4', targetPath: '/足球录像' });
    assert.equal(active.uploadPhase, 'queued');
    assert.equal(active.sourceIdentity.size, 5);
    const directory = path.join(root, 'cloud189_work', 'jobs');
    fs.writeFileSync(path.join(directory, `${active.id}.json`), JSON.stringify({ ...active, createdAt: '2000-01-01', status: 'unknown' }));
    for (let index = 0; index < 105; index++) {
      const id = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
      fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ id, filename: 'new.mp4', createdAt: '2026-09-30', status: 'completed' }));
    }
    assert.equal(queue.list({ limit: 100 }).some(job => job.id === active.id), false);
    assert.equal(queue.isBusy('old.mp4'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('archived unknown releases source, preserves duplicate guard and follows identity-proven rename', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud189-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'old.mp4'), 'video');
  const queue = createCloud189Queue(root), job = queue.enqueue({ filename: 'old.mp4', targetPath: '/football' });
  const file = path.join(root, 'cloud189_work', 'jobs', `${job.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...job, status: 'unknown', uploadPhase: 'remote_started', archivedAt: '2026-10-01T00:00:00Z' }));
  assert.equal(queue.isBusy('old.mp4'), false);
  assert.equal(queue.list()[0].status, 'unknown');
  assert.equal(queue.list()[0].recoveryAvailable, true);
  assert.throws(() => queue.enqueue({ filename: 'old.mp4', targetPath: '/football' }), /待核实/);
  const before = fs.statSync(path.join(root, 'old.mp4'));
  fs.renameSync(path.join(root, 'old.mp4'), path.join(root, 'renamed.mp4'));
  queue.renameOutput({ source: { relativePath: 'old.mp4', identity: before }, target: { relativePath: 'renamed.mp4', identity: fs.statSync(path.join(root, 'renamed.mp4')) } });
  assert.equal(queue.get(job.id).filename, 'old.mp4');
  assert.equal(queue.get(job.id).sourceFilename, 'renamed.mp4');
  assert.equal(queue.list()[0].filename, 'renamed.mp4');
  assert.equal(queue.list()[0].remoteFilename, 'old.mp4');
  assert.throws(() => queue.enqueue({ filename: 'renamed.mp4', targetPath: '/football' }), /待核实/);
  let release;
  const first = queue.runRecovery(job.id, () => new Promise(resolve => release = resolve));
  assert.equal(queue.busyReason('renamed.mp4'), 'recovery');
  assert.deepEqual(await queue.runRecovery(job.id, () => assert.fail('no concurrent recovery')), { ok: false, code: 'VERIFY_BUSY' });
  release({ ok: true }); await first;
  assert.equal(queue.isBusy('renamed.mp4'), false);
  const restored = queue.get(job.id); delete restored.archivedAt; fs.writeFileSync(file, JSON.stringify(restored));
  assert.equal(queue.busyReason('renamed.mp4'), 'verification');
});

test('a changed file cannot inherit the old source recovery association', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud189-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'old.mp4'), 'video');
  const queue = createCloud189Queue(root), job = queue.enqueue({ filename: 'old.mp4', targetPath: '/football' });
  const file = path.join(root, 'cloud189_work', 'jobs', `${job.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...job, status: 'unknown', archivedAt: '2026-10-01' }));
  queue.renameOutput({ source: { relativePath: 'old.mp4', identity: { ...job.sourceIdentity, ino: '0' } }, target: { relativePath: 'renamed.mp4' } });
  assert.equal(queue.get(job.id).sourceFilename, undefined);
});
