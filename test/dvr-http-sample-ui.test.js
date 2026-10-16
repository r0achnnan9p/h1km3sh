/** UI-only fixtures; never contact a DVR, download data or create a real task. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function makeTaskCard('), source.indexOf('\nfunction connectEvents()'));
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.style = {}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener(name, action) { this.events[name] = action; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const buttons = card => walk(card).filter(node => node.tag === 'button');
const text = card => walk(card).map(node => node.textContent || '').join('\n');
const reportLines = card => walk(card).filter(node => /^task-detail task-http-sample-(?!(?:warning|checkpoint|phase))/.test(node.className || '')).map(node => node.textContent);
const eligibleTask = { taskId: 'fixture-task', source: 'hikvision', status: 'error', dvrHttpSampleAvailable: true };
const safeReport = { outcome: 'decoded', stopReason: 'byte_limit', httpStatus: 200, bytes: 32000000, mediaType: 'mpegps', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, decodedFrames: 1000, firstPtsSeconds: 0, lastPtsSeconds: 39.96 };
const sampleTask = { taskId: 'fixture-sample', kind: 'dvr-http-sample', source: 'hikvision', status: 'completed', sampleReport: safeReport };
const resumeTask = { ...sampleTask, taskId: '00000000-0000-4000-8000-000000000000', sampleMediaAttempted: false, sampleResumeAvailable: true };
const secret = 'private-password rtsp://private-host/private-selector <ResponseStatus>raw-device-output</ResponseStatus>';
const assertSafe = card => assert.doesNotMatch(text(card), /private-|rtsp:\/\/|ResponseStatus|raw-device-output/);

function harness() {
  const requests = [], messages = [], settings = [], h = { renders: 0, snapshots: { tasks: [eligibleTask], uploads: [] } };
  const sandbox = { consoleSession: 0, stateRequest: 0, outputRequest: 0, acceptOutputs() {},
    document: { createElement: tag => new Element(tag) }, dvrHttpSamplePending: new Map(), cloudVerificationPending: new Set(),
    taskStageLabel: () => '', statusText: status => status, taskProgressPresentation: () => ({ show: false }),
    taskProgressCaption: () => '', uploadProgressCaption: () => '', settingsCsrfToken: 'stale-token', body: JSON.stringify,
    state: { tasks: [], uploads: [], lastTasks: '' }, renderTasks: () => h.renders++, renderSettings: () => {}, refreshOutputs: async () => {},
    notify: (...args) => messages.push(args),
    loadSettings: async () => { settings.push('loaded'); if (h.loadSettings) await h.loadSettings(); sandbox.settingsCsrfToken = 'fresh-csrf'; },
    api: async (url, options) => {
      requests.push({ url, options });
      if (url === '/console/api/bootstrap') return h.bootstrap ? h.bootstrap() : h.snapshots;
      return h.submit ? h.submit(url, options) : {};
    },
  };
  vm.createContext(sandbox); vm.runInContext(functions, sandbox);
  return Object.assign(h, { sandbox, requests, messages, settings, card: (task = eligibleTask, uploadTask = false) => sandbox.makeTaskCard(task, uploadTask) });
}

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('one explicit test action is shown only on server-eligible failed Hikvision export tasks', async () => {
  const h = harness();
  for (const status of ['queued', 'pending', 'downloading', 'converting', 'completed', 'cancelled', 'unknown']) {
    assert.equal(buttons(h.card({ ...eligibleTask, status })).filter(button => button.textContent === '受限 HTTP 兼容测试').length, 0);
  }
  for (const source of [undefined, 'dvr', 'mediamtx', 'Hikvision', null]) {
    assert.equal(buttons(h.card({ ...eligibleTask, source })).length, 0);
  }
  for (const dvrHttpSampleAvailable of [undefined, null, false, 0, 1, 'true', {}, []]) {
    assert.equal(buttons(h.card({ ...eligibleTask, dvrHttpSampleAvailable })).length, 0);
  }
  assert.equal(buttons(h.card(eligibleTask, true)).length, 0);
  const card = h.card();
  assert.deepEqual(buttons(card).map(button => button.textContent), ['受限 HTTP 兼容测试']);
  assert.match(text(card), /32 MB.*20 秒.*先到即停/);
  assert.match(text(card), /所选十秒之外.*不生成成片/);
  await h.sandbox.refreshState(); h.card();
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 0);
  assert.equal(h.settings.length, 0, 'render and refresh must never trigger a sample');
});

test('explicit click loads fresh settings then posts an empty body and CSRF header exactly once', async () => {
  const h = harness(), gate = deferred();
  h.submit = async (url, options) => {
    assert.equal(h.settings.length, 1);
    assert.equal(url, '/console/api/tasks/fixture-task/dvr-http-sample');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {});
    assert.deepEqual(Object.keys(options.headers), ['X-CSRF-Token']);
    assert.equal(options.headers['X-CSRF-Token'], 'fresh-csrf');
    return gate.promise;
  };
  const first = buttons(h.card())[0], second = buttons(h.card())[0];
  const click = first.events.click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(first.disabled, true);
  assert.equal(buttons(h.card())[0].disabled, true);
  await first.events.click(); await second.events.click();
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 1);
  // An update while POST is in flight must not clear its guard.
  await h.sandbox.refreshState();
  assert.equal(buttons(h.card())[0].disabled, true);
  h.snapshots = { tasks: [{ ...eligibleTask, dvrHttpSampleAvailable: false }, sampleTask], uploads: [] };
  gate.resolve({ taskId: 'fixture-sample', raw: secret }); await click;
  assert.equal(h.sandbox.dvrHttpSamplePending.size, 0);
  assert.equal(buttons(h.card(h.sandbox.state.tasks[0])).length, 0);
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 1);
  assert.match(h.messages[0][0], /不会生成成片/);
  assert.doesNotMatch(JSON.stringify(h.messages), /private-|raw-device-output/);
});

test('the actual API helper sends same-origin JSON with the CSRF token returned by settings', async () => {
  const h = harness(), fetches = [];
  Object.assign(h.sandbox, {
    appPath: path => `/prefix${path}`, renderUploadCover: () => {},
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => url.endsWith('/settings')
        ? { csrfToken: 'server-issued-token', settings: {}, integrations: {} }
        : url.endsWith('/bootstrap') ? { tasks: [], uploads: [] } : { taskId: 'new-sample', status: 'queued' } };
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function api('), source.indexOf('async function requestJson(')), h.sandbox);
  vm.runInContext(source.slice(source.indexOf('async function loadSettings()'), source.indexOf('\n', source.indexOf('async function loadSettings()'))), h.sandbox);
  await buttons(h.card())[0].events.click();
  assert.deepEqual(fetches.map(request => request.url), [
    '/prefix/console/api/settings', '/prefix/console/api/tasks/fixture-task/dvr-http-sample', '/prefix/console/api/bootstrap',
  ]);
  const post = fetches[1].options;
  assert.equal(post.method, 'POST'); assert.equal(post.credentials, 'same-origin'); assert.equal(post.cache, 'no-store');
  assert.equal(post.headers['Content-Type'], 'application/json'); assert.equal(post.headers['X-CSRF-Token'], 'server-issued-token');
  assert.deepEqual(JSON.parse(post.body), {});
});

test('uncertain submit and failed refresh keep retry disabled until a successful authoritative refresh', async () => {
  const h = harness();
  h.submit = async () => { throw new Error(secret); };
  h.bootstrap = async () => { throw new Error(secret); };
  await buttons(h.card())[0].events.click();
  assert.equal(buttons(h.card())[0].disabled, true);
  await buttons(h.card())[0].events.click();
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 1);
  assert.doesNotMatch(JSON.stringify(h.messages), /private-|ResponseStatus/);
  h.bootstrap = undefined;
  await h.sandbox.refreshState();
  assert.equal(buttons(h.card())[0].disabled, false);
});

test('settings failure never posts and uses the same safe refresh-before-retry guard', async () => {
  const h = harness();
  h.loadSettings = async () => { throw new Error(secret); };
  h.bootstrap = async () => { throw new Error('offline'); };
  await buttons(h.card())[0].events.click();
  assert.equal(h.requests.some(request => request.options?.method === 'POST'), false);
  assert.equal(buttons(h.card())[0].disabled, true);
  assert.doesNotMatch(JSON.stringify(h.messages), /private-|ResponseStatus/);
});

test('sample cards show only bounded report facts and explicitly never promise a precise clip', () => {
  const h = harness(), card = h.card({ ...sampleTask, title: secret, filename: secret, camera: secret, source: secret, message: secret, error: secret, recoveryMessage: secret, targetPath: secret, stage: secret, failureDiagnostics: { method: 'PLAY', rtspStatus: 400 }, sampleReport: { ...safeReport, playbackURI: secret, xml: secret, stderr: secret, unexpected: secret } });
  assertSafe(card);
  assert.match(text(card), /测试结束/);
  assert.doesNotMatch(text(card), /已完成|100%|RTSP PLAY/);
  assert.deepEqual(reportLines(card), [
    '测试结果：已解码样本 · 停止原因：达到 32 MB 上限',
    'HTTP 状态：200 · 已读取：32000000 B · 媒体类型：MPEG-PS',
    '视频：H.264 · 音频：AAC · 分辨率：1920 × 1080 · 已解码帧数：1000',
    '样本相对时间戳：0 秒 至 39.96 秒；不是录像墙钟时间，不能据此认定精确十秒成片。',
  ]);
  assert.match(text(card), /不生成成片.*不能证明已精确截取所选十秒/);
  assert.deepEqual(buttons(card), []);
});

test('cleanup failure is a fixed failed outcome and never implies that a sample was cleaned', () => {
  const h = harness();
  const card = h.card({ ...sampleTask, status: 'error', message: secret, sampleReport: { ...safeReport, outcome: 'cleanup_failed', rawError: secret } });
  assert.match(text(card), /测试失败/);
  assert.match(reportLines(card)[0], /测试结果：样本清理失败/);
  assert.doesNotMatch(text(card), /测试结束|清理成功|已清理|已完成/);
  assertSafe(card);
  assert.equal(buttons(card).length, 0);
});

test('unknown report strings are not coerced or reflected, including prototype keys', () => {
  const h = harness(), hostile = { toString() { throw new Error('must not stringify'); }, valueOf() { throw new Error('must not coerce'); } };
  for (const value of [secret, 'constructor', '__proto__', 'toString', '', true, 1, null, undefined, [], {}, hostile, Symbol(secret)]) {
    const card = h.card({ ...sampleTask, sampleReport: { ...safeReport, outcome: value, stopReason: value, mediaType: value, videoCodec: value, audioCodec: value } });
    assertSafe(card);
    assert.match(reportLines(card)[0], /测试结果：未知 · 停止原因：未知/);
    assert.match(reportLines(card)[1], /媒体类型：未知/);
    assert.match(reportLines(card)[2], /视频：未知 · 音频：未知/);
  }
});

test('report numeric fields reject nonfinite, coercible, negative and out-of-range facts', () => {
  const h = harness(), keys = ['httpStatus', 'bytes', 'width', 'height', 'decodedFrames', 'firstPtsSeconds', 'lastPtsSeconds'];
  const hostile = { toString() { throw new Error('must not stringify'); }, valueOf() { throw new Error('must not coerce'); } };
  for (const value of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER, '200', secret, null, undefined, {}, hostile, [], true, 1n, Symbol(secret)]) {
    const card = h.card({ ...sampleTask, sampleReport: { ...safeReport, ...Object.fromEntries(keys.map(key => [key, value])) } });
    assertSafe(card);
    assert.match(reportLines(card)[1], /HTTP 状态：未知 · 已读取：未知/);
    assert.match(reportLines(card)[2], /分辨率：未知 × 未知 · 已解码帧数：未知/);
    assert.match(reportLines(card)[3], /相对时间戳：未知 至 未知/);
  }
  const card = h.card({ ...sampleTask, sampleReport: { ...safeReport, httpStatus: 600, bytes: 32000001, width: 16385, height: 0, decodedFrames: 1001, firstPtsSeconds: 86400.01, lastPtsSeconds: -0.01 } });
  assert.match(reportLines(card)[1], /HTTP 状态：未知 · 已读取：未知/);
  assert.match(reportLines(card)[2], /分辨率：未知 × 未知 · 已解码帧数：未知/);
  assert.match(reportLines(card)[3], /相对时间戳：未知 至 未知/);
  const fractions = h.card({ ...sampleTask, sampleReport: { ...safeReport, httpStatus: 200.5, bytes: 1.5, width: 1.5, height: 1.5, decodedFrames: 1.5 } });
  assert.match(reportLines(fractions)[1], /HTTP 状态：未知 · 已读取：未知/);
  assert.match(reportLines(fractions)[2], /分辨率：未知 × 未知 · 已解码帧数：未知/);
  const bounds = h.card({ ...sampleTask, sampleReport: { ...safeReport, httpStatus: 599, bytes: 0, width: 16384, height: 1, decodedFrames: 0, firstPtsSeconds: 0, lastPtsSeconds: 86400 } });
  assert.match(reportLines(bounds)[1], /HTTP 状态：599 · 已读取：0 B/);
  assert.match(reportLines(bounds)[2], /分辨率：16384 × 1 · 已解码帧数：0/);
  assert.match(reportLines(bounds)[3], /相对时间戳：0 秒 至 86400 秒/);
});

test('all transport-approved outcomes, reasons, formats and codecs have closed display labels', () => {
  const h = harness();
  const allowed = {
    outcome: ['decoded', 'undecodable', 'no_match', 'invalid', 'authentication', 'http_error', 'timeout', 'cancelled', 'failed', 'cleanup_failed'],
    stopReason: ['eof', 'byte_limit', 'time_limit', 'cancelled', 'http_error', 'invalid_response', 'no_match', 'invalid_recording', 'transport_error', 'probe_limit', 'decode_limit'],
    mediaType: ['mpegps', 'mpegts', 'mp4', 'matroska', 'avi', 'h264', 'hevc', 'mpegvideo'],
    videoCodec: ['h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4', 'mjpeg', 'vp8', 'vp9', 'av1', 'rawvideo'],
    audioCodec: ['aac', 'mp2', 'mp3', 'pcm_alaw', 'pcm_mulaw', 'pcm_s16le', 'pcm_s16be', 'opus', 'vorbis', 'ac3', 'eac3', 'adpcm_ima_wav'],
  };
  for (const [key, values] of Object.entries(allowed)) for (const value of values) {
    assert.doesNotMatch(reportLines(h.card({ ...sampleTask, sampleReport: { ...safeReport, [key]: value } })).join('\n'), /未知/, `${key}: ${value}`);
  }
});

test('legacy missing reports and inherited or accessor fields are never interpreted as raw facts', () => {
  const h = harness();
  for (const sampleReport of [undefined, null, false, secret, 1, []]) {
    const card = h.card({ ...sampleTask, sampleReport });
    assert.equal(reportLines(card).length, 0); assertSafe(card);
  }
  for (const sampleReport of [Object.create(safeReport), Object.defineProperties({}, Object.fromEntries(Object.keys(safeReport).map(key => [key, { get() { throw new Error('must not invoke getter'); } }])) )]) {
    const card = h.card({ ...sampleTask, sampleReport });
    assert.match(reportLines(card)[0], /测试结果：未知 · 停止原因：未知/); assertSafe(card);
  }
});

test('queued and active samples have a guarded stop action; stopping and terminal samples cannot resubmit', async () => {
  for (const status of ['queued', 'pending', 'downloading', 'converting']) {
    const h = harness(), gate = deferred(); h.submit = async () => gate.promise;
    const button = buttons(h.card({ ...sampleTask, status }))[0];
    assert.equal(button.textContent, '取消测试'); assert.equal(button.disabled, false);
    const click = button.events.click(); await button.events.click();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/console/api/export/stop');
    assert.equal(h.requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(h.requests[0].options.body), { taskId: 'fixture-sample' });
    gate.resolve(); await click;
    assert.match(h.messages[0][0], /取消兼容测试/);
  }
  const h = harness();
  const stopping = buttons(h.card({ ...sampleTask, status: 'stopping' }))[0];
  assert.equal(stopping.disabled, true); await stopping.events.click(); assert.equal(h.requests.length, 0);
  for (const status of ['completed', 'error', 'cancelled', 'unknown', secret]) {
    const card = h.card({ ...sampleTask, status, dvrHttpSampleAvailable: true });
    assert.equal(buttons(card).length, 0); assertSafe(card);
  }
});

test('cancel failure is redacted, and ordinary task actions remain unchanged', async () => {
  const h = harness(); h.submit = async () => { throw new Error(secret); };
  const button = buttons(h.card({ ...sampleTask, status: 'downloading' }))[0];
  await button.events.click(); assert.equal(button.disabled, false);
  assert.doesNotMatch(JSON.stringify(h.messages), /private-|ResponseStatus/);
  assert.deepEqual(buttons(h.card({ taskId: 'ordinary', status: 'queued' })).map(button => button.textContent), ['取消排队']);
  assert.equal(buttons(h.card({ taskId: 'ordinary', status: 'downloading' })).length, 0);
  assert.equal(buttons(h.card({ taskId: 'ordinary', status: 'completed' })).length, 0);
});

test('existing media checkpoint is read-only, boolean-only and cannot re-enable a consumed test', () => {
 const h=harness();
 const pending={...sampleTask,status:'completed',dvrHttpSampleAvailable:false};
 for(const [value,phrase] of [[false,'未进入，尚未发送媒体请求'],[true,'已进入媒体请求阶段，不代表已连接成功'],[undefined,'未记录']]) {
  const card=h.card({...pending,sampleMediaAttempted:value});assert.match(text(card),new RegExp(phrase));assert.equal(buttons(card).length,0);
 }
 for(const value of ['false',secret,{},1]) {const card=h.card({...pending,sampleMediaAttempted:value});assert.match(text(card),/检查点：未记录/);assertSafe(card);}
 const hostile=Object.defineProperty({...pending},'sampleMediaAttempted',{get(){throw new Error('must not read accessor');}});
 assert.match(text(h.card(hostile)),/检查点：未记录/);assert.equal(h.requests.length,0);
});

test('future phase and curl exit are closed facts; legacy reports do not invent them',()=>{
 const h=harness();assert.doesNotMatch(text(h.card(sampleTask)),/curl 退出码/);
 const card=h.card({...sampleTask,sampleReport:{...safeReport,phase:'search',curlExitCode:47}});
 assert.match(text(card),/执行阶段：录像查询 · curl 退出码：47/);
 const dirty=h.card({...sampleTask,sampleReport:{...safeReport,phase:secret,curlExitCode:secret}});
 assert.match(text(dirty),/执行阶段：未知 · curl 退出码：未知/);assertSafe(dirty);
});


test('resume visibility requires an explicit server boolean on a sample card and never starts on render or refresh', async () => {
  const h = harness();
  for (const status of ['completed', 'error']) {
    assert.deepEqual(buttons(h.card({ ...resumeTask, status })).map(button => button.textContent), ['继续未开始的测试']);
  }
  for (const sampleResumeAvailable of [undefined, null, false, 0, 1, 'true', {}, []]) {
    assert.equal(buttons(h.card({ ...resumeTask, sampleResumeAvailable })).length, 0);
  }
  const inherited = Object.assign(Object.create({ sampleResumeAvailable: true }), sampleTask);
  const accessor = Object.defineProperty({ ...sampleTask }, 'sampleResumeAvailable', { get() { throw new Error('must not invoke getter'); } });
  for (const task of [inherited, accessor, { ...resumeTask, kind: 'ordinary' }]) assert.equal(buttons(h.card(task)).length, 0);
  assert.equal(buttons(h.card(resumeTask, true)).length, 0);
  h.snapshots = { tasks: [resumeTask], uploads: [] };
  h.card(resumeTask); h.card(resumeTask);
  assert.equal(h.requests.length, 0);
  assert.equal(h.settings.length, 0);
  await h.sandbox.refreshState(); h.card(h.sandbox.state.tasks[0]);
  assert.deepEqual(h.requests.map(request => request.url), ['/console/api/bootstrap']);
  assert.equal(h.settings.length, 0);
});

test('resume click reuses the guarded empty POST on the same sample ID through duplicate clicks and refresh', async () => {
  const h = harness(), gate = deferred();
  h.snapshots = { tasks: [resumeTask], uploads: [] };
  h.submit = async (url, options) => {
    assert.equal(url, `/console/api/tasks/${resumeTask.taskId}/dvr-http-sample`);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-CSRF-Token'], 'fresh-csrf');
    assert.deepEqual(JSON.parse(options.body), {});
    return gate.promise;
  };
  const first = buttons(h.card(resumeTask))[0], stale = buttons(h.card(resumeTask))[0];
  const pending = first.events.click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(first.disabled, true);
  await first.events.click(); await stale.events.click();
  await h.sandbox.refreshState();
  assert.equal(buttons(h.card(resumeTask))[0].disabled, true);
  assert.equal(h.settings.length, 1);
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 1);
  h.snapshots = { tasks: [{ ...resumeTask, sampleResumeAvailable: false, sampleMediaAttempted: true }], uploads: [] };
  gate.resolve({ taskId: resumeTask.taskId }); await pending;
  assert.equal(buttons(h.card(h.sandbox.state.tasks[0])).length, 0);
  assert.equal(h.sandbox.dvrHttpSamplePending.size, 0);
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 1);
});

test('unconfirmed resume response and failed refresh keep stale clicks disabled without automatically retrying', async () => {
  const h = harness();
  h.submit = async () => { throw new Error(secret); };
  h.bootstrap = async () => { throw new Error(secret); };
  const stale = buttons(h.card(resumeTask))[0];
  await buttons(h.card(resumeTask))[0].events.click();
  assert.equal(buttons(h.card(resumeTask))[0].disabled, true);
  await stale.events.click(); await buttons(h.card(resumeTask))[0].events.click();
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 1);
  assert.doesNotMatch(JSON.stringify(h.messages), /private-|ResponseStatus/);
  h.bootstrap = undefined; h.snapshots = { tasks: [{ ...resumeTask, sampleResumeAvailable: false }], uploads: [] };
  await h.sandbox.refreshState();
  assert.equal(buttons(h.card(h.sandbox.state.tasks[0])).length, 0);
  assert.equal(h.requests.filter(request => request.options?.method === 'POST').length, 1);
});

test('resume settings failure sends no POST and retains the refresh-before-retry guard', async () => {
  const h = harness();
  h.loadSettings = async () => { throw new Error(secret); };
  h.bootstrap = async () => { throw new Error(secret); };
  await buttons(h.card(resumeTask))[0].events.click();
  assert.equal(buttons(h.card(resumeTask))[0].disabled, true);
  assert.equal(h.requests.some(request => request.options?.method === 'POST'), false);
  assert.doesNotMatch(JSON.stringify(h.messages), /private-|ResponseStatus/);
});

test('preflight history stays concise, closed and separate from the current checkpoint and result', () => {
  const h = harness();
  const history = { outcome: 'failed', stopReason: 'transport_error', bytes: 0, url: secret, error: secret, headers: secret, toJSON() { throw new Error('must not stringify'); } };
  const card = h.card({ ...resumeTask, samplePreflightReport: history });
  assert.match(text(card), /上次前检记录：测试失败 · 已读取：0 B/);
  assert.equal(walk(card).filter(node => node.className === 'task-detail task-http-sample-preflight').length, 1);
  assert.match(text(card), /媒体请求检查点：未进入，尚未发送媒体请求/);
  assert.match(text(card), /测试结果：已解码样本/);
  assertSafe(card);
  for (const samplePreflightReport of [undefined, null, false, secret, [], 1]) assert.doesNotMatch(text(h.card({ ...resumeTask, samplePreflightReport })), /上次前检记录/);
  const accessor = Object.defineProperty({ ...resumeTask }, 'samplePreflightReport', { get() { throw new Error('must not invoke getter'); } });
  assert.doesNotMatch(text(h.card(accessor)), /上次前检记录/);
  const getters = Object.defineProperties({}, { outcome: { get() { throw new Error('must not invoke getter'); } }, bytes: { get() { throw new Error('must not invoke getter'); } } });
  for (const samplePreflightReport of [getters, Object.create(history), { outcome: secret, bytes: secret }, { outcome: 'constructor', bytes: Infinity }, { outcome: 'failed', bytes: -1 }]) {
    const dirty = h.card({ ...resumeTask, samplePreflightReport });
    assert.match(text(dirty), /上次前检记录：.* · 已读取：未知/); assertSafe(dirty);
  }
  assert.equal(h.requests.length, 0);
});
