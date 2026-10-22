import { sdkEnabled, sanitizeSdkMetadata } from '../lib/dvr-sdk.js';
/** Exercise actual server orchestration with mock pipelines; never contact a recorder. */
import test from 'node:test';
import { deviceCacheKey, deviceEndpointIdentity, deviceRtspAuthority, normalizeDeviceEndpoint } from '../lib/device-endpoint.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { RECOVERED_TASK, EXPORT_TERMINAL, resolveRecoveryDevice } from '../lib/export-recovery.js';
import { createExportQueue } from '../lib/export-queue.js';
import { compactToMs, compactToDisplay } from '../lib/hik-time.js';
import { CAMERA_JOB, TASK_RESERVATION, TASK_COMPLETION } from '../lib/camera-jobs.js';
import { dvrExportError, dvrExportFailure, isDvrExportError } from '../lib/dvr-export-errors.js';
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness({ records = [], reconciled = [], reservedNames = [], previewCleanup, sdk = false } = {}) {
  const calls = [], gates = [], persisted = [];
  let hook, stopHandler, stopPaths, previewsStopped = 0;
  const pipeline = options => { calls.push(options); const gate = deferred(); gates.push(gate); return gate.promise; };
  const context = vm.createContext({ curlDigest() {}, sdkEnabled: sdk ? () => true : sdkEnabled, sanitizeSdkMetadata, sdkDownloadMp4: options => { options.onProgress(null, 'SDK 正在取流'); return pipeline(options); },  app: { use() {}, post(paths, fn) { stopPaths = paths; stopHandler = fn; } }, createExportQueue, crypto, path, compactToMs, compactToDisplay,
    deviceCacheKey, deviceEndpointIdentity, deviceRtspAuthority, normalizeDeviceEndpoint, dvrExportError, dvrExportFailure, isDvrExportError, CAMERA_JOB, TASK_RESERVATION, TASK_COMPLETION, RECOVERED_TASK, EXPORT_TERMINAL, AbortController, Map, Date, Promise,
    console: { log() {}, error() {} }, setTimeout: () => ({ unref() {} }),
    setProgressStatusHook: fn => { hook = fn; }, getSchedules: () => [],
    renameOutputMetadata() {}, outputRenames: { recover: () => [], isBusy: name => reservedNames.includes(name) }, startScheduler() {}, recoveryBlockerId: 'blocker', recoveryRetry: null, exportRecoveryBlocked: null, acquireExportLease() {}, resolveRecoveryDevice, getDeviceById: id => id === 'fixture-device' ? { id, ip: '192.0.2.1', username: 'fixture', password: 'fixture' } : null,
    cleanupInterruptedDvrHttpSamples() {}, dvrHttpSamplePrivateRoot: '/fixture/private', dvrHttpSampleControl: { recoverInterrupted: () => false },
    reconcilePublications: async () => reconciled,
    captureOutputSource: () => null, outputSourceUnchanged: () => false,
    getAllDevices: () => ({ devices: [] }),
    recoveryStore: { load: () => records, admit(task, request) { records.push({ task: { ...task }, request, publications: [] }); }, update(task) { const record = records.find(record => record.task.taskId === task.taskId); if (record) record.task = { ...task }; }, cancel(task) { const record = records.find(record => record.task.taskId === task.taskId); if (record) record.cancelRequested = true; }, get(id) { return records.find(record => record.task.taskId === id); }, request(id, request) { const record = records.find(record => record.task.taskId === id); if (record) record.request = request; } },
    publishExport: async ({ selected, filename, artifact }) => ({ ...selected, filename, artifactUrl: artifact.url }),
    fs: { mkdirSync() {}, constants: {}, promises: { copyFile: async () => {} }, existsSync: () => false, renameSync() {}, linkSync() {}, statSync: () => ({ size: 10 }) },
    mediaJobs: { save: t => persisted.push({ ...t }), findByRange: () => null },
    downloadsDir: '/fixture', listCameras: () => [],
    allocateArtifact: () => ({ file: '/artifact/output.mp4', url: '/artifact/output.mp4' }),
    artifactWorkDir: () => '/fixture/work', cleanArtifactWork() {},
    signedMediaTask: task => task,
    runRtspClipExport: pipeline, runMp4DownloadPipeline: pipeline,
  });
  vm.runInContext(`let sseClients = []; let consolePreviewGeneration = 0; let activePreview = { stop() { return previewStopped(); } };
    const CHANNEL_PATTERN = /^\\d{1,8}$/; const HIK_COMPACT_TIME_PATTERN = /^\\d{8}T\\d{6}Z$/;
    ${part('const activeTasks = new Map();', 'function broadcastProgress(')}
    ${part('function broadcastProgress(', '/** 当前正在跑的导出任务')}
    ${part("app.post(['/api/export/stop'", '// 4. Export Video')}
    ${part('function startCameraJob(', 'const mediaArchive =')}
    ${part('function restoreCameraJob(', 'function startScheduler(')}
    ${part('function startExportTask(', "app.post('/api/export',")}
    globalThis.api = { startExportTask, activeTasks, exportQueue, recoverExportTasks, previewGeneration: () => consolePreviewGeneration };`, Object.assign(context, { previewStopped: () => { previewsStopped++; return previewCleanup; } }));
  return { ...context.api, records, calls, gates, persisted, stopHandler, stopPaths, hook: (...args) => hook(...args), previewsStopped: () => previewsStopped };
}
const options = { ip: '192.0.2.1', user: 'fixture', pass: 'fixture', channel: '101', startTime: '20260101T100000Z', endTime: '20260101T100100Z' };

