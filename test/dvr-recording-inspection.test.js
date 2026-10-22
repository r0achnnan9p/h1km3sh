/** No real device or service calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { collectDvrRecordingDiagnostics as collectDiagnostics, searchRecordingPage } from '../lib/dvr-recording-inspection.js';
import { rememberRecordingSearch, cachedRecordingSearch } from '../lib/recording-search.js';
import { dvrExportError, dvrExportFailure, dvrRtspFailureDiagnostics } from '../lib/dvr-export-errors.js';
import { pullRtspRaw } from '../lib/rtsp-client.js';
import { runRtspClipExport } from '../lib/rtsp-clip-export.js';
import { createExportRecoveryStore } from '../lib/export-recovery.js';
import { createMediaJobStore } from '../lib/media-job-store.js';

// Keep every legacy fixture offline while exercising the new closed field.
const collectDvrRecordingDiagnostics = (options, deps) => collectDiagnostics(options, { capabilities: async () => 'unknown', ...deps });
const compact = { startTime: '20261001T214026Z', endTime: '20261001T214036Z' };
const iso = { startTime: '2026-10-01T21:40:26Z', endTime: '2026-10-01T21:40:36Z' };
const secret = 'private-user private-password private-selector rtsp://private-host/secret SDP rawstderr';
const safe = value => assert.doesNotMatch(JSON.stringify(value), /private-|rtsp:\/\/|SDP|rawstderr/);
const base = { ip: '192.0.2.44', httpPort: 8080, rtspPort: 8554, user: 'private-user', pass: 'private-password', channel: '201' };
const file = { ...iso, channel: '201', size: 123456,
  playbackURI: 'rtsp://192.0.2.44:8554/Streaming/tracks/201/?starttime=20261001T214020Z&endtime=20261001T214050Z&name=private-selector&size=123456' };
const queryOptions = { ...base, ...compact };
const summary = async () => collectDvrRecordingDiagnostics(queryOptions, { lookup: () => [file], search: () => assert.fail('must reuse cached results') });
const failed = code => ({ outcome: code, source: 'search', matchCount: 0, truncated: false, recordings: [] });
const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-inspect-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('cached covering search is reused without another request or clock conversion', async () => {
  const cacheOptions = { ...base, ...iso, user: 'cache-fixture' };
  rememberRecordingSearch({ ...cacheOptions, startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-02T00:00:00Z' }, [file]);
  let requests = 0;
  const result = await collectDvrRecordingDiagnostics({ ...queryOptions, user: cacheOptions.user }, { search: () => { requests++; throw new Error(secret); } });
  assert.equal(requests, 0); assert.equal(result.source, 'cache'); assert.equal(result.outcome, 'available');
  assert.equal(result.recordings[0].uriRange, 'covers'); assert.equal(result.recordings[0].hasName, true); safe(result);
  assert.equal(cachedRecordingSearch({ ...cacheOptions, pass: 'different' }), null);
  assert.equal(cachedRecordingSearch({ ...cacheOptions, channel: '101' }), null);
  assert.equal(cachedRecordingSearch({ ...cacheOptions, endTime: '2026-10-03T00:00:00Z' }), null);
});

test('cache is bounded, expires, and never reuses a narrower query for a wider window', () => {
  const options = { ...base, ...iso, user: 'expiry-fixture' };
  rememberRecordingSearch(options, [file], 1000);
  assert.equal(cachedRecordingSearch(options, 1001).length, 1);
  assert.equal(cachedRecordingSearch({ ...options, startTime: '2026-10-01T21:40:25Z' }, 1001), null);
  assert.equal(cachedRecordingSearch(options, 61000), null);
  for (let i = 0; i < 17; i++) rememberRecordingSearch({ ...options, user: `limit-${i}` }, [file], 100000);
  assert.equal(cachedRecordingSearch({ ...options, user: 'limit-0' }, 100001), null);
  assert.equal(cachedRecordingSearch({ ...options, user: 'limit-16' }, 100001).length, 1);
});

test('cache miss searches exactly the original wall-clock interval once', async () => {
  let calls = 0;
  const result = await collectDvrRecordingDiagnostics(queryOptions, { lookup: () => null, search: async query => {
    calls++; assert.equal(query.ip, base.ip); assert.equal(query.httpPort, base.httpPort); assert.equal(query.channel, base.channel);
    assert.equal(query.startTime, iso.startTime); assert.equal(query.endTime, iso.endTime);
    assert.equal(query.user, base.user); assert.equal(query.pass, base.pass);
    return { files: [file], truncated: true };
  } });
  assert.equal(calls, 1); assert.equal(result.source, 'search'); assert.equal(result.truncated, true); safe(result);
});

test('single-page reader clamps response bytes, timeout and pagination without following redirects', async () => {
  let bodyPath, calls = 0;
  const result = await searchRecordingPage({ ...base, ...iso }, { exec: async (command, args, options) => {
    calls++; assert.ok(command === 'curl' || command === 'curl.exe');
    assert.equal(args[0], '--disable', 'ignore implicit curlrc options before reading any other argument');
    assert.equal(args.includes('--max-redirs'), false); assert.ok(args.includes('--no-location'));
    assert.equal(args.includes('-L'), false); assert.equal(args.includes('--location'), false);
    assert.equal(args.at(-1), 'http://192.0.2.44:8080/ISAPI/ContentMgmt/search');
    assert.equal(args.includes('/ISAPI/ContentMgmt/download'), false);
    assert.equal(options.maxBuffer, 1024 * 1024); assert.equal(options.timeout, 5000); assert.equal(options.killSignal, 'SIGKILL');
    bodyPath = args[args.indexOf('--data-binary') + 1].slice(1);
    const xml = fs.readFileSync(bodyPath, 'utf8');
    assert.match(xml, /<trackID>201<\/trackID>/); assert.match(xml, /<maxResults>40<\/maxResults>/);
    assert.match(xml, /<searchResultPostion>0<\/searchResultPostion>/);
    assert.ok(xml.includes(`<startTime>${iso.startTime}</startTime>`)); assert.ok(xml.includes(`<endTime>${iso.endTime}</endTime>`));
    assert.doesNotMatch(xml, /private-/);
    return { stdout: '<CMSearchResult><responseStatus>true</responseStatus><numOfMatches>0</numOfMatches></CMSearchResult>\n200' };
  } });
  assert.equal(calls, 1); assert.equal(fs.existsSync(bodyPath), false); assert.deepEqual(result, { files: [], truncated: false });
});

test('reader rejects HTTP redirect, auth and arbitrary XML without reflecting any raw payload', async () => {
  for (const [stdout, code] of [
    [secret + '\n302', 'FAILED'], [secret + '\n401', 'AUTHENTICATION'], [secret + '\n403', 'AUTHENTICATION'],
    ['<ResponseStatus><subStatusCode>notSupport</subStatusCode></ResponseStatus>\n200', 'UNSUPPORTED'],
    [secret + '\n200', 'INVALID'],
  ]) {
    await assert.rejects(searchRecordingPage({ ...base, ...iso }, { exec: async () => ({ stdout }) }), error => {
      assert.equal(error.code, code); safe(error); assert.doesNotMatch(error.message, /private-/); return true;
    });
  }
});

for (const [error, expected] of [[Object.assign(new Error(secret), { code: 'AUTHENTICATION' }), 'authentication'],
  [Object.assign(new Error(secret), { code: 'UNSUPPORTED' }), 'unsupported'], [Object.assign(new Error(secret), { code: 'INVALID' }), 'invalid'],
  [Object.assign(new Error(secret), { code: 28 }), 'timeout'], [new Error(secret), 'failed']]) {
  test(`search failure becomes closed ${expected} outcome`, async () => {
    const result = await collectDvrRecordingDiagnostics(queryOptions, { lookup: () => null, search: async () => { throw error; } });
    assert.deepEqual(result, { ...failed(expected), downloadByTime: 'unknown' }); safe(result);
  });
}

test('diagnostic reader deadline aborts a stuck request and settles without raw text', async () => {
  let aborted = false;
  const result = await collectDvrRecordingDiagnostics(queryOptions, { lookup: () => null, budgetMs: 15, search: ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {});
  } });
  assert.equal(aborted, true); assert.deepEqual(result, { ...failed('timeout'), downloadByTime: 'unknown' }); safe(result);
});

test('cancellation aborts metadata inspection; an already-cancelled task never searches', async () => {
  const controller = new AbortController(); let aborted = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  const result = collectDvrRecordingDiagnostics({ ...queryOptions, signal: controller.signal }, { lookup: () => null, search: ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }); started(); return new Promise(() => {});
  } });
  await ready; controller.abort(); assert.equal((await result).outcome, 'cancelled'); assert.equal(aborted, true);
  assert.equal((await collectDvrRecordingDiagnostics({ ...queryOptions, signal: controller.signal }, { search: () => assert.fail('must not search') })).outcome, 'cancelled');
});

for (const startTime of ['20261301T214026Z', '20260230T214026Z', compact.startTime + '\n', secret]) {
  test('invalid compact time cannot enter metadata XML', async () => {
    assert.equal((await collectDvrRecordingDiagnostics({ ...queryOptions, startTime }, { lookup: () => assert.fail('must not look up'), search: () => assert.fail('must not search') })).outcome, 'invalid');
  });
}

async function authenticationTrace(statuses) {
  const socket = new EventEmitter(); let closed = false, index = 0;
  socket.setTimeout = socket.setNoDelay = socket.pause = socket.resume = () => {};
  socket.destroy = () => { if (!closed) { closed = true; socket.emit('close'); } };
  socket.write = () => {
    const status = statuses[index++];
    setImmediate(() => socket.emit('data', Buffer.from(`RTSP/1.0 ${status} fixture\r\n${status === 401 ? 'WWW-Authenticate: Digest realm="fixture", nonce="fixture"\r\n' : ''}Content-Length: 0\r\n\r\n`))); return true;
  };
  try { await pullRtspRaw({ ip: 'fixture.invalid', user: 'fixture', pass: 'fixture', path: '/Streaming/tracks/201',
    outStream: new Writable({ write(_data, _encoding, done) { done(); } }),
    createConnection: () => { setImmediate(() => socket.emit('connect')); return socket; },
  }); } catch (error) { return error; }
  assert.fail('must reject');
}
test('first-response 400 and authenticated DESCRIBE 400 have distinct safe facts', async () => {
  const first = await authenticationTrace([400]), challenged = await authenticationTrace([401, 400]);
  assert.deepEqual(first.failureDiagnostics, { method: 'DESCRIBE', rtspStatus: 400, setupMedia: null, digestChallengeSeen: false, authorizationSent: false, describeRequests: 1 });
  assert.deepEqual(challenged.failureDiagnostics, { method: 'DESCRIBE', rtspStatus: 400, setupMedia: null, digestChallengeSeen: true, authorizationSent: true, describeRequests: 2 });
  safe(first); safe(challenged);
  const repeated = await authenticationTrace([401, 401]); assert.equal(repeated.code, 'DVR_AUTH_FAILED'); assert.equal(repeated.failureDiagnostics.describeRequests, 2);
});

test('export adds one recording inspection only for DESCRIBE 400, preserving primary failure', async t => {
  const root = temp(t); let inspections = 0;
  const expected = await summary();
  for (const [method, status] of [['DESCRIBE', 400], ['DESCRIBE', 403], ['SETUP', 400], ['PLAY', 400]]) {
    const initial = dvrExportError('DVR_RTSP_REJECTED', { method, rtspStatus: status, setupMedia: null });
    await assert.rejects(runRtspClipExport({ ...base, ...compact, taskId: 'synthetic', sseClients: [], outputDir: root,
      pullSegment: async () => { throw initial; }, inspectRecordingFailure: async query => {
        inspections++; assert.equal(query.startTime, compact.startTime); assert.equal(query.endTime, compact.endTime); return expected;
      },
    }), error => {
      assert.equal(error.code, initial.code); assert.equal(error.message, initial.message);
      assert.deepEqual(error.failureDiagnostics.recording, method === 'DESCRIBE' && status === 400 ? expected : undefined); safe(error); return true;
    });
  }
  assert.equal(inspections, 1);
});

test('metadata exception preserves RTSP primary error; metadata cancellation retains task cancellation', async t => {
  const root = temp(t);
  const initial = dvrExportError('DVR_RTSP_REJECTED', { method: 'DESCRIBE', rtspStatus: 400, setupMedia: null });
  await assert.rejects(runRtspClipExport({ ...base, ...compact, taskId: 'synthetic', sseClients: [], outputDir: root,
    pullSegment: async () => { throw initial; }, inspectRecordingFailure: async () => { throw new Error(secret); },
  }), error => { assert.equal(error.message, initial.message); assert.deepEqual(error.failureDiagnostics.recording, failed('failed')); safe(error); return true; });
  const controller = new AbortController();
  await assert.rejects(runRtspClipExport({ ...base, ...compact, taskId: 'synthetic', sseClients: [], outputDir: root, signal: controller.signal,
    pullSegment: async () => { throw initial; }, inspectRecordingFailure: async () => { controller.abort(); return failed('cancelled'); },
  }), /导出已取消/);
});

test('closed auth and recording facts survive both stores without raw properties or serializers', async t => {
  const root = temp(t), recording = await summary();
  const dirty = { method: 'DESCRIBE', rtspStatus: 400, setupMedia: null, digestChallengeSeen: true, authorizationSent: true, describeRequests: 2,
    recording: { ...recording, uri: secret, toJSON: () => secret, recordings: recording.recordings.map(item => ({ ...item, uri: secret, name: secret })) } };
  const error = dvrExportError('DVR_RTSP_REJECTED', dirty), task = { taskId: crypto.randomUUID(), queuedAt: 10, status: 'error', source: 'hikvision', ...dvrExportFailure(error) };
  const queue = createExportRecoveryStore(path.join(root, 'queue')), media = createMediaJobStore(path.join(root, 'media'));
  queue.admit(task, { type: 'camera', deviceId: 'fixture' }); media.save(task);
  for (const actual of [createExportRecoveryStore(path.join(root, 'queue')).load()[0].task, createMediaJobStore(path.join(root, 'media')).read(task.taskId)]) {
    assert.deepEqual(actual.failureDiagnostics.recording, recording); assert.equal(actual.failureDiagnostics.authorizationSent, true); safe(actual);
  }
  const sanitized = dvrRtspFailureDiagnostics({ ...dirty, describeRequests: 999, authorizationSent: secret, digestChallengeSeen: {} });
  assert.equal(sanitized.describeRequests, undefined); assert.equal(sanitized.authorizationSent, undefined); assert.equal(sanitized.digestChallengeSeen, undefined); safe(sanitized);
});

test('task card displays only closed auth and recording text; raw playback URI is never rendered', async () => {
  const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
  class Element { constructor(tag) { this.tag = tag; this.children = []; this.style = {}; } append(...nodes) { this.children.push(...nodes); } setAttribute() {} addEventListener() {} }
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, Date, taskStageLabel: () => '', statusText: () => '失败', taskProgressPresentation: () => ({ show: false }), taskProgressCaption: () => '' });
  vm.runInContext(script.slice(script.indexOf('function makeTaskCard('), script.indexOf('async function recoverCloudUpload(')), context);
  const failureDiagnostics = { method: 'DESCRIBE', rtspStatus: 400, setupMedia: null, authorizationSent: true, recording: await summary() };
  const card = context.makeTaskCard({ status: 'error', filename: 'synthetic.mp4', ...dvrExportFailure(dvrExportError('DVR_RTSP_REJECTED', failureDiagnostics)) }, false);
  assert.equal(card.children.find(n => n.className === 'task-detail task-diagnostic').textContent, 'RTSP DESCRIBE · 400 · 已发送认证');
  assert.match(card.children.find(n => n.className === 'task-detail task-recording-diagnostic').textContent, /查询到 1 段录像.*地址时间覆盖选段.*有文件标识/); safe(card);
});

test('unsuccessful slash fallback is removed from the quick-export path', () => {
  const source = fs.readFileSync(new URL('../lib/rtsp-clip-export.js', import.meta.url), 'utf8');
  assert.match(source, /const result = await pullRtspRaw\(/); assert.doesNotMatch(source, /pullDvrPlaybackRaw|dvr-playback-pull/);
  assert.equal(fs.existsSync(new URL('../lib/dvr-playback-pull.js', import.meta.url)), false);
});
