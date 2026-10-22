import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { dvrExportError, dvrExportFailure, isDvrExportError, sanitizeSdkPhase, sanitizeSdkFailureEvidence } from '../lib/dvr-export-errors.js';
import { createExportRecoveryStore } from '../lib/export-recovery.js';
import { createMediaJobStore } from '../lib/media-job-store.js';

const privateText = 'rtsp://private-user:private-password@fixture.invalid/Streaming/tracks/201 a=rtpmap rawstderr';
const codes = ['DVR_SDK_DOWNLOAD_TIMEOUT', 'DVR_SDK_MULTIPART', 'DVR_SDK_BYTE_LIMIT', 'DVR_SDK_PROCESS_TIMEOUT', 'DVR_AUTH_FAILED', 'DVR_CONNECTION_FAILED', 'DVR_RTSP_TIMEOUT', 'DVR_RTSP_REJECTED', 'DVR_NOT_FOUND',
  'DVR_NO_VIDEO', 'DVR_VIDEO_CODEC_UNSUPPORTED', 'DVR_AUDIO_CODEC_UNSUPPORTED', 'DVR_AUDIO_INVALID', 'DVR_STREAM_INVALID',
  'DVR_NO_DATA', 'DVR_VIDEO_INCOMPLETE', 'DVR_AUDIO_INCOMPLETE', 'DVR_MUX_FAILED', 'DVR_VERIFY_FAILED', 'DVR_EXPORT_FAILED'];

test('DVR failure vocabulary never reflects source text, even with a recognized code', () => {
  for (const code of [...codes, '__proto__', 'constructor', privateText, '', null, 401]) {
    const input = { code, message: privateText, stderr: privateText, cause: new Error(privateText) };
    const failure = dvrExportFailure(input);
    assert.deepEqual(Object.keys(failure).sort(), ['failureCode', 'message']);
    assert.equal(failure.failureCode, codes.includes(code) ? code : 'DVR_EXPORT_FAILED');
    assert.equal(failure.message, dvrExportError(code).message);
    assert.equal(isDvrExportError(input), codes.includes(code));
    assert.doesNotMatch(JSON.stringify(failure), /private-|fixture\.invalid|Streaming|rtsp:\/\/|rtpmap|rawstderr/);
  }
  for (const error of [null, undefined, {}, new Error(privateText)]) assert.equal(dvrExportFailure(error).failureCode, 'DVR_EXPORT_FAILED');
});

test('classified DVR failures survive both real durable stores and restart without private error data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-error-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queueRoot = path.join(root, 'queue'), mediaRoot = path.join(root, 'media');
  const recovery = createExportRecoveryStore(queueRoot), media = createMediaJobStore(mediaRoot);
  for (const code of [...codes, 'external-error-code']) {
    const task = { taskId: crypto.randomUUID(), source: 'hikvision', queuedAt: 10, status: 'queued' };
    recovery.admit(task, { type: 'camera', deviceId: 'fixture' });
    Object.assign(task, { status: 'error', privateError: privateText }, dvrExportFailure({ code, message: privateText }));
    recovery.update(task); media.save(task);
    const restored = createExportRecoveryStore(queueRoot).load().find(record => record.task.taskId === task.taskId).task;
    const displayed = createMediaJobStore(mediaRoot).read(task.taskId);
    for (const actual of [restored, displayed]) {
      assert.equal(actual.failureCode, task.failureCode); assert.equal(actual.message, task.message); assert.equal(actual.status, 'error');
      assert.doesNotMatch(JSON.stringify(actual), /private-|fixture\.invalid|rtsp:\/\/|rtpmap|rawstderr/);
    }
  }
  for (const folder of [queueRoot, mediaRoot]) for (const name of fs.readdirSync(folder)) {
    assert.doesNotMatch(fs.readFileSync(path.join(folder, name), 'utf8'), /private-|fixture\.invalid|rtsp:\/\/|rtpmap|rawstderr/);
  }
});