for (const cancel of [false, true]) test(`export waits for preview process close before acquiring DVR resources${cancel ? ', including cancellation' : ''}`, async () => {
  const preview = deferred(), h = harness({ previewCleanup: preview.promise });
  const started = h.startExportTask(options); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.exportQueue.owns(started.taskId), true);
  if (cancel) h.exportQueue.cancel(started.taskId);
  await flush(); assert.equal(h.calls.length, 0);
  preview.resolve(); await flush();
  if (cancel) { await assert.rejects(started[TASK_COMPLETION]); assert.equal(h.calls.length, 0); }
  else { assert.equal(h.calls.length, 1); h.gates[0].resolve('/fixture/export.mp4'); await started[TASK_COMPLETION]; }
});

for (const camera of [false, true]) for (const code of ['DVR_VIDEO_CODEC_UNSUPPORTED', 'DVR_AUDIO_CODEC_UNSUPPORTED', 'DVR_NOT_FOUND', 'untrusted-code']) {
  test(`DVR ${camera ? 'camera' : 'legacy'} failure ${code} stays classified through cleanup and persisted settlement`, async () => {
    const h = harness();
    const secret = 'rtsp://private-user:private-password@fixture.invalid/SDP';
    const error = Object.assign(new Error(secret), { code });
    const job = { kind: 'clip', requestKey: `camera-${code}`, cameraId: 'fixture-camera', source: 'hikvision',
      start: '2026-01-01 10:00:00', end: '2026-01-01 10:01:00',
      async execute({ reservation }) {
        const nested = h.startExportTask({ ...options, [TASK_RESERVATION]: reservation });
        await nested[TASK_COMPLETION];
      } };
    const started = h.startExportTask(camera ? { [CAMERA_JOB]: job } : options);
    await flush();
    h.hook(started.taskId, 'error', 0, secret);
    assert.equal(h.activeTasks.get(started.taskId).status, 'converting', 'cleanup still owns the queue');
    assert.doesNotMatch(h.activeTasks.get(started.taskId).message, /private|rtsp:\/\/|SDP/);
    h.gates[0].reject(error);
    if (started[TASK_COMPLETION]) await assert.rejects(started[TASK_COMPLETION]);
    for (let i = 0; i < 12 && h.exportQueue.owns(started.taskId); i++) await flush();
    const expected = dvrExportFailure(error), actual = h.activeTasks.get(started.taskId);
    assert.equal(actual.status, 'error'); assert.equal(actual.failureCode, expected.failureCode); assert.equal(actual.message, expected.message);
    const saved = h.records.find(record => record.task.taskId === started.taskId).task;
    assert.equal(saved.failureCode, expected.failureCode); assert.equal(saved.message, expected.message);
    assert.equal(h.persisted.at(-1).failureCode, expected.failureCode);
    assert.doesNotMatch(JSON.stringify([saved, h.persisted]), /private-user|private-password|fixture\.invalid|SDP/);
  });
}

test('cancelled DVR failures retain cancellation instead of becoming codec errors', async () => {
  const h = harness(), started = h.startExportTask(options);
  await flush(); h.exportQueue.cancel(started.taskId);
  h.gates[0].reject(dvrExportError('DVR_AUDIO_CODEC_UNSUPPORTED'));
  await assert.rejects(started[TASK_COMPLETION]);
  const task = h.activeTasks.get(started.taskId);
  assert.equal(task.status, 'cancelled'); assert.equal(task.message, '任务已取消'); assert.equal(task.failureCode, undefined);
});

