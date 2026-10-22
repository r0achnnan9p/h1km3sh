import { sanitizeSdkMetadata } from '../lib/dvr-sdk.js';
import { sanitizeDvrHttpSample } from '../lib/dvr-http-sample.js';
/** Offline-only: no recorder, service logs, device configuration, or real credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { pullRtspRaw } from '../lib/rtsp-client.js';
import { runRtspClipExport } from '../lib/rtsp-clip-export.js';
import { dvrExportError, dvrExportFailure, dvrRtspFailureDiagnostics, isDvrExportError } from '../lib/dvr-export-errors.js';
import { createExportRecoveryStore } from '../lib/export-recovery.js';
import { createMediaJobStore } from '../lib/media-job-store.js';
import { createExportQueue } from '../lib/export-queue.js';

const privateText = 'rtsp://private-user:private-password@fixture.invalid/Streaming/tracks/201?private-token SDP rawstderr';
const assertSafe = value => assert.doesNotMatch(JSON.stringify(value), /private-|fixture\.invalid|Streaming|rtsp:\/\/|SDP|rawstderr/);
const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtsp-diagnostic-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const stages = [{ method: 'DESCRIBE', setupMedia: null }, { method: 'SETUP', setupMedia: 'video' }, { method: 'SETUP', setupMedia: 'audio' }, { method: 'PLAY', setupMedia: null }];
function recorder(t, { method, setupMedia, rtspStatus, authFirst = false, socketFailure } = {}) {
  const root = temp(t), socket = new EventEmitter(), requests = [];
  let closed = false, challenged = false;
  const close = () => { if (!closed) { closed = true; socket.emit('close'); } };
  socket.setTimeout = socket.setNoDelay = socket.pause = socket.resume = () => {};
  socket.destroy = close;
  socket.write = request => {
    const [currentMethod, uri] = request.split(' ');
    const media = currentMethod === 'SETUP' ? uri.includes('trackID=audio') ? 'audio' : 'video' : null;
    requests.push({ method: currentMethod, setupMedia: media });
    if (currentMethod === 'TEARDOWN') { setImmediate(close); return true; }
    if (socketFailure) { setImmediate(() => socket.emit(socketFailure, new Error(privateText))); return true; }
    const challenge = authFirst && !challenged;
    if (challenge) challenged = true;
    const status = challenge ? 401 : currentMethod === method && media === setupMedia ? rtspStatus : 200;
    const body = currentMethod === 'DESCRIBE' ? [
      'v=0', 'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000', 'a=control:trackID=video',
      'm=audio 0 RTP/AVP 104', 'a=rtpmap:104 MPEG4-GENERIC/16000', 'a=control:trackID=audio',
      'a=fmtp:104 config=1408;SizeLength=13;IndexLength=3;IndexDeltaLength=3;', `s=${privateText}`,
    ].join('\r\n') : privateText;
    setImmediate(() => socket.emit('data', Buffer.from(`RTSP/1.0 ${status} ${privateText}\r\n${challenge ? 'WWW-Authenticate: Digest realm="synthetic", nonce="synthetic"\r\n' : ''}${currentMethod === 'SETUP' && status === 200 ? 'Session: synthetic-session\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)));
    return true;
  };
  const result = pullRtspRaw({ ip: 'fixture.invalid', user: 'synthetic', pass: 'synthetic',
    path: '/Streaming/tracks/201?starttime=20261001T214025Z&endtime=20261001T214035Z',
    outStream: new Writable({ write(_chunk, _encoding, callback) { callback(); } }), audioOutPath: path.join(root, 'audio.aac'),
    connectTimeoutMs: 1000, maxWallMs: 3000,
    createConnection: () => { setImmediate(() => socket.emit('connect')); return socket; } });
  return { result, requests };
}

for (const stage of stages) for (const rtspStatus of [400, 401, 403, 404, 453, 454, 456, 457, 459, 460, 461, 500]) {
  test(`terminal ${stage.method} ${stage.setupMedia || ''} ${rtspStatus} retains only safe diagnostic fields`, async t => {
    const f = recorder(t, { ...stage, rtspStatus });
    await assert.rejects(f.result, error => {
      const code = rtspStatus === 401 ? 'DVR_AUTH_FAILED' : rtspStatus === 404 ? 'DVR_NOT_FOUND' : 'DVR_RTSP_REJECTED';
      assert.equal(error.code, code); assert.equal(error.message, dvrExportError(code).message);
      const auth = stage.method === 'DESCRIBE' ? { digestChallengeSeen: false, authorizationSent: false, describeRequests: 1 } : {};
      assert.deepEqual(error.failureDiagnostics, { ...stage, rtspStatus, ...auth });
      assert.deepEqual(Object.keys(error.failureDiagnostics).sort(), [...['method', 'rtspStatus', 'setupMedia'], ...Object.keys(auth)].sort());
      assertSafe(error); assertSafe(dvrExportFailure(error)); return true;
    });
    assert.equal(f.requests.filter(r => r.method === 'TEARDOWN').length, stage.method === 'PLAY' || stage.setupMedia === 'audio' ? 1 : 0);
  });
}

test('successful authentication retry is not mistaken for the final PLAY failure', async t => {
  const f = recorder(t, { method: 'PLAY', setupMedia: null, rtspStatus: 457, authFirst: true });
  await assert.rejects(f.result, error => {
    assert.equal(error.code, 'DVR_RTSP_REJECTED');
    assert.deepEqual(error.failureDiagnostics, { method: 'PLAY', rtspStatus: 457, setupMedia: null }); return true;
  });
  assert.equal(f.requests.filter(r => r.method === 'DESCRIBE').length, 2);
});
for (const socketFailure of ['timeout', 'error']) test(`${socketFailure} has no invented RTSP response`, async t => {
  await assert.rejects(recorder(t, { socketFailure }).result, error => {
    assert.equal(error.failureDiagnostics, undefined); assertSafe(error); return true;
  });
});
test('malformed RTSP status is classified without leaking its source text', async t => {
  await assert.rejects(recorder(t, { method: 'DESCRIBE', setupMedia: null, rtspStatus: 'invalid-private-token' }).result, error => {
    assert.equal(error.code, 'DVR_RTSP_REJECTED'); assert.equal(error.failureDiagnostics, undefined); assertSafe(error); return true;
  });
});

test('diagnostic allowlist rejects arbitrary objects, accessors, inherited fields and serializers', () => {
  const good = { method: 'SETUP', rtspStatus: 461, setupMedia: 'audio' };
  const dirty = { ...good, uri: privateText, headers: { Authorization: privateText }, body: privateText, stderr: privateText, toJSON: () => privateText };
  const clean = dvrRtspFailureDiagnostics(dirty);
  assert.deepEqual(clean, good); assertSafe(clean); assert.notEqual(clean, dirty);
  for (const value of [null, undefined, privateText, [], Object.create(good), { method: good },
    { ...good, method: privateText }, { ...good, method: new String('PLAY') },
    ...[privateText, '461', null, {}, NaN, Infinity, -1, 99, 600, 461.5].map(rtspStatus => ({ ...good, rtspStatus })),
    { get method() { throw new Error('must not evaluate accessor'); }, rtspStatus: 461 },
  ]) assert.equal(dvrRtspFailureDiagnostics(value), undefined);
  assert.deepEqual(dvrRtspFailureDiagnostics({ ...good, setupMedia: privateText }), { ...good, setupMedia: null });
  assert.deepEqual(dvrRtspFailureDiagnostics({ ...good, method: 'PLAY' }), { method: 'PLAY', rtspStatus: 461, setupMedia: null });
  assert.equal(dvrExportFailure({ code: privateText, failureDiagnostics: good }).failureDiagnostics, undefined);
});

test('real export cleanup preserves the sanitized terminal reply', async t => {
  const good = { method: 'SETUP', rtspStatus: 454, setupMedia: 'audio' };
  await assert.rejects(runRtspClipExport({ ip: 'fixture.invalid', user: 'fixture', pass: 'fixture', channel: '201',
    startTime: '20261001T214025Z', endTime: '20261001T214035Z', taskId: 'synthetic', sseClients: [], outputDir: temp(t),
    pullSegment: async () => { throw Object.assign(new Error(privateText), { code: 'DVR_RTSP_REJECTED', failureDiagnostics: { ...good, uri: privateText } }); },
  }), error => {
    assert.equal(error.message, dvrExportError('DVR_RTSP_REJECTED').message); assert.deepEqual(error.failureDiagnostics, good); assertSafe(error); return true;
  });
});

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function queueHarness(root) {
  const recoveryStore = createExportRecoveryStore(path.join(root, 'queue')), mediaJobs = createMediaJobStore(path.join(root, 'media'));
  const context = vm.createContext({sanitizeSdkMetadata,  sanitizeDvrHttpSample, dvrHttpSampleControl: { available: () => false }, createExportQueue, recoveryStore, mediaJobs, dvrExportFailure, dvrRtspFailureDiagnostics, isDvrExportError,
    console, getAllDevices: () => ({ devices: [] }), consoleUploadJobs: () => [], uploadQueue: { activeCount: () => 0 }, cloud189Queue: { activeCount: () => 0 }, readConsoleSettings: () => ({}), consoleIntegrations: () => ({}),
    recordTaskOutcome() {},
  });
  vm.runInContext(`let sseClients = []; let consolePreviewGeneration = 0; let activePreview = null;
    ${slice('const activeTasks = new Map();', '// A read-only secondary instance')}
    function broadcastProgress(taskId, status, progress, message) { Object.assign(activeTasks.get(taskId), { status, progress, message }); }
    ${slice('function getDashboardStatus()', "app.post('/api/bilibili/prepare'")}
    ${slice('function signedMediaTask(', "app.get('/api/media-jobs/:id'")}
    globalThis.api = { activeTasks, exportQueue, getDashboardStatus, signedMediaTask };`, context);
  return { ...context.api, recoveryStore, mediaJobs };
}
test('actual queue settlement, dashboard and both durable stores preserve safe diagnostics after restart', async t => {
  const root = temp(t), h = queueHarness(root), task = { taskId: crypto.randomUUID(), source: 'hikvision', cameraJob: true, queuedAt: 10, status: 'queued' };
  const good = { method: 'PLAY', rtspStatus: 457, setupMedia: null };
  h.activeTasks.set(task.taskId, task); h.recoveryStore.admit(task, { type: 'camera', deviceId: 'synthetic' });
  await assert.rejects(h.exportQueue.submit(task, async () => { throw Object.assign(new Error(privateText), { code: 'DVR_RTSP_REJECTED', failureDiagnostics: { ...good, body: privateText, uri: privateText } }); }));
  const restored = createExportRecoveryStore(path.join(root, 'queue')).load()[0].task;
  const displayed = createMediaJobStore(path.join(root, 'media')).read(task.taskId);
  for (const actual of [h.activeTasks.get(task.taskId), ...h.getDashboardStatus().tasks, restored, displayed]) {
    assert.equal(actual.status, 'error'); assert.equal(actual.failureCode, 'DVR_RTSP_REJECTED');
    assert.equal(actual.message, dvrExportError('DVR_RTSP_REJECTED').message); assert.deepEqual(actual.failureDiagnostics, good); assertSafe(actual);
  }
  // Storage and dashboard boundaries sanitize again, even if a caller supplied a dirty object.
  task.failureDiagnostics = { ...good, uri: privateText, setupMedia: privateText, toJSON: () => privateText };
  h.recoveryStore.update(task); h.mediaJobs.save(task);
  assert.deepEqual(h.getDashboardStatus().tasks[0].failureDiagnostics, good);
  assert.deepEqual(h.signedMediaTask(task).failureDiagnostics, good); assertSafe(h.signedMediaTask(task));
  for (const folder of ['queue', 'media']) for (const name of fs.readdirSync(path.join(root, folder))) {
    const raw = fs.readFileSync(path.join(root, folder, name), 'utf8'); assertSafe(JSON.parse(raw));
    const data = JSON.parse(raw); assert.deepEqual((data.task || data).failureDiagnostics, good);
  }
});

test('task card keeps fixed error text and renders only bounded RTSP diagnostics as text', () => {
  const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
  class Element { constructor(tag) { this.tag = tag; this.children = []; this.style = {}; } append(...children) { this.children.push(...children); } setAttribute() {} addEventListener() {} }
  const context = vm.createContext({sanitizeSdkMetadata,  document: { createElement: tag => new Element(tag) }, Date,
    taskStageLabel: () => '', statusText: () => '失败', taskProgressPresentation: () => ({ show: false }), taskProgressCaption: () => '' });
  vm.runInContext(script.slice(script.indexOf('function makeTaskCard('), script.indexOf('async function recoverCloudUpload(')), context);
  const task = { status: 'error', source: 'hikvision', filename: 'synthetic.mp4', ...dvrExportFailure(dvrExportError('DVR_RTSP_REJECTED')) };
  for (const stage of stages) {
    const card = context.makeTaskCard({ ...task, failureDiagnostics: { ...stage, rtspStatus: 454, uri: privateText } }, false);
    assert.equal(card.children.find(n => n.className === 'task-detail').textContent, task.message);
    const diagnostic = card.children.find(n => n.className === 'task-detail task-diagnostic');
    assert.equal(diagnostic.textContent, `RTSP ${stage.method}${stage.setupMedia === 'video' ? '（视频）' : stage.setupMedia === 'audio' ? '（音频）' : ''} · 454`); assertSafe(card);
  }
  for (const failureDiagnostics of [null, { method: privateText, rtspStatus: 454 }, { method: 'PLAY', rtspStatus: privateText }, { method: 'PLAY', rtspStatus: 1000 }]) {
    const card = context.makeTaskCard({ ...task, failureDiagnostics }, false);
    assert.equal(card.children.some(n => n.className === 'task-detail task-diagnostic'), false); assertSafe(card);
  }
  assert.equal(context.makeTaskCard({ ...task, status: 'completed', failureDiagnostics: { method: 'PLAY', rtspStatus: 454 } }, false).children.some(n => n.className === 'task-detail task-diagnostic'), false);
});
