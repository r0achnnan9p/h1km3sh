import { setButtonIcon } from '../public/ui-primitives.js';
import { listCoverageGaps } from '../public/playback-coverage.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { taskProgressPresentation, taskStageLabel, taskProgressCaption, uploadProgressCaption } from '../public/task-presentation.js';
import { statusDashboardPage } from '../lib/status-dashboard.js';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
class Element {
  children = []; listeners = {}; disabled = false; hidden = false; style = {}; textContent = ''; _value = '';
  classes = new Set(); classList = { toggle() {}, add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
  get value() { return this._value || this.children[0]?.value || ''; }
  set value(value) { this._value = value; }
  get options() { return this.children; }
  replaceChildren() { this.children = []; this._value = ''; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute() {}
  async change(value) { this.value = value; await this.listeners.change(); }
}
function harness() {
  const elements = new Map(); const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const state = { cameras: [], dvrs: [], selectedCamera: '', selectedChannel: '', dvrChannels: {}, playbackSource: 'mediamtx', segmentRequestId: 0, dvrChannelRequestId: 0, segments: [{ startMs: 0, endMs: 3000 }], inMs: 1000, outMs: 2000, busy: false };
  const requests = [], loads = [], liveStarts = [], loadOptions = [];
  const context = vm.createContext({ setButtonIcon, setTimeout() {}, clearTimeout() {}, state, $, document: { body: { dataset: { view: 'replay' } }, createElement: () => new Element() }, AbortController, consoleSession: 1, exportSubmission: null, listCoverageGaps, rememberSubmittedTask() {}, today: () => '2026-09-30', notify() {}, setPlaybackNotice() {}, startLive() { liveStarts.push(state.selectedCamera); }, startDvrLive() {}, clearReplay() {}, renderTimeline() {}, updateSelection() { $('export-range').disabled = state.busy; }, loadSegments: async options => { loads.push(state.playbackSource); loadOptions.push(options); }, body: JSON.stringify, wallTime: ms => String(ms), navigate() {}, refreshState: async () => {}, taskProgressPresentation, taskStageLabel, taskProgressCaption, uploadProgressCaption, Date, URLSearchParams,
    api: async (url, options) => { requests.push({ url, options }); return url.endsWith('/channels') ? { channels: [{ id: '101', name: '前场' }, { id: '201', name: '后场' }] } : { status: 'queued', queuePosition: 1 }; },
  });
  vm.runInContext(script.slice(script.indexOf('function fillCameras('), script.indexOf('function segmentBounds(')), context);
  vm.runInContext(script.slice(script.indexOf('function playbackContextKey('), script.indexOf('function requirePlaybackContext(')), context);
  vm.runInContext(script.slice(script.indexOf("$('export-range').addEventListener('click'"), script.indexOf('function prettyBytes(')), context);
  vm.runInContext(script.slice(script.indexOf('const statusLabels ='), script.indexOf('async function refreshState()')), context);
  return { context, $, state, requests, loads, liveStarts, loadOptions };
}

test('source picker shows MediaMTX channel and independent DVR recorder/channel, remembers both', async () => {
  const { context, $, state, requests } = harness();
  context.fillDvrDevices([{ id: 'dvr-a', name: 'DVR A' }, { id: 'dvr-b', name: 'DVR B' }]);
  context.fillCameras([{ id: 'D1', name: 'D1' }, { id: 'D2', name: 'D2' }]);
  await $('camera-select').change('D2');
  await $('playback-source').change('dvr');
  assert.equal($('mediamtx-channel-field').hidden, true);
  assert.equal($('dvr-controls').hidden, false);
  assert.equal($('dvr-channel').value, '101');
  assert.equal($('dvr-channel').options[0].textContent, '前场');
  await $('dvr-channel').change('201');
  await $('dvr-select').change('dvr-b');
  assert.equal($('dvr-channel').value, '101');
  await $('dvr-select').change('dvr-a');
  assert.equal($('dvr-channel').value, '201');
  await $('playback-source').change('mediamtx');
  assert.equal($('mediamtx-channel-field').hidden, false);
  assert.equal($('dvr-controls').hidden, true);
  assert.equal(state.selectedCamera, 'D2');
  await $('playback-source').change('dvr');
  assert.equal($('dvr-channel').value, '201');
  assert.ok(requests.some(r => r.url === '/console/api/dvrs/dvr-b/channels'));
});

test('DVR needs no MediaMTX aliases and repeated exports can enqueue during a running task', async () => {
  const { context, $, state, requests } = harness();
  context.fillDvrDevices([{ id: 'dvr-a', name: 'DVR A' }]);
  context.fillCameras([]);
  await $('playback-source').change('dvr');
  state.tasks = [{ status: 'downloading' }];
  await $('export-range').listeners.click();
  await $('dvr-channel').change('201');
  await $('export-range').listeners.click();
  const exports = requests.filter(r => r.url === '/console/api/export').map(r => JSON.parse(r.options.body));
  assert.equal(exports.length, 2);
  assert.deepEqual(exports.map(r => r.channel), ['101', '201']);
  assert.ok(exports.every(r => r.source === 'hikvision' && r.deviceId === 'dvr-a' && !('camera' in r)));
  assert.equal(state.busy, false);
  assert.equal($('export-range').disabled, false);
});

test('MediaMTX export uses its saved channel without stale DVR identifiers', async () => {
  const { context, $, requests } = harness();
  context.fillCameras([{ id: 'D2', name: 'D2' }]);
  await $('export-range').listeners.click();
  const payload = JSON.parse(requests.at(-1).options.body);
  assert.equal(payload.source, 'mediamtx'); assert.equal(payload.camera, 'D2');
  assert.equal('deviceId' in payload, false); assert.equal('channel' in payload, false);
});

test('DVR channel discovery coalesces repeated requests and reuses per-recorder results', async () => {
  const { context, $, state, requests } = harness();
  context.fillDvrDevices([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  let finish; context.api = (url) => { requests.push({ url }); return new Promise(resolve => { finish = resolve; }); };
  const first = context.loadDvrChannels(), second = context.loadDvrChannels();
  assert.equal(requests.length, 1);
  finish({ channels: [{ id: '101', name: 'A first' }] }); await Promise.all([first, second]);
  assert.equal($('dvr-channel').value, '101');
  await context.loadDvrChannels(); assert.equal(requests.length, 1);
  state.dvrChannelCache.a.updatedAt = 0;
  context.api = async () => { throw new Error('temporary outage'); };
  await context.loadDvrChannels();
  assert.equal($('dvr-channel').value, '101'); assert.match($('dvr-help').textContent, /保留/);
  context.api = async () => { throw Object.assign(new Error('session expired'), { status: 401 }); };
  await context.loadDvrChannels();
  assert.equal($('dvr-channel').disabled, true); assert.equal($('dvr-channel').value, '');
  $('dvr-select').value = 'b'; await context.loadDvrChannels();
  assert.equal($('dvr-channel').disabled, true); assert.equal($('dvr-channel').value, '');
});

test('queued card shows position without stale percentage, speed, or animated progress', () => {
  const { context } = harness();
  const card = context.makeTaskCard({ status: 'queued', queuePosition: 2, progress: 45, speed: 1000, speedUpdatedAt: Date.now() }, false);
  assert.equal(card.children[0].children[1].textContent, '排队中 · 第 2 位');
  assert.equal(card.children.some(child => child.className?.includes('progress')), false);
  assert.equal(card.children.at(-1).children[1].textContent, '');
  assert.match(card.children[1].textContent, /等待/);
});

test('dashboard names source channels and presents source before channel', () => {
  const html = statusDashboardPage();
  assert.match(html, /id="mediamtx-channel-field"><span>通道<\/span>/);
  assert.ok(html.indexOf('id="playback-source"') < html.indexOf('id="camera-select"'));
  assert.match(html, /id="dvr-controls" hidden/);
});

test('late channel response from a previous recorder cannot overwrite the latest selection', async () => {
  const { context, $, state } = harness();
  context.fillDvrDevices([{ id: 'dvr-a', name: 'A' }, { id: 'dvr-b', name: 'B' }]);
  const pending = [];
  context.api = () => new Promise(resolve => pending.push(resolve));
  const first = $('playback-source').change('dvr');
  assert.equal(context.hasPlaybackSelection(), false);
  const second = $('dvr-select').change('dvr-b');
  pending[1]({ channels: [{ id: '301', name: 'B 通道' }] });
  await second;
  pending[0]({ channels: [{ id: '101', name: 'A 通道' }] });
  await first;
  assert.equal($('dvr-select').value, 'dvr-b');
  assert.equal($('dvr-channel').value, '301');
  assert.equal(state.selectedChannel, '301');
});

test('failed recorder channel query leaves export unavailable without reusing old channels', async () => {
  const { context, $, requests } = harness();
  context.fillDvrDevices([{ id: 'dvr-a', name: 'A' }, { id: 'dvr-b', name: 'B' }]);
  await $('playback-source').change('dvr');
  context.api = async () => { throw new Error('mock connection failed'); };
  await $('dvr-select').change('dvr-b');
  assert.equal($('dvr-channel').disabled, true);
  assert.equal(context.hasPlaybackSelection(), false);
  await $('export-range').listeners.click();
  assert.equal(requests.filter(r => r.url === '/console/api/export').length, 0);
});

test('DVR recording query runs without a selected MediaMTX channel', async () => {
  const { context, $, state, requests } = harness();
  context.fillDvrDevices([{ id: 'dvr-a', name: 'DVR A' }]);
  context.fillCameras([]);
  await $('playback-source').change('dvr');
  context.dateStart = () => 0;
  context.setTimelineWindow = () => {};
  $('timeline').querySelector = () => new Element();
  vm.runInContext(script.slice(script.indexOf('async function loadSegments('), script.indexOf('function updateCursor(')), context);
  await context.loadSegments({ preserveRange: true });
  assert.equal(state.selectedCamera, '');
  assert.ok(requests.some(r => r.url === '/console/api/dvrs/dvr-a/segments?date=2026-09-30&channel=101'));
});

test('queued export cancellation targets only its task and suppresses duplicate clicks', async () => {
  const { context, requests } = harness();
  let resolveStop;
  context.api = (url, options) => { requests.push({ url, options }); return new Promise(resolve => { resolveStop = resolve; }); };
  let refreshed = 0; context.refreshState = async () => { refreshed++; };
  const card = context.makeTaskCard({ taskId: 'queued-2', status: 'queued', queuePosition: 2 }, false);
  const cancel = card.children.at(-1).children.at(-1);
  assert.equal(cancel.textContent, '取消排队');
  const first = cancel.listeners.click();
  await cancel.listeners.click();
  assert.equal(cancel.disabled, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/console/api/export/stop');
  assert.deepEqual(JSON.parse(requests[0].options.body), { taskId: 'queued-2' });
  resolveStop({ ok: true }); await first;
  assert.equal(refreshed, 1);
  for (const [status, uploadTask] of [['downloading', false], ['queued', true]]) {
    const otherCard = context.makeTaskCard({ taskId: 'other', status }, uploadTask);
    assert.equal(otherCard.children.at(-1).children.some(child => child.textContent === '取消排队'), false);
  }
  assert.equal(context.statusText('stopping'), '正在取消');
});


test('task card shows stage and measured elapsed media without a fake overall percent', () => {
  const { context } = harness();
  const card = context.makeTaskCard({ taskId: 'stage', status: 'converting', stage: 'concatenating', progress: 93, stagePercent: null, processedSeconds: 120, message: '正在拼接 9 个文件', progressUpdatedAt: Date.now() }, false);
  assert.equal(card.children[0].children[1].textContent, '拼接 MP4');
  assert.match(card.children[2].className, /indeterminate/);
  assert.match(card.children.at(-1).children[1].textContent, /已处理 120 秒/);
  assert.doesNotMatch(card.children.at(-1).children[1].textContent, /93%/);
  const done = context.makeTaskCard({ taskId: 'stage', status: 'completed', progress: 100, stage: 'concatenating', stagePercent: null }, false);
  assert.equal(done.children[0].children[1].textContent, '已完成');
  assert.equal(done.children.length, 3);
});


test('environment-managed password hides the change form and preserves file-managed mode', () => {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ $ });
  vm.runInContext(script.slice(script.indexOf('function renderPasswordMode('), script.indexOf('function renderSettings(')), context);
  context.renderPasswordMode(true);
  assert.equal($('password-form').hidden, true);
  assert.equal($('password-help').textContent, '登录密码由服务器配置，修改后需重启服务。');
  context.renderPasswordMode(false);
  assert.equal($('password-form').hidden, false);
  assert.match($('password-help').textContent, /更新后需重新登录/);
  assert.match(script, /renderPasswordMode\(bootstrap.passwordManaged === true\)/);
  assert.match(statusDashboardPage(), /id="password-help"/);
});

test('confirmed missing DVR subtrack shows the server notice; genuine lookup errors still reject', async () => {
  const h = harness(), empty = new Element(), notices = [];
  Object.assign(h.state, { date: '2026-10-01', playbackSource: 'dvr' });
  h.$('dvr-select').value = 'dvr-a'; h.$('dvr-channel').value = '302'; h.$('timeline').querySelector = () => empty;
  Object.assign(h.context, { dateStart: () => 0, setTimelineWindow() {}, clearMarkedRange() {}, setPlaybackNotice: text => notices.push(text), api: async () => ({ segments: [], notice: '未找到302子码流录像轨道，请选择301。' }) });
  vm.runInContext(script.slice(script.indexOf('async function loadSegments('), script.indexOf('function updateCursor(')), h.context);
  await h.context.loadSegments(); assert.equal(empty.textContent, '未找到302子码流录像轨道，请选择301。'); assert.equal(notices.at(-1), empty.textContent);
  h.context.api = async () => { throw new Error('真实连接超时'); };
  await assert.rejects(h.context.loadSegments(), /真实连接超时/); assert.equal(h.$('retry-recordings').hidden, false); assert.equal(empty.textContent, '读取失败，请重试。');
});

test('API camera names are displayed directly, while absent or numeric names become 镜头N', async () => {
  const h = harness(); h.context.fillDvrDevices([{ id: 'dvr-a', name: 'A' }]);
  h.context.api = async () => ({ channels: [{ id: '101', name: '前场' }, { id: '201', name: '201' }, { id: '301', name: '' }] });
  await h.$('playback-source').change('dvr');
  assert.deepEqual(h.$('dvr-channel').options.map(option => option.textContent), ['前场', '镜头2', '镜头3']);
});
test('channel selection starts live immediately and stale discovery never restarts the old camera', async () => {
  const h = harness(), starts = [];
  h.context.startDvrLive = () => starts.push([h.$('dvr-select').value, h.$('dvr-channel').value]);
  h.context.fillDvrDevices([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const pending = []; h.context.api = () => new Promise(resolve => pending.push(resolve));
  const first = h.$('playback-source').change('dvr'), second = h.$('dvr-select').change('b');
  pending[1]({ channels: [{ id: '301', name: 'B主场' }] }); await second;
  pending[0]({ channels: [{ id: '101', name: 'A主场' }] }); await first;
  assert.deepEqual(starts, [['b', '301']]);
  await h.$('dvr-channel').change('401'); assert.deepEqual(starts.at(-1), ['b', '401']);
});

test('recording lookup can run beside live without clearing its current source', async () => {
  const h = harness(), empty = new Element(); let stops = 0;
  Object.assign(h.state, { date: '2026-10-01', playbackSource: 'dvr', previewMode: 'live' });
  h.$('dvr-select').value = 'a'; h.$('dvr-channel').value = '301'; h.$('timeline').querySelector = () => empty;
  Object.assign(h.context, { clearReplay: () => stops++, dateStart: () => 0, setTimelineWindow() {}, clearMarkedRange() {}, api: async () => ({ segments: [] }) });
  vm.runInContext(script.slice(script.indexOf('async function loadSegments('), script.indexOf('function updateCursor(')), h.context);
  await h.context.loadSegments({ keepLive: true }); assert.equal(stops, 0); assert.equal(h.state.previewMode, 'live');
  await h.context.loadSegments(); assert.equal(stops, 1, 'an explicit date/recording reload uses the regular replay reset');
});


test('changing MediaMTX channel starts live and refreshes the recording timeline without stopping it', async () => {
  const h = harness(); h.context.fillCameras([{ id:'D1',name:'D1' },{id:'D2',name:'D2'}]);
  await h.$('camera-select').change('D2');
  assert.deepEqual(h.liveStarts,['D2']); assert.equal(h.loadOptions.at(-1).keepLive,true);
  assert.equal(h.state.inMs,1000);assert.equal(h.state.outMs,2000);
});