test('actual legacy admission queues, deduplicates, cancels queued work, and survives failure', async () => {
  const h = harness();
  const a = h.startExportTask(options);
  const b = h.startExportTask({ ...options, channel: '201' });
  const c = h.startExportTask({ ...options, channel: '301' });
  assert.equal(b.status, 'queued'); assert.equal(b.queuePosition, 1);
  assert.equal(h.activeTasks.get(b.taskId).progress, null);
  assert.equal(h.startExportTask({ ...options, channel: '201' }).taskId, b.taskId);
  assert.equal(h.previewsStopped(), 1);
  assert.equal(h.previewGeneration(), 1, 'only admitted running export invalidates pending live preview');
  await flush(); assert.equal(h.calls.length, 1);
  h.hook(a.taskId, 'completed', 100, 'pipeline reported terminal before cleanup');
  assert.equal(h.startExportTask(options).taskId, a.taskId);
  h.exportQueue.cancel(b.taskId); await assert.rejects(b[TASK_COMPLETION]);
  assert.equal(h.activeTasks.get(c.taskId).queuePosition, 1);
  h.exportQueue.cancel(a.taskId); await flush(); assert.equal(h.calls.length, 1);
  h.gates[0].reject(new Error('cancelled after cleanup')); await assert.rejects(a[TASK_COMPLETION]);
  await flush(); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].channel, '301');
  assert.equal(h.previewGeneration(), 2);
  h.gates[1].resolve('/fixture/clip.mp4'); await c[TASK_COMPLETION];
  assert.equal(h.activeTasks.get(c.taskId).status, 'completed');
});

test('actual camera outer lease encompasses nested export and cleanup, then starts legacy', async () => {
  const h = harness(), afterPipeline = deferred();
  const job = { kind: 'clip', requestKey: 'camera-request', cameraId: 'D1', start: '2026-01-01 10:00:00', end: '2026-01-01 10:01:00',
    async execute({ reservation }) {
      const nested = h.startExportTask({ ...options, [TASK_RESERVATION]: reservation });
      assert.equal(nested.ok, true); await nested[TASK_COMPLETION];
      await afterPipeline.promise;
      return { camera: 'D1', source: 'hikvision' };
    } };
  const a = h.startExportTask({ [CAMERA_JOB]: job });
  const b = h.startExportTask({ ...options, channel: '201' });
  assert.equal(h.startExportTask({ [CAMERA_JOB]: job }).taskId, a.taskId);
  await flush(); assert.equal(h.calls.length, 1);
  h.gates[0].resolve('/fixture/nested.mp4'); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.exportQueue.owns(a.taskId), true);
  afterPipeline.resolve(); await flush(); assert.equal(h.calls.length, 2);
  h.gates[1].resolve('/fixture/second.mp4'); await b[TASK_COMPLETION];
  assert.equal(h.activeTasks.get(a.taskId).status, 'completed');
});

test('actual stop endpoint cancels waiting work and reports running cleanup without starting next', async () => {
  const h = harness();
  assert.deepEqual(Array.from(h.stopPaths), ['/api/export/stop', '/console/api/export/stop']);
  const invoke = body => { let code = 200, response; const res = { status(c) { code = c; return this; }, json(value) { response = value; return this; } }; h.stopHandler({ body }, res); return { code, response }; };
  assert.equal(invoke({}).code, 400); assert.equal(invoke({ taskId: 'missing' }).code, 404);
  const a = h.startExportTask(options);
  const b = h.startExportTask({ ...options, channel: '201' });
  const c = h.startExportTask({ ...options, channel: '301' });
  await flush();
  assert.equal(invoke({ taskId: b.taskId }).code, 200); await assert.rejects(b[TASK_COMPLETION]);
  assert.equal(h.activeTasks.get(b.taskId).status, 'cancelled');
  assert.equal(invoke({ taskId: a.taskId }).code, 200);
  assert.equal(h.activeTasks.get(a.taskId).status, 'stopping');
  await flush(); assert.equal(h.calls.length, 1);
  h.gates[0].reject(new Error('cancelled')); await assert.rejects(a[TASK_COMPLETION]); await flush();
  assert.equal(h.calls[1].channel, '301');
  h.gates[1].resolve('/fixture/third.mp4'); await c[TASK_COMPLETION];
});

test('invalid legacy requests never enter the queue', () => {
  const h = harness();
  for (const patch of [{ channel: '101\r\n' }, { method: 'bad' }, { endTime: '20250101T100000Z' }, { ip: '' }]) {
    const result = h.startExportTask({ ...options, ...patch });
    assert.equal(result.ok, false); assert.equal(result.status, 400);
  }
  assert.equal(h.activeTasks.size, 0); assert.equal(h.previewsStopped(), 0);
});