test('the actual console task card displays the classified explanation as text', () => {
  const source = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener() {}
  }
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, Date,
    taskStageLabel: () => '', statusText: () => '失败', taskProgressPresentation: () => ({ show: false }), taskProgressCaption: () => '' });
  vm.runInContext(source.slice(source.indexOf('function makeTaskCard('), source.indexOf('async function recoverCloudUpload(')), context);
  for (const code of codes) {
    const failure = dvrExportFailure({ code, message: privateText });
    const card = context.makeTaskCard({ status: 'error', source: 'hikvision', filename: 'fixture.mp4', ...failure }, false);
    assert.equal(card.children.find(element => element.className === 'task-detail').textContent, failure.message);
  }
});


test('SDK timeout phases choose only fixed messages and survive durable stores without phase fields', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-phase-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recovery = createExportRecoveryStore(path.join(root, 'queue'));
  const media = createMediaJobStore(path.join(root, 'media'));
  const phases = ['load', 'init_config', 'init', 'login', 'get_file', 'play_start', 'wait', 'osd', 'stop', 'logout', 'cleanup'];
  const messages = new Set();
  for (const [source, sdkPhase] of phases.flatMap(phase => [['sdkPhase', phase], ['sdkFailurePhase', phase]])) {
    assert.equal(sanitizeSdkPhase(sdkPhase), sdkPhase);
    const failure = dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT', [source]: sdkPhase, message: privateText, path: privateText });
    assert.deepEqual(Object.keys(failure), ['failureCode', 'message']);
    assert.match(failure.message, /(?:停止前最后记录的步骤|记录的超时步骤)/); messages.add(failure.message);
    const task = { taskId: crypto.randomUUID(), source: 'hikvision', status: 'queued', queuedAt: 10 };
    recovery.admit(task, { type: 'camera', deviceId: 'fixture' });
    Object.assign(task, { status: 'error' }, failure); recovery.update(task); media.save(task);
    for (const actual of [createExportRecoveryStore(path.join(root, 'queue')).load().find(record => record.task.taskId === task.taskId).task, media.read(task.taskId)]) {
      assert.equal(actual.failureCode, failure.failureCode); assert.equal(actual.message, failure.message);
      assert.equal(actual.sdkPhase, undefined); assert.equal(actual.sdkFailurePhase, undefined);
      assert.doesNotMatch(JSON.stringify(actual), /private-|rtsp:|fixture.invalid/);
    }
  }
  assert.equal(messages.size, phases.length * 2);
  const generic = dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT' }).message;
  for (const sdkPhase of [privateText, '__proto__', 'constructor', {}, null, 1]) {
    assert.equal(sanitizeSdkPhase(sdkPhase), undefined);
    assert.equal(dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT', sdkPhase }).message, generic);
  }
  assert.equal(dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT', get sdkPhase() { assert.fail('untrusted getter'); } }).message, generic);
  assert.equal(dvrExportFailure(Object.assign(Object.create({ sdkPhase: 'cleanup' }), { code: 'DVR_SDK_DOWNLOAD_TIMEOUT' })).message, generic);
  assert.equal(dvrExportFailure({ code: 'DVR_SDK_BYTE_LIMIT', sdkPhase: 'cleanup' }).message, dvrExportFailure({ code: 'DVR_SDK_BYTE_LIMIT' }).message);
});


test('frozen SDK failure phase has precedence over successful cleanup without reflecting fields', () => {
  const failure = dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT', sdkFailurePhase: 'wait', sdkPhase: 'cleanup', message: privateText });
  assert.match(failure.message, /记录的超时步骤：等待录像数据/);
  assert.doesNotMatch(failure.message, /清理 SDK/);
  assert.deepEqual(Object.keys(failure), ['failureCode', 'message']);
  assert.equal(dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT', sdkFailurePhase: privateText }).message,
    dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT' }).message);
  assert.equal(dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT', get sdkFailurePhase() { assert.fail('untrusted getter'); } }).message,
    dvrExportFailure({ code: 'DVR_SDK_DOWNLOAD_TIMEOUT' }).message);
});


test('SDK failure evidence accepts only own bounded numeric observations and closed stages', () => {
  assert.deepEqual(sanitizeSdkFailureEvidence({ stage: 'verify', requestedSeconds: 3600, observedSeconds: 86400, rawBytes: 2 * 1024 ** 3, path: privateText, codec: privateText }),
    { stage: 'verify', requestedSeconds: 3600, observedSeconds: 86400, rawBytes: 2 * 1024 ** 3 });
  assert.deepEqual(sanitizeSdkFailureEvidence({ observedSeconds: 0.001, rawBytes: 0 }), { observedSeconds: 0.001, rawBytes: 0 });
  assert.deepEqual(sanitizeSdkFailureEvidence({ observedSeconds: 8.212345 }), { observedSeconds: 8.212 });
  for (const value of [null, undefined, [], privateText, {}, Object.create({ stage: 'probe', rawBytes: 0 })]) assert.equal(sanitizeSdkFailureEvidence(value), undefined);
  for (const [key, invalids] of [
    ['stage', [privateText, '__proto__', 'download', 0]],
    ['requestedSeconds', [0, -1, 0.5, 3601, Infinity, NaN, '10', null, true]],
    ['observedSeconds', [0, -1, 0.00001, 86400.001, Infinity, NaN, '10', null, true]],
    ['rawBytes', [-1, 0.5, 2 * 1024 ** 3 + 1, Infinity, NaN, '0', null, true]],
  ]) for (const value of invalids) assert.equal(sanitizeSdkFailureEvidence({ [key]: value }), undefined);
  assert.equal(sanitizeSdkFailureEvidence({ get stage() { assert.fail('untrusted getter'); }, get rawBytes() { assert.fail('untrusted getter'); } }), undefined);
  assert.equal(sanitizeSdkFailureEvidence(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(privateText); } })), undefined);
});

