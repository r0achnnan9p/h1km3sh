import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createPrecisionTimeline } from '../public/precision-timeline.js';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');

function fixture({ span = 30 } = {}) {
  const items = new Map(), windowEvents = {}, commits = [];
  let paused = 0, renders = 0;
  const state = { segments: [{}], cursorMs: 43_200_000, inMs: 1000, outMs: 2000,
    timelineStartMs: 43_200_000 - span * 500, timelineSpanSeconds: span, playbackSource: 'mediamtx',
    selectedCamera: 'camera-a', date: 'day-a', dragging: false, previewMode: 'replay', playbackAutoplay: true, followPlayback: true };
  const $ = id => {
    if (!items.has(id)) items.set(id, { value: '', hidden: false, paused: false, clientWidth: 360, dataset: {}, listeners: new Map(),
      pause() { paused++; this.paused = true; }, removeAttribute() {}, load() {}, getBoundingClientRect: () => ({ left: 0, width: 360 }),
      setPointerCapture() {}, hasPointerCapture: () => false,
      addEventListener(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }, removeEventListener() {} });
    return items.get(id);
  };
  const buttons = [86400, 3600, 300, 30].map(value => ({ dataset: { timelineSpan: String(value) }, attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; }, classList: { toggle() {} } }));
  const c = vm.createContext({ state, $, consoleSession: 0, precisionTimeline: null, createPrecisionTimeline,
    NaN, Math, JSON, Date: { now: () => 172_800_000 }, DEFAULT_TIMELINE_SPAN_SECONDS: 86400,
    TIMELINE_SPANS: [86400, 3600, 300, 30], dateStart: () => 0,
    showScrubTime() {}, fadeScrubTime() {}, renderTimeline() { renders++; }, setPlaybackNotice() {},
    cancelReplayHold() {}, stopHlsPreview() {}, syncReplayToggle() {},
    jumpToTimelineTime: async (time, source, options) => { commits.push({ time, source, options }); },
    document: { querySelectorAll: () => buttons, body: { dataset: { view: 'replay' } } }, window: { addEventListener: (name, fn) => windowEvents[name] = fn } });
  vm.runInContext(script.slice(script.indexOf('function timelineWindow('), script.indexOf('function renderOverview(')), c);
  vm.runInContext(script.slice(script.indexOf('function setTimelineWindow('), script.indexOf('function renderTimeline(')), c);
  const start = script.indexOf('function setupPrecisionTimeline()');
  vm.runInContext(script.slice(start, script.indexOf('function showScrubTime', start)), c); c.setupPrecisionTimeline();
  const interrupt = script.indexOf('function interruptTimelineScrub(');
  vm.runInContext(script.slice(interrupt, script.indexOf("document.addEventListener('visibilitychange'", interrupt)), c);
  vm.runInContext(script.slice(script.indexOf('function clearReplay('), script.indexOf('function stopHlsPreview(')), c);
  const emit = (name, extra = {}) => {
    const event = { pointerId: 1, button: 0, isPrimary: true, clientX: 180, clientY: 400, preventDefault() {}, ...extra };
    for (const listener of $('timeline-overview').listeners.get(name) || []) listener(event);
  };
  const change = id => { for (const listener of $(id).listeners.get('change') || []) listener(); };
  return { state, $, c, emit, change, commits, windowEvents, buttons, paused: () => paused, renders: () => renders };
}

test('真实setup拖动仅更新整秒游标，释放一次复用既有jump并保持所选窗口', async () => {
  const h = fixture(); h.emit('pointerdown'); h.emit('pointermove', { clientX: 168 });
  assert.equal(h.state.cursorMs, 43_201_000); assert.equal(h.commits.length, 0); assert.equal(h.paused(), 1);
  assert.equal(h.$('timeline-overview').dataset.dragging, 'true');
  assert.deepEqual([h.state.inMs, h.state.outMs], [1000, 2000]);
  h.emit('pointerup', { clientX: 300 }); await Promise.resolve();
  assert.equal(h.commits.length, 1); assert.equal(h.commits[0].time, 43_201_000);
  assert.equal(h.commits[0].source, 'overview'); assert.equal(h.commits[0].options.autoplay, false);
  assert.equal(h.state.dragging, false); assert.equal(h.state.timelineSpanSeconds, 30);
});

test('局部轻点与垂直手势保留正在播放的媒体，不建立或提交选段', async () => {
  const h = fixture(); h.emit('pointerdown', { clientX: 50 }); h.emit('pointerup', { clientX: 50 });
  h.emit('pointerdown'); h.emit('pointermove', { clientY: 100 }); h.emit('pointerup'); await Promise.resolve();
  assert.equal(h.paused(), 0); assert.equal(h.state.cursorMs, 43_200_000); assert.equal(h.commits.length, 0);
  assert.equal(h.state.dragging, false); assert.deepEqual([h.state.inMs, h.state.outMs], [1000, 2000]);
});

test('四档任意切换只改变窗口和按下状态，不seek、不暂停、不改日期/游标/标记/播放状态', () => {
  const h = fixture({ span: 86400 });
  const values = () => JSON.stringify([h.state.date, h.state.cursorMs, h.state.inMs, h.state.outMs,
    h.state.previewMode, h.state.playbackAutoplay, h.state.followPlayback, h.$('replay-player').paused]);
  const before = values();
  for (const seconds of [30, 86400, 3600, 300, 30]) {
    h.c.setTimelineSpan(seconds); assert.equal(values(), before); assert.equal(h.state.timelineSpanSeconds, seconds);
    const view = h.c.timelineWindow(); assert.equal(view.span, seconds * 1000);
    assert.equal(view.start, seconds === 86400 ? 0 : h.state.cursorMs - seconds * 500);
    assert.deepEqual(h.buttons.map(button => button.attrs['aria-pressed']), [86400, 3600, 300, 30].map(value => String(value === seconds)));
  }
  h.c.setTimelineSpan(45); assert.equal(h.state.timelineSpanSeconds, 30);
  assert.equal(h.commits.length, 0); assert.equal(h.paused(), 0);
});