function recoveryRecord(channel, status = 'queued') {
  const taskId = crypto.randomUUID();
  return { version: 1, task: { taskId, queuedAt: 10, startTime: 10, filename: `ch${channel}.mp4`, status },
    request: { type: 'legacy', deviceId: 'fixture-device', endpoint: '192.0.2.1', options: { ...options, ip: undefined, user: undefined, pass: undefined, channel } }, publications: [] };
}
test('restart restores same ids, exact channels, one lease and FIFO; terminal/cancelled work never replays', async () => {
  const first = recoveryRecord('201', 'downloading'), second = recoveryRecord('301');
  const cancelled = { ...recoveryRecord('401'), cancelRequested: true }, completed = recoveryRecord('501', 'completed');
  const h = harness({ records: [first, second, cancelled, completed] }); h.recoverExportTasks();
  assert.equal(h.activeTasks.get(first.task.taskId).recovered, true);
  assert.equal(h.activeTasks.get(second.task.taskId).status, 'queued');
  assert.equal(h.activeTasks.get(cancelled.task.taskId).status, 'cancelled');
  await flush(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].channel, '201');
  assert.equal(h.calls[0].taskId, first.task.taskId);
  h.gates[0].resolve('/fixture/one.mp4'); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].channel, '301');
  h.gates[1].resolve('/fixture/two.mp4'); await flush(); assert.equal(h.calls.length, 2);
});
test('missing or changed recorder is surfaced and never falls back to current active recorder', async () => {
  const missing = recoveryRecord('101'); missing.request.deviceId = 'deleted';
  const changed = recoveryRecord('201'); changed.request.endpoint = '192.0.2.99';
  const valid = recoveryRecord('301');
  const h = harness({ records: [missing, changed, valid] }); h.recoverExportTasks(); await flush();
  assert.equal(h.activeTasks.get(missing.task.taskId).status, 'error');
  assert.match(h.activeTasks.get(changed.task.taskId).message, /原录像机/);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].channel, '301');
  h.gates[0].resolve('/fixture/valid.mp4'); await flush();
});
test('completed publication checkpoint finishes recovered task without contacting recorder', async () => {
  const record = recoveryRecord('101', 'converting');
  const h = harness({ records: [record], reconciled: [{ filename: record.task.filename, artifactUrl: '/artifacts/existing.mp4', size: 10 }] });
  h.recoverExportTasks(); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.activeTasks.get(record.task.taskId).status, 'completed');
});
test('cancel intent is recorded while inner legacy pipeline reports completion before outer settlement', async () => {
  const h = harness(); const result = h.startExportTask(options); await flush();
  h.hook(result.taskId, 'completed', 100, 'inner finished');
  assert.equal(h.activeTasks.get(result.taskId).status, 'converting');
  h.exportQueue.cancel(result.taskId);
  assert.equal(h.records.find(record => record.task.taskId === result.taskId).cancelRequested, true);
  h.gates[0].reject(new Error('cancel')); await assert.rejects(result[TASK_COMPLETION]);
});

test('pending rename names reject legacy and camera export admission before registering work', () => {
  const filename = `dvr${deviceCacheKey(options)}_ch${options.channel}_${options.startTime}_to_${options.endTime}.mp4`;
  const h = harness({ reservedNames: [filename, 'reserved.mp4'] });
  assert.equal(h.startExportTask(options).status, 409);
  assert.equal(h.startExportTask({ [CAMERA_JOB]: { kind: 'clip', filename: 'reserved.mp4' } }).status, 409);
  assert.equal(h.activeTasks.size, 0); assert.equal(h.calls.length, 0);
});

test('SDK export stays within the existing queue, preserves timing after progress clones, and never invokes RTSP fallback', async () => {
  const h = harness({ sdk: true });
  const first = h.startExportTask({ ...options, deviceId: 'fixture-device' });
  const second = h.startExportTask({ ...options, deviceId: 'fixture-device', channel: '201' });
  await flush(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].device.id, 'fixture-device'); assert.equal(h.calls[0].channel, '101');
  assert.match(h.calls[0].outputFile, /_sdk_[a-f0-9]{8}\.mp4$/);
  const timing = { requestedStart: options.startTime, requestedEnd: options.endTime, actualDurationSeconds: 59.2,
    timingAccuracy: 'unverified-keyframe', transport: 'hcnetsdk' };
  h.gates[0].resolve(timing); await first[TASK_COMPLETION]; await flush();
  assert.deepEqual(h.activeTasks.get(first.taskId).sdkMetadata, timing);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].device.id, 'fixture-device');
  h.gates[1].reject(Object.assign(new Error('private SDK internals'), { code: 'DVR_SDK_FAILED' }));
  await assert.rejects(second[TASK_COMPLETION]); await flush();
  assert.equal(h.calls.length, 2, 'SDK failures never silently try HTTP or RTSP');
  assert.equal(h.activeTasks.get(second.taskId).failureCode, 'DVR_SDK_FAILED');
  assert.doesNotMatch(h.activeTasks.get(second.taskId).message, /private/);
});