test('SDK media templates and timeout byte counts persist without opening the task schema', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-media-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recovery = createExportRecoveryStore(path.join(root, 'queue')), media = createMediaJobStore(path.join(root, 'media'));
  for (const [code, stage] of [['DVR_SDK_VERIFY_FAILED', 'probe'], ['DVR_SDK_FAILED', 'remux'], ['DVR_SDK_VERIFY_FAILED', 'verify'], ['DVR_SDK_VERIFY_FAILED', 'decode'], ['DVR_SDK_DOWNLOAD_TIMEOUT', 'decode'], ['DVR_SDK_PROCESS_TIMEOUT', 'decode']]) {
    const failure = dvrExportFailure({ code, sdkFailurePhase: 'wait', message: privateText,
      sdkEvidence: { stage, requestedSeconds: 10, observedSeconds: 8.2, rawBytes: 12345, stderr: privateText, codec: privateText } });
    assert.deepEqual(Object.keys(failure), ['failureCode', 'message']); assert.equal(failure.failureCode, code);
    assert.match(failure.message, /12345 字节/); assert.doesNotMatch(failure.message, /private|rtsp:|codec|stderr/);
    if (code.endsWith('TIMEOUT')) assert.doesNotMatch(failure.message, /请求|成品探测|原始探测/);
    const task = { taskId: crypto.randomUUID(), source: 'hikvision', status: 'queued', queuedAt: 10 };
    recovery.admit(task, { type: 'camera', deviceId: 'fixture' }); Object.assign(task, { status: 'error' }, failure); recovery.update(task); media.save(task);
    for (const actual of [createExportRecoveryStore(path.join(root, 'queue')).load().find(record => record.task.taskId === task.taskId).task, media.read(task.taskId)]) {
      assert.equal(actual.message, failure.message); assert.equal(actual.failureCode, code); assert.equal(actual.sdkEvidence, undefined);
    }
  }
  for (const [code, stage] of [['DVR_SDK_VERIFY_FAILED', 'remux'], ['DVR_SDK_FAILED', 'decode'], ['DVR_SDK_BYTE_LIMIT', 'probe'], ['DVR_AUTH_FAILED', 'probe']]) {
    assert.equal(dvrExportFailure({ code, sdkEvidence: { stage, requestedSeconds: 10, observedSeconds: 8, rawBytes: 7 } }).message, dvrExportFailure({ code }).message);
  }
  assert.equal(dvrExportFailure({ code: 'DVR_SDK_VERIFY_FAILED', get sdkEvidence() { assert.fail('untrusted getter'); } }).message,
    dvrExportFailure({ code: 'DVR_SDK_VERIFY_FAILED' }).message);
});
