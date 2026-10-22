import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { prepareCameraJob } from '../lib/camera-jobs.js';

const input = '/fixture/dvr.mp4', outputFile = '/fixture/artifact.mp4';

test('unbound MediaMTX cameras export locally, reject DVR and cannot fall back when footage is missing', async () => {
  const calls = [];
  const camera = { id: 'd1', name: 'd1', archivePath: 'd1' };
  const args = { camera: 'd1', start: '2026-01-01 10:00', end: '2026-01-01 10:01' };
  const dependencies = { resolveCamera: () => ({ camera, device: null }),
    archive: { hasRecording: async () => ({ exists: true }), cutClip: async () => { calls.push('local'); return outputFile; } },
    startHikvision: () => { calls.push('DVR'); assert.fail('must not use a default DVR'); } };
  const job = prepareCameraJob('clip', args, dependencies);
  assert.equal(job.forceArchive, true); assert.equal(job.recoveryRequest.forceArchive, true);
  assert.equal(job.recoveryRequest.deviceId, undefined); assert.equal(job.recoveryRequest.camera.channel, undefined);
  assert.equal((await job.execute({ outputFile })).source, 'mediamtx'); assert.deepEqual(calls, ['local']);
  assert.throws(() => prepareCameraJob('clip', args, { ...dependencies, forceDvr: true }), /未配置 DVR/);
  const missing = prepareCameraJob('clip', args, { ...dependencies, archive: {
    hasRecording: async () => ({ exists: false, coverage: { hasFootage: false, complete: false, missingIntervals: [], missingSeconds: 60 } }),
  } });
  await assert.rejects(missing.plan({}), error => error.code === 'MEDIAMTX_EMPTY');
  await assert.rejects(job.execute({ outputFile, plan: { source: 'hikvision', method: 'rtspclip' } }), /不能切换/);
  assert.deepEqual(calls, ['local']);
});
function dvrJob({ sourceFile = input, downloadsDir } = {}) {
  return prepareCameraJob('clip', {
    camera: 'D1', start: '2026-01-01 10:00', end: '2026-01-01 11:00',
  }, {
    resolveCamera: () => ({ camera: { id: 'D1', channel: '101' }, device: { id: 'fixture', ip: '192.0.2.1' } }),
    archive: {}, forceDvr: true,
    downloadsDir, startHikvision: async () => sourceFile,
  });
}

function defer() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('DVR final copy keeps HTTP responsive and task pending until the copy settles', { timeout: 5000 }, async t => {
  const started = defer(), copied = defer();
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('DVR finalization must not block the event loop'); });
  t.mock.method(fs.promises, 'copyFile', async (...args) => {
    assert.deepEqual(args, [input, outputFile, fs.constants.COPYFILE_FICLONE]);
    started.resolve();
    await copied.promise;
  });
  const server = http.createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  let settled = false;
  const progress = [];
  const execution = dvrJob().execute({ outputFile, signal: new AbortController().signal,
    onProgress: (...args) => progress.push(args) });
  const observed = execution.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  // Keep a failing implementation from producing an unhandled rejection while waiting for the copy.
  observed.catch(() => {});
  try {
    await Promise.race([started.promise, observed.then(() => assert.fail('copy was not awaited'))]);
    assert.equal(settled, false);
    assert.deepEqual(progress, [[null, '正在保存最终文件…', null, { stage: 'finalizing', stagePercent: null }]]);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(settled, false, 'HTTP should respond while the large file is still being saved');
    copied.resolve();
    assert.equal((await observed).source, 'hikvision');
  } finally {
    copied.resolve();
    await observed.catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('DVR final copy errors propagate instead of publishing a completed artifact', async t => {
  const error = new Error('disk full');
  t.mock.method(fs.promises, 'copyFile', async () => { throw error; });
  await assert.rejects(dvrJob().execute({ outputFile }), error);
});

test('cancelling a DVR final copy waits for I/O settlement before rejecting', async t => {
  const started = defer(), copied = defer(), controller = new AbortController();
  t.mock.method(fs.promises, 'copyFile', async () => { started.resolve(); await copied.promise; });
  let settled = false;
  const execution = dvrJob().execute({ outputFile, signal: controller.signal });
  execution.then(() => { settled = true; }, () => { settled = true; });
  await started.promise;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'cleanup must not race a copy still writing the artifact');
  copied.resolve();
  await assert.rejects(execution, { name: 'AbortError' });
});

test('DVR final copy is skipped when the task is already cancelled', async t => {
  const copy = t.mock.method(fs.promises, 'copyFile', async () => assert.fail('cancelled job must not copy'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(dvrJob().execute({ outputFile, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(copy.mock.callCount(), 0);
});

test('DVR copy records precise source identity and keeps delivered bytes independent of a later re-export', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-job-source-'));
  try {
    const relativePath = path.join('camera_0123456789abcdef', 'source.mp4');
    const sourceFile = path.join(root, relativePath), target = path.join(root, 'delivered.mp4');
    fs.mkdirSync(path.dirname(sourceFile));
    fs.writeFileSync(sourceFile, 'original recording');
    const selected = await dvrJob({ sourceFile, downloadsDir: root }).execute({ outputFile: target });
    assert.equal(selected.sourceOutput.relativePath, relativePath);
    assert.equal(selected.sourceOutput.identity.ino, fs.statSync(sourceFile).ino);
    fs.writeFileSync(sourceFile, 're-exported recording');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original recording', 'CoW clone must not use a mutable hard-linked inode');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DVR source changing during the copy never supplies deduplication provenance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-job-changed-source-'));
  try {
    const sourceFile = path.join(root, 'source.mp4');
    fs.writeFileSync(sourceFile, 'original');
    t.mock.method(fs.promises, 'copyFile', async () => fs.utimesSync(sourceFile, new Date(0), new Date(0)));
    const selected = await dvrJob({ sourceFile, downloadsDir: root }).execute({ outputFile: path.join(root, 'target.mp4') });
    assert.equal(selected.sourceOutput, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('automatic camera names change only new defaults; saved recovery and explicit matchup names survive', () => {
  const args = { camera: 'D2', start: '2026-01-01 10:00:00', end: '2026-01-01 11:00:00' };
  const dependencies = { resolveCamera: () => ({ camera: { id: 'D2' }, device: null }), archive: {} };
  const fresh = prepareCameraJob('clip', args, dependencies);
  assert.match(fresh.filename, /^D2 2026-01-01 10-00-00_2026-01-01 11-00-00 [a-f0-9]{8}\.mp4$/);
  const historical = 'D2 2026-01-01 10-00-00至2026-01-01 11-00-00 old.mp4';
  const recovered = prepareCameraJob('clip', args, { ...dependencies, recoveryRequest: { ...fresh.recoveryRequest, filename: historical } });
  assert.equal(recovered.filename, historical);
  const named = prepareCameraJob('clip', { ...args, matchup: '球队甲至球队乙' }, dependencies);
  assert.equal(named.filename, '球队甲至球队乙 D2 2026-01-01.mp4');
});
