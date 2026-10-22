import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { dvrExportFailure } from '../lib/dvr-export-errors.js';
import { createDvrSdkPreview } from '../lib/dvr-sdk-preview.js';
import { msToCompact } from '../lib/hik-time.js';

const tick = () => delay(0);
const query = { format: 'sdk', channel: '101', start: '2026-10-01T04:00:00.000Z', duration: '30', client: 'route-client', generation: '1' };
function atom(type, text = '') { const out = Buffer.alloc(8 + text.length); out.writeUInt32BE(out.length); out.write(type, 4); out.write(text, 8); return out; }
const mp4 = Buffer.concat([atom('ftyp'), atom('moov'), atom('mdat', 'fake-h264-payload')]);
class Response extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.headers = {}; this.writableEnded = false; this.destroyed = false; }
  status(value) { this.statusCode = value; return this; }
  set(key, value) { this.headers[key] = value; return this; }
  json(value) { this.body = value; this.writableEnded = true; return this; }
  end() { this.writableEnded = true; return this; }
  disconnect() { this.destroyed = true; this.emit('close'); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-route-'));
  let manager;
  const calls = [], handlers = new Map();
  const context = vm.createContext({ AbortController, msToCompact, exportRecoveryBlocked: false,
    runningTask: null, getRunningTask: () => context.runningTask,
    device: { id: 'dvr-fixture', sdk: { enabled: true } }, getConsoleDvr: () => context.device,
    sdkEnabled: device => device?.sdk?.enabled === true,
    consolePreviewGeneration: 0, activePreview: null, consoleDvrHls: null, consoleDvrSdk: null,
    getConsoleDvrSdk() {
      if (!manager) {
        manager = createDvrSdkPreview({ root, download: options => new Promise((resolve, reject) => {
          calls.push({ ...options, finish() { fs.writeFileSync(options.outputFile, mp4); resolve({ actualDurationSeconds: 29.7 }); }, reject });
        }) });
        context.consoleDvrSdk = manager;
      }
      return manager;
    },
    app: { get(route, handler) { handlers.set(`GET ${route}`, handler); }, post(route, handler) { handlers.set(`POST ${route}`, handler); } },
  });
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const begin = source.indexOf('// SDK preview is an explicit bounded preparation');
  const end = source.indexOf("app.get('/console/api/dvrs/:id/stream', async (req, res) =>", begin);
  assert.ok(begin >= 0 && end > begin, 'extract the actual SDK HTTP route block');
  vm.runInContext(source.slice(begin, end), context);
  function start(overrides = {}, res = new Response()) {
    const req = { params: { id: 'dvr-fixture' }, query: { ...query, ...overrides } };
    const done = handlers.get('GET /console/api/dvrs/:id/stream')(req, res, () => { res.next = true; });
    return { res, done };
  }
  function stop(generation, client = query.client) {
    const res = new Response();
    const done = handlers.get('POST /console/api/dvr-sdk-preview/stop')({ body: { client, generation } }, res);
    return { res, done };
  }
  t.after(async () => { for (const call of calls) call.reject(new Error('fixture cleanup')); await manager?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { context, calls, start, stop, root, get manager() { return manager; } };
}

test('actual SDK route rejects export/recovery gates and malformed bounds before preparation', async t => {
  const f = fixture(t);
  f.context.runningTask = { id: 'export' };
  let attempt = f.start(); await attempt.done; assert.equal(attempt.res.statusCode, 409); assert.equal(f.manager, undefined);
  f.context.runningTask = null; f.context.exportRecoveryBlocked = true;
  attempt = f.start(); await attempt.done; assert.equal(attempt.res.statusCode, 409);
  f.context.exportRecoveryBlocked = false;
  for (const invalid of [{ duration: '0' }, { duration: '31' }, { duration: 'NaN' }, { channel: '102' }, { channel: '101\r\nBAD' }, { start: 'bad-date' }, { start: '2026-02-30T04:00:00.000Z' }, { generation: '-1' }, { client: '../bad' }]) {
    attempt = f.start(invalid); await attempt.done; assert.equal(attempt.res.statusCode, 400, JSON.stringify(invalid));
  }
  assert.equal(f.calls.length, 0);
});

test('actual SDK route preserves current newer preview when stale request or stop arrives', async t => {
  const f = fixture(t), latest = f.start({ generation: '4' }); await tick();
  const session = f.context.activePreview, globalGeneration = f.context.consolePreviewGeneration;
  const stale = f.start({ generation: '2' }); await stale.done;
  assert.equal(stale.res.statusCode, 409); assert.equal(f.context.activePreview, session);
  assert.equal(f.context.consolePreviewGeneration, globalGeneration); assert.equal(f.calls[0].signal.aborted, false);
  const changed = f.start({ generation: '4', channel: '201' }); await changed.done;
  assert.equal(changed.res.statusCode, 409); assert.equal(f.context.activePreview, session);
  assert.equal(f.context.consolePreviewGeneration, globalGeneration); assert.equal(f.calls[0].signal.aborted, false);
  const oldStop = f.stop(3); await oldStop.done; assert.equal(f.calls[0].signal.aborted, false);
  f.calls[0].finish(); await latest.done;
  assert.equal(latest.res.statusCode, 200); assert.equal(latest.res.body.success, true);
  assert.equal(latest.res.body.requestedStartTime, '20261001T120000Z');
  assert.equal(latest.res.headers['Cache-Control'], 'private, no-store');
});

test('actual SDK route coalesces requests and first disconnected waiter does not cancel remaining waiter', async t => {
  const f = fixture(t), first = f.start(); await tick(); const second = f.start(); await tick();
  assert.equal(f.calls.length, 1); const generation = f.context.consolePreviewGeneration;
  first.res.disconnect(); await first.done; assert.equal(f.calls[0].signal.aborted, false);
  f.calls[0].finish(); await second.done;
  assert.equal(second.res.statusCode, 200); assert.equal(second.res.body.success, true);
  assert.equal(f.context.consolePreviewGeneration, generation); assert.equal(f.manager.current.ready, true);
});

test('stop before any SDK preparation creates a tombstone and stale request cannot resurrect', async t => {
  const f = fixture(t), stopping = f.stop(3); await stopping.done;
  assert.equal(stopping.res.statusCode, 204); assert.ok(f.manager);
  const stale = f.start({ generation: '2' }); await stale.done;
  const canceled = f.start({ generation: '3' }); await canceled.done;
  assert.equal(stale.res.statusCode, 409); assert.equal(canceled.res.statusCode, 409);
  assert.equal(f.calls.length, 0); assert.equal(f.context.activePreview, null);
});

test('actual SDK route serializes external teardown across canceled and superseding preparations', async t => {
  const f = fixture(t); let release, stopCalls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  f.context.activePreview = { stop() { stopCalls++; return barrier; } };
  const first = f.start(); await tick(); assert.equal(stopCalls, 1); assert.equal(f.calls.length, 0);
  const stopping = f.stop(2); let stopSettled = false; stopping.done.then(() => { stopSettled = true; });
  const next = f.start({ generation: '3' }); await tick();
  assert.equal(stopSettled, false); assert.equal(f.calls.length, 0);
  release(); await stopping.done; await first.done; await tick();
  assert.equal(first.res.statusCode, 409); assert.equal(f.calls.length, 1);
  f.calls[0].finish(); await next.done; assert.equal(next.res.body.success, true);
});

test('export beginning during SDK preparation prevents a completed media response', async t => {
  const f = fixture(t), preparing = f.start(); await tick();
  const session = f.context.activePreview;
  f.context.runningTask = { id: 'export-started' };
  // This is the queue's required settlement contract: stop preview and await
  // downloader teardown before starting the export's device operation.
  let settled = false; const stopping = session.stop('export starting').then(() => { settled = true; });
  await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(settled, false);
  f.calls[0].finish(); await stopping; await preparing.done;
  assert.equal(preparing.res.statusCode, 409); assert.equal(f.manager.current, null);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('actual export queue onState waits for pending SDK teardown even after source switch clears activePreview', async t => {
  const f = fixture(t), preparing = f.start(); await tick();
  const session = f.context.activePreview;
  const sourceSwitch = session.stop('source switched');
  f.context.activePreview = null;
  Object.assign(f.context, { sseClients: [], recoveryStore: { update() {} }, mediaJobs: { save() {} },
    previewSettlement: Promise.resolve(), consoleDvrHls: null });
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const begin = source.indexOf('  onState(task, status, queuePosition) {');
  const end = source.indexOf('\n  onSettled(task, error)', begin);
  assert.ok(begin >= 0 && end > begin);
  const onState = vm.runInContext(`({${source.slice(begin, end)}}).onState`, f.context);
  onState({ taskId: 'queued-export', controller: new AbortController() }, 'running', null);
  let released = false;
  const exporting = f.context.previewSettlement.then(() => { released = true; });
  await tick(); assert.equal(released, false, 'export must retain the SDK teardown barrier');
  f.calls[0].finish(); await sourceSwitch; await exporting; await preparing.done;
  assert.equal(released, true); assert.equal(f.manager.current, null);
});

for (const kind of ['fmp4', 'live', 'hls']) test(`actual ${kind} route retains pending SDK teardown after MediaMTX cleared activePreview`, async t => {
  const f = fixture(t), preparing = f.start(); await tick();
  const stopping = f.context.activePreview.stop('source changed');
  f.context.activePreview = null; // MediaMTX has no NVR operation to await.
  let handler, starts = 0;
  const replacement = { id: 'hls-fixture', finished: false, wait: async () => {}, stop: async () => {} };
  Object.assign(f.context, {
    app: { get(_path, ...callbacks) { handler = callbacks.at(-1); } },
    CHANNEL_PATTERN: /^\d+$/, DVR_HLS_MAX_SECONDS: 120,
    preparationGuard() {}, checkDvrPreviewGeneration() {}, mainDvrChannel: value => value,
    readConsoleDvrChannels: async () => [], dvrRtspUrl: () => 'rtsp://fixture.invalid/not-connected',
    consoleDvrPreview() { starts++; return replacement; },
    getConsoleDvrHls: () => ({ current: null, accept: () => 2, begin: async () => { starts++; return replacement; } }),
  });
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  let begin, end;
  if (kind === 'fmp4') {
    begin = source.indexOf("app.get('/console/api/dvrs/:id/stream', async (req, res) =>");
    end = source.indexOf('const consoleDvrPreview =', begin);
  } else if (kind === 'live') {
    begin = source.indexOf("app.get('/console/api/dvrs/:id/live', preparationGuard");
    end = source.indexOf("app.post('/console/api/export'", begin);
  } else {
    begin = source.indexOf("app.get('/console/api/dvrs/:id/stream', async (req, res, next) =>");
    end = source.indexOf("app.get('/console/api/dvr-preview/:sessionId/:filename'", begin);
  }
  assert.ok(begin >= 0 && end > begin);
  vm.runInContext(source.slice(begin, end), f.context);
  const res = new Response(); res.redirect = () => res.end();
  const done = handler({ params: { id: 'fixture' }, query: { ...query, format: kind === 'hls' ? 'hls' : 'fmp4', generation: '2' } }, res, () => {});
  await tick(); assert.equal(starts, 0, 'new NVR preview must not overlap SDK teardown');
  f.calls[0].finish(); await stopping; await preparing.done; await done;
  assert.equal(starts, 1); assert.equal(f.manager.current, null);
});

test('SDK waits for actual legacy MJPEG decoder close and RTSP pull settlement', async t => {
  const f = fixture(t), source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  let legacy, releasePull;
  const native = new EventEmitter(); native.stdout = { pipe() {} }; native.stderr = new EventEmitter();
  native.stdin = new EventEmitter(); native.stdin.end = () => {};
  native.signals = []; native.kill = signal => { native.signals.push(signal); };
  Object.assign(f.context, {
    app: { get(_path, callback) { legacy = callback; } }, CHANNEL_PATTERN: /^\d+$/, HIK_COMPACT_TIME_PATTERN: /^\d{8}T\d{6}Z$/,
    compactToMs: () => Date.parse('2026-10-01T12:00:00Z'), resolvePreviewTrack: async () => ({ track: '101', fps: 25 }),
    getChannelFps: async () => 25, ffmpegPath: 'unused', spawn: () => native,
    console: { log() {}, error() {} }, pullRtspRaw: () => new Promise(resolve => { releasePull = resolve; }),
  });
  const begin = source.indexOf("app.get('/api/preview-stream', async (req, res) =>");
  const end = source.indexOf('// 3. SSE Progress Endpoint', begin);
  vm.runInContext(source.slice(begin, end), f.context);
  const res = new Response(); res.setHeader = () => {};
  await legacy({ query: { ip: '192.0.2.1', user: 'fixture', pass: 'fixture', channel: '101', time: '20261001T120000Z', duration: '10' } }, res);
  const old = f.context.activePreview;
  assert.ok(old);
  const requested = f.start(); await tick();
  assert.deepEqual(native.signals, ['SIGKILL']); assert.equal(f.calls.length, 0);
  native.emit('close', 0); await tick();
  assert.equal(f.calls.length, 0, 'decoder close alone must not release RTSP pull');
  releasePull(); await old.stop('again'); await tick();
  assert.equal(f.calls.length, 1); f.calls[0].finish(); await requested.done;
});

test('SDK retains a pending HLS manager barrier after activePreview was already cleared', async t => {
  const f = fixture(t); let release, stops = 0;
  const closed = new Promise(resolve => { release = resolve; });
  f.context.consoleDvrHls = { current: { stop() { stops++; return closed; } } };
  const requested = f.start(); await tick();
  assert.equal(stops, 1); assert.equal(f.calls.length, 0);
  release(); await tick(); assert.equal(f.calls.length, 1);
  f.calls[0].finish(); await requested.done;
});


test('actual SDK route returns distinct safe download, size, and media-processing failures', async t => {
  const f = fixture(t);
  for (const [index, code] of ['DVR_SDK_DOWNLOAD_TIMEOUT', 'DVR_SDK_BYTE_LIMIT', 'DVR_SDK_PROCESS_TIMEOUT'].entries()) {
    const attempt = f.start({ generation: String(index + 1) });
    await tick();
    f.calls[index].reject(Object.assign(new Error('private-password /private/native/path'), { code }));
    await attempt.done;
    assert.equal(attempt.res.statusCode, 502);
    assert.equal(attempt.res.body.success, false);
    assert.equal(attempt.res.body.error, dvrExportFailure({ code }).message);
    assert.doesNotMatch(JSON.stringify(attempt.res.body), /private-password|private\/native/);
  }
});


test('actual preview route exposes a fixed timeout phase explanation and no worker fields', async t => {
  const f = fixture(t);
  const attempt = f.start(); await tick();
  const error = Object.assign(new Error('private-native-output'), { code: 'DVR_SDK_DOWNLOAD_TIMEOUT', sdkFailurePhase: 'wait', sdkPhase: 'cleanup', stderr: 'private-native-output' });
  f.calls[0].reject(error); await attempt.done;
  assert.equal(attempt.res.statusCode, 502);
  assert.equal(attempt.res.body.error, dvrExportFailure(error).message);
  assert.match(attempt.res.body.error, /记录的超时步骤：等待录像数据/);
  assert.deepEqual(Object.keys(attempt.res.body).sort(), ['error', 'success']);
  assert.doesNotMatch(JSON.stringify(attempt.res.body), /private-native|sdkPhase|stderr/);
});

for (const [code, stage] of [['DVR_SDK_VERIFY_FAILED', 'probe'], ['DVR_SDK_FAILED', 'remux'], ['DVR_SDK_VERIFY_FAILED', 'verify'], ['DVR_SDK_VERIFY_FAILED', 'decode'], ['DVR_SDK_DOWNLOAD_TIMEOUT', 'probe']]) test(`actual preview route closes ${code}/${stage} numeric diagnostics to fixed text`, async t => {
  const f = fixture(t), attempt = f.start(); await tick();
  const error = Object.assign(new Error('private stderr /private/path'), { code, sdkFailurePhase: 'wait',
    sdkEvidence: { stage, requestedSeconds: 10, observedSeconds: 8.2, rawBytes: 12345, codec: 'private-codec' } });
  f.calls[0].reject(error); await attempt.done;
  assert.equal(attempt.res.statusCode, 502);
  assert.equal(attempt.res.body.error, dvrExportFailure(error).message);
  assert.match(attempt.res.body.error, /12345 字节/);
  assert.deepEqual(Object.keys(attempt.res.body).sort(), ['error', 'success']);
  assert.doesNotMatch(JSON.stringify(attempt.res.body), /private|sdkEvidence|sdkFailurePhase|codec/);
});