test('切档取消活动或已释放待提交手势，旧事件不产生seek，取消不会覆盖已显式编辑的标记', async () => {
  for (const released of [false, true]) {
    const h = fixture(); h.emit('pointerdown'); h.emit('pointermove', { clientX: 168 });
    h.state.inMs = 4000; h.state.outMs = 7000;
    if (released) h.emit('pointerup'); h.c.setTimelineSpan(3600); h.emit('pointerup'); await Promise.resolve();
    assert.equal(h.state.cursorMs, 43_200_000); assert.equal(h.state.timelineSpanSeconds, 3600);
    assert.deepEqual([h.state.inMs, h.state.outMs], [4000, 7000]); assert.equal(h.commits.length, 0);
    assert.equal(h.state.dragging, false); assert.equal(h.$('timeline-overview').dataset.dragging, 'false');
  }
});

test('真实setup尺寸改变恢复旧候选，换通道取消不恢复到新通道且保留档位和标记', () => {
  const h = fixture(); h.emit('pointerdown'); h.emit('pointermove', { clientX: 168 }); h.windowEvents.resize();
  assert.equal(h.state.cursorMs, 43_200_000); assert.equal(h.state.dragging, false); assert.equal(h.commits.length, 0);
  h.emit('pointerdown'); h.emit('pointermove', { clientX: 168 });
  h.state.selectedCamera = 'camera-b'; h.state.cursorMs = 9000; h.change('camera-select');
  assert.equal(h.state.cursorMs, 9000); assert.equal(h.state.dragging, false); assert.equal(h.state.timelineSpanSeconds, 30);
  assert.deepEqual([h.state.inMs, h.state.outMs], [1000, 2000]);
});

test('空录像不能拖动，隐藏旧轨道无第二套事件驱动或垂直缩放依赖', () => {
  const h = fixture(); h.state.segments = []; h.emit('pointerdown'); h.emit('pointermove', { clientX: 168 }); h.emit('pointerup');
  assert.equal(h.paused(), 0); assert.equal(h.commits.length, 0); assert.equal(h.state.dragging, false);
  const html = fs.readFileSync(new URL('../lib/status-dashboard.js', import.meta.url), 'utf8');
  assert.match(html, /class="timeline-scroll"[^>]*hidden[^>]*inert[^>]*aria-hidden="true"/);
  assert.match(html, /id="timeline"[^>]*tabindex="-1"/);
  assert.doesNotMatch(script, /\$\('timeline'\)\.addEventListener\('(pointer\w+|keydown)'/);
  assert.doesNotMatch(script, /replay-mode-(watch|select)|onModeChange/);
  const driver = fs.readFileSync(new URL('../public/precision-timeline.js', import.meta.url), 'utf8');
  assert.doesNotMatch(driver, /precision-scrub|precisionGain|gainAtDistance/);
});

test('可见尺键盘按整秒微调，Shift仍10秒，重复键不重复建预览', async () => {
  const h = fixture(); h.state.cursorMs = 43_200_490;
  const begin = script.indexOf("$('timeline-overview').addEventListener('keydown'");
  vm.runInContext(script.slice(begin, script.indexOf("$('go-live').addEventListener", begin)), h.c);
  h.emit('keydown', { key: 'ArrowRight' }); h.emit('keydown', { key: 'ArrowLeft', shiftKey: true });
  h.emit('keydown', { key: 'ArrowRight', repeat: true }); await Promise.resolve();
  assert.deepEqual(h.commits.map(commit => commit.time), [43_201_000, 43_190_000]);
});

test('登录失效的中断入口取消活动或已释放待提交手势', async () => {
  for (const released of [false, true]) {
    const h = fixture(); h.emit('pointerdown'); h.emit('pointermove', { clientX: 168 });
    if (released) h.emit('pointerup'); h.c.interruptTimelineScrub(); h.c.consoleSession++; h.emit('pointerup'); await Promise.resolve();
    assert.equal(h.commits.length, 0); assert.equal(h.state.dragging, false);
  }
  const logout = script.slice(script.indexOf('function loggedOut('), script.indexOf('async function start('));
  assert.match(logout, /function loggedOut\(message = ''\) \{\s*cancelExportSubmission\(true\);\s*cancelReplayHold\(\);\s*pendingTaskFocus = null;\s*interruptTimelineScrub\(\);/);
  assert.ok(logout.indexOf('interruptTimelineScrub();') < logout.indexOf('consoleSession++'));
});


test('切页清除媒体必须取消尚未跨门槛的按下、活动拖动和待提交，迟到释放不启动后台回放', async () => {
  for (const stage of ['pressed', 'dragging', 'released']) {
    const h = fixture({ span: 86400 }); h.emit('pointerdown', { clientX: 90 });
    if (stage !== 'pressed') h.emit('pointermove', { clientX: 110 });
    if (stage === 'released') h.emit('pointerup');
    assert.equal(h.state.dragging, stage !== 'pressed');
    h.c.document.body.dataset.view = 'tasks'; h.c.clearReplay();
    h.emit('pointermove', { clientX: 200 }); h.emit('pointerup'); await Promise.resolve();
    assert.equal(h.commits.length, 0, stage); assert.equal(h.state.dragging, false, stage);
    assert.equal(h.$('replay-player').hidden, true, stage);
    assert.deepEqual([h.state.inMs, h.state.outMs], [1000, 2000]);
  }
});