for (const camera of [false, true]) test(`SDK phase timeout crosses actual ${camera ? 'camera-job catch' : 'legacy SDK branch'} and queue settlement safely`, async () => {
  const h = harness({ sdk: true });
  const sdkOptions = { ...options, deviceId: 'fixture-device' };
  const job = { kind: 'clip', requestKey: 'sdk-phase-camera', cameraId: 'fixture-camera', source: 'hikvision',
    start: '2026-01-01 10:00:00', end: '2026-01-01 10:01:00',
    async execute({ reservation }) {
      const nested = h.startExportTask({ ...sdkOptions, [TASK_RESERVATION]: { ...reservation, outputDir: '/fixture/work' } });
      await nested[TASK_COMPLETION];
    } };
  const started = h.startExportTask(camera ? { [CAMERA_JOB]: job } : sdkOptions);
  await flush();
  assert.equal(h.calls[0].device.id, 'fixture-device', 'this is the real SDK branch, not HTTP mp4download');
  const error = Object.assign(new Error('private-native-output /private/path'), { code: 'DVR_SDK_DOWNLOAD_TIMEOUT', sdkFailurePhase: 'wait', sdkPhase: 'cleanup' });
  h.gates[0].reject(error);
  if (started[TASK_COMPLETION]) await assert.rejects(started[TASK_COMPLETION]);
  for (let i = 0; i < 12 && h.exportQueue.owns(started.taskId); i++) await flush();
  const expected = dvrExportFailure(error), task = h.activeTasks.get(started.taskId);
  assert.match(expected.message, /记录的超时步骤：等待录像数据/);
  assert.equal(task.status, 'error'); assert.equal(task.failureCode, expected.failureCode); assert.equal(task.message, expected.message);
  assert.equal(h.persisted.at(-1).message, expected.message);
  assert.equal(h.records.find(record => record.task.taskId === started.taskId).task.message, expected.message);
  assert.equal(h.calls.length, 1, 'no transport fallback');
  assert.doesNotMatch(JSON.stringify([task, h.persisted]), /private-native|private\/path|sdkPhase/);
});

for (const camera of [false, true]) test(`SDK measured media failure survives actual ${camera ? 'camera' : 'legacy'} task settlement`, async () => {
  const h = harness({ sdk: true });
  const sdkOptions = { ...options, deviceId: 'fixture-device' };
  const job = { kind: 'clip', requestKey: 'sdk-media-evidence-camera', cameraId: 'fixture-camera', source: 'hikvision',
    start: '2026-01-01 10:00:00', end: '2026-01-01 10:01:00',
    async execute({ reservation }) {
      const nested = h.startExportTask({ ...sdkOptions, [TASK_RESERVATION]: { ...reservation, outputDir: '/fixture/work' } });
      await nested[TASK_COMPLETION];
    } };
  const started = h.startExportTask(camera ? { [CAMERA_JOB]: job } : sdkOptions); await flush();
  const error = Object.assign(new Error('private-native-stderr'), { code: 'DVR_SDK_VERIFY_FAILED',
    sdkEvidence: { stage: 'decode', requestedSeconds: 60, observedSeconds: 59.2, rawBytes: 12345, stderr: 'private-native-stderr' } });
  h.gates[0].reject(error);
  if (started[TASK_COMPLETION]) await assert.rejects(started[TASK_COMPLETION]);
  for (let i = 0; i < 12 && h.exportQueue.owns(started.taskId); i++) await flush();
  const task = h.activeTasks.get(started.taskId), expected = dvrExportFailure(error);
  assert.match(expected.message, /SDK 成品完整解码失败/); assert.match(expected.message, /成品探测 59.2 秒/);
  assert.equal(task.status, 'error'); assert.equal(task.failureCode, expected.failureCode); assert.equal(task.message, expected.message);
  assert.equal(h.persisted.at(-1).message, expected.message);
  assert.equal(h.records.find(record => record.task.taskId === started.taskId).task.message, expected.message);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(JSON.stringify([task, h.persisted]), /private-native|sdkEvidence|stderr/);
});
