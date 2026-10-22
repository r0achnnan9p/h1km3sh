import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bindPressRepeat } from '../public/press-repeat.js';

const source = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function load(context, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `missing actual function: ${name}`);
  const lineEnd = source.indexOf('\n', match.index);
  const firstLine = source.slice(match.index, lineEnd).trimEnd();
  const end = firstLine.endsWith('}') ? lineEnd : source.indexOf('\n}', match.index) + 2;
  vm.runInContext(source.slice(match.index, end), context);
}
class Target {
  listeners = new Map();
  disabled = false;
  hidden = false;
  value = '';
  attributes = new Map();
  classList = { add() {}, remove() {}, toggle() {} };
  addEventListener(name, listener, options) {
    const values = this.listeners.get(name) || [];
    values.push({ listener, capture: options === true || options?.capture === true });
    this.listeners.set(name, values);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(value => value.listener !== listener));
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  emit(name, properties = {}) {
    const event = { target: this, pointerId: 1, button: 0, isPrimary: true, detail: 1,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...properties };
    for (const { listener } of [...(this.listeners.get(name) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
      listener(event); if (event.stopped) break;
    }
    return event;
  }
}
function clock() {
  let now = 0, next = 0;
  const pending = new Map();
  return {
    setTimeout(fn, delay) { const id = ++next; pending.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const entry = [...pending].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        pending.delete(entry[0]); now = entry[1].at; entry[1].fn();
      }
      now = until;
    },
    get pending() { return pending.size; },
  };
}
function harness({ paused = false, buffered = false, playbackSource = 'mediamtx', date = '2020-02-03' } = {}) {
  const day = Date.parse(`${date}T00:00:00+08:00`), base = day + 18 * 3600000;
  const now = Date.parse('2020-02-04T10:20:30.900+08:00');
  const timers = clock(), window = new Target(), document = new Target(), nodes = new Map();
  window.setTimeout = timers.setTimeout; window.clearTimeout = timers.clearTimeout; document.defaultView = window;
  document.body = { dataset: { view: 'replay' } };
  const calls = { previews: [], seeks: [], renders: 0, updates: 0, loads: 0, pauses: 0, notices: [], fades: 0, labels: [] };
  const $ = id => {
    if (!nodes.has(id)) {
      const node = new Target(); node.ownerDocument = document;
      const captures = new Set();
      node.setPointerCapture = pointerId => captures.add(pointerId);
      node.hasPointerCapture = pointerId => captures.has(pointerId);
      node.releasePointerCapture = pointerId => { captures.delete(pointerId); node.emit('lostpointercapture', { pointerId }); };
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  $('dvr-select').value = 'recorder-a'; $('dvr-channel').value = '101';
  const video = $('replay-player'), mediaUrl = 'https://example.invalid/recording.mp4';
  let currentTime = 10;
  Object.defineProperty(video, 'currentTime', { get: () => currentTime, set: value => { calls.seeks.push(value); currentTime = value; } });
  const ranges = { length: buffered ? 1 : 0, start: () => 0, end: () => 120 };
  Object.assign(video, { paused, readyState: 4, seeking: false, ended: false, error: null, src: mediaUrl, currentSrc: mediaUrl,
    duration: 120, buffered: ranges, seekable: ranges,
    pause() { calls.pauses++; this.paused = true; }, load() { calls.loads++; },
    play() { this.paused = false; return Promise.resolve(); } });
  const state = { date, playbackSource, selectedCamera: 'camera-a', playbackSelectionVersion: 2, configRevision: 'synthetic-revision',
    previewMode: 'replay', playRequestId: 7, cursorMs: base + 10000, timelineStartMs: base - 140000, timelineSpanSeconds: 300,
    inMs: base + 1000, outMs: base + 90000, followPlayback: true, playbackAutoplay: !paused, playFormat: 'mp4',
    playBounds: { start: base, duration: 120, end: base + 120000, src: mediaUrl, camera: 'camera-a', date },
    segments: [{ start: new Date(day).toISOString(), duration: 86400 }] };
  const replayHoldButtons = [];
  const context = vm.createContext({ state, $, document, window, bindPressRepeat, replayHoldButtons,
    Date: class extends Date { static now() { return now; } }, today: () => '2020-02-04',
    renderTimeline() { calls.renders++; }, updateCursor() { calls.updates++; },
    showScrubTime: (...args) => calls.labels.push(args), fadeScrubTime() { calls.fades++; },
    syncReplayToggle() {}, syncPlaybackStatus() {}, debugMark() {}, stopHlsPreview() {}, interruptTimelineScrub() {},
    wallTime: value => new Date(value).toISOString(), setPlaybackNotice: (...args) => calls.notices.push(args),
    playAt(ms, { autoplay = true } = {}) {
      calls.previews.push({ ms, autoplay }); state.playRequestId++; state.cursorMs = ms; state.followPlayback = false;
      state.playbackAutoplay = autoplay; return Promise.resolve();
    },
  });
  for (const name of ['dateStart', 'segmentBounds', 'playbackContextKey', 'timelineWindow', 'timelineLimit', 'clampTimelineCenter',
    'setTimelineWindow', 'syncPlaybackCursor', 'jumpToTimelineTime', 'stepReplay', 'beginReplayHold', 'repeatReplayHold',
    'commitReplayHold', 'abandonReplayHold', 'cancelReplayHold', 'tryBufferedReplaySeek', 'finishBufferedReplaySeek',
    'continueReplay', 'finishLastRecordingFrame', 'clearReplay']) load(context, name);
  const bindingStart = source.indexOf("$('skip-back').addEventListener('click', () => stepReplay(-10));");
  const bindingEnd = source.indexOf("document.addEventListener('keydown'", bindingStart);
  assert.ok(bindingStart > 0 && bindingEnd > bindingStart);
  vm.runInContext(source.slice(bindingStart, bindingEnd), context);
  return { state, video, context, calls, $, timers, window, document, day, base, now,
    sampleTime(seconds) { currentTime = seconds; },
    hold(id = 'skip-forward') { $(id).emit('pointerdown'); timers.advance(350); return state.holdSeek; },
    release(id = 'skip-forward') { document.emit('pointerup'); $(id).emit('click'); },
  };
}
const marks = state => [state.inMs, state.outMs];

test('actual button integration accumulates locally and commits one final preview without a trailing click', () => {
  const h = harness(), originalMarks = marks(h.state); h.hold(); h.timers.advance(3 * 180);
  assert.equal(h.state.cursorMs, h.base + 50000); assert.equal(h.calls.previews.length, 0); assert.equal(h.calls.seeks.length, 0);
  assert.equal(h.calls.loads, 0); assert.equal(h.calls.pauses, 0); assert.deepEqual(marks(h.state), originalMarks);
  h.release(); h.timers.advance(2000);
  assert.deepEqual(h.calls.previews, [{ ms: h.base + 50000, autoplay: true }]); assert.equal(h.timers.pending, 0);
  assert.deepEqual(marks(h.state), originalMarks);
});

test('one release and duplicate pointerup call the transport at most once', () => {
  const h = harness(); const hold = h.hold(); h.timers.advance(180); h.release();
  h.document.emit('pointerup'); h.context.commitReplayHold(hold); h.timers.advance(2000);
  assert.deepEqual(h.calls.previews, [{ ms: h.base + 30000, autoplay: true }]); assert.equal(h.state.holdSeek, null);
});

test('short taps still use the original single ten-second action', () => {
  const h = harness({ paused: true }); h.$('skip-back').emit('pointerdown'); h.timers.advance(100); h.release('skip-back');
  assert.deepEqual(h.calls.previews, [{ ms: h.base, autoplay: false }]); assert.equal(h.state.holdSeek, undefined);
});

test('a buffered hold seeks the existing video once and never opens another media source', () => {
  for (const paused of [false, true]) {
    const h = harness({ paused, buffered: true }), requestId = h.state.playRequestId;
    h.hold(); h.timers.advance(2 * 180); assert.equal(h.calls.seeks.length, 0); assert.equal(h.calls.previews.length, 0);
    h.release(); assert.deepEqual(h.calls.seeks, [40]); assert.equal(h.calls.previews.length, 0);
    assert.equal(h.state.playRequestId, requestId); assert.equal(h.video.paused, paused); assert.equal(h.state.playbackAutoplay, !paused);
  }
});

test('old media timeupdates cannot move the held cursor or its timeline window', () => {
  const h = harness(); h.hold(); h.timers.advance(180);
  const selected = h.state.cursorMs, windowStart = h.state.timelineStartMs;
  h.sampleTime(22); h.video.emit('timeupdate'); h.context.syncPlaybackCursor();
  assert.equal(h.state.cursorMs, selected); assert.equal(h.state.timelineStartMs, windowStart);
  assert.equal(h.calls.seeks.length, 0); assert.equal(h.calls.previews.length, 0);
});

test('release keeps the original playback intent for paused and loading previews', () => {
  for (const mode of ['paused', 'loading', 'hidden']) {
    const h = harness({ paused: true });
    if (mode === 'loading') { h.state.followPlayback = false; h.state.playbackAutoplay = true; }
    if (mode === 'hidden') { h.video.hidden = true; h.state.playbackAutoplay = true; }
    h.hold(); h.release();
    assert.equal(h.calls.previews.length, 1, mode); assert.equal(h.calls.previews[0].autoplay, mode === 'loading', mode);
  }
});

test('changed date, source, camera, DVR, revision or request cannot receive an obsolete repeat or release', () => {
  const changes = {
    date: h => { h.state.date = '2020-02-02'; }, source: h => { h.state.playbackSource = 'dvr'; },
    camera: h => { h.state.selectedCamera = 'camera-b'; },
    recorder: h => { h.$('dvr-select').value = 'recorder-b'; }, channel: h => { h.$('dvr-channel').value = '201'; },
    selectionVersion: h => { h.state.playbackSelectionVersion++; }, revision: h => { h.state.configRevision = 'new-synthetic-revision'; },
    request: h => { h.state.playRequestId++; },
  };
  for (const [name, change] of Object.entries(changes)) for (const repeatFirst of [false, true]) {
    const h = harness({ playbackSource: ['recorder', 'channel'].includes(name) ? 'dvr' : 'mediamtx' });
    h.hold(); change(h); const cursor = h.day + 123000; h.state.cursorMs = cursor; h.state.timelineStartMs = h.day + 456000;
    const originalMarks = marks(h.state);
    if (repeatFirst) h.timers.advance(180);
    h.release(); h.timers.advance(1000);
    assert.equal(h.calls.previews.length, 0, `${name}/${repeatFirst}`); assert.equal(h.calls.seeks.length, 0, name);
    assert.equal(h.state.cursorMs, cursor, name); assert.equal(h.state.timelineStartMs, h.day + 456000, name);
    assert.deepEqual(marks(h.state), originalMarks); assert.equal(h.state.holdSeek, null);
  }
});

test('release on another tab cannot seek, and real change listeners cancel before later handlers', () => {
  const h = harness(); h.hold(); h.document.body.dataset.view = 'tasks'; h.release();
  assert.equal(h.calls.previews.length, 0); assert.equal(h.calls.seeks.length, 0);
  for (const id of ['date-select', 'playback-source', 'camera-select', 'dvr-select', 'dvr-channel']) {
    const h = harness({ paused: true }); h.hold(); let cancelledBeforeHandler = false;
    h.$(id).addEventListener('change', () => { cancelledBeforeHandler = h.state.holdSeek === null; });
    h.$(id).emit('change'); h.release();
    assert.equal(cancelledBeforeHandler, true, id); assert.equal(h.calls.previews.length, 0, id); assert.equal(h.calls.seeks.length, 0, id);
  }
});

test('cancelling restores a paused snapshot only in the same context; playing cancellation resamples the actual frame', () => {
  const paused = harness({ paused: true }), original = { cursor: paused.state.cursorMs, window: paused.state.timelineStartMs };
  paused.hold(); paused.timers.advance(360); paused.context.cancelReplayHold(); paused.release();
  assert.equal(paused.state.cursorMs, original.cursor); assert.equal(paused.state.timelineStartMs, original.window);
  assert.equal(paused.calls.previews.length, 0); assert.equal(paused.calls.seeks.length, 0);
  const playing = harness(); playing.hold(); playing.sampleTime(14); playing.context.cancelReplayHold();
  assert.equal(playing.state.cursorMs, playing.base + 14000); assert.equal(playing.calls.previews.length, 0);
  const changed = harness({ paused: true }); changed.hold(); changed.state.selectedCamera = 'camera-b';
  changed.state.cursorMs = changed.day + 25000; changed.context.cancelReplayHold();
  assert.equal(changed.state.cursorMs, changed.day + 25000); assert.equal(changed.calls.previews.length, 0);
});

test('day edges and today clamp repeated positions without changing marks', () => {
  for (const mode of ['start', 'end', 'today']) {
    const h = harness({ date: mode === 'today' ? '2020-02-04' : '2020-02-03' }); h.state.followPlayback = false;
    h.state.cursorMs = mode === 'start' ? h.day + 5000 : mode === 'end' ? h.day + 86395000 : Math.floor(h.now / 1000) * 1000 - 5000;
    const before = marks(h.state), id = mode === 'start' ? 'skip-back' : 'skip-forward'; h.hold(id); h.timers.advance(1000);
    const expected = mode === 'start' ? h.day : mode === 'end' ? h.day + 86399000 : Math.floor(h.now / 1000) * 1000;
    assert.equal(h.state.cursorMs, expected, mode); assert.deepEqual(marks(h.state), before);
    assert.equal(h.calls.previews.length, 0); assert.equal(h.calls.seeks.length, 0);
    h.release(id); assert.equal(h.calls.previews.length, 1); assert.equal(h.calls.previews[0].ms, expected);
  }
});

test('live, missing-date and empty-recording states cannot create a hold', () => {
  for (const mode of ['live', 'date', 'segments']) {
    const h = harness();
    if (mode === 'live') h.state.previewMode = 'live';
    if (mode === 'date') h.state.date = '';
    if (mode === 'segments') h.state.segments = [];
    assert.equal(h.context.beginReplayHold(), null); h.context.repeatReplayHold(null, 10); h.context.commitReplayHold(null);
    assert.equal(h.calls.previews.length, 0); assert.equal(h.calls.seeks.length, 0);
  }
});

test('clearReplay cancels the real hold control before clearing media, preserving both marks', () => {
  const h = harness(), before = marks(h.state); h.hold(); h.context.clearReplay(); h.timers.advance(2000); h.release();
  assert.equal(h.state.holdSeek, null); assert.equal(h.timers.pending, 0); assert.equal(h.video.hidden, true);
  assert.equal(h.calls.previews.length, 0); assert.equal(h.calls.seeks.length, 0); assert.deepEqual(marks(h.state), before);
});

test('a media chunk ending during a hold waits for the chosen final seek instead of auto-continuing', () => {
  const h = harness(); h.state.playBounds.duration = 30; h.video.duration = 30; h.sampleTime(20);
  const hold = h.hold(); h.timers.advance(180); const target = h.state.cursorMs, request = h.state.playRequestId;
  h.sampleTime(30); h.video.ended = true; h.context.continueReplay();
  assert.equal(h.calls.previews.length, 0); assert.equal(h.state.playRequestId, request);
  assert.equal(h.state.holdSeek, hold); assert.equal(h.state.cursorMs, target);
  h.release(); assert.deepEqual(h.calls.previews, [{ ms: target, autoplay: true }]);
});

test('late buffered seek settlement cannot overwrite an active hold or start a fallback source', () => {
  for (const exact of [true, false]) {
    const h = harness({ buffered: true }); h.context.stepReplay(10); const pending = h.state.pendingLocalSeek;
    h.hold(); h.timers.advance(180); const target = h.state.cursorMs, beforeSeeks = h.calls.seeks.length;
    h.sampleTime(exact ? pending.offset : 1); h.context.finishBufferedReplaySeek();
    assert.equal(h.state.cursorMs, target, String(exact)); assert.equal(h.calls.previews.length, 0, String(exact));
    assert.equal(h.calls.seeks.length, beforeSeeks); assert.equal(h.state.pendingLocalSeek, null);
    h.release(); assert.ok(h.calls.previews.length <= 1); assert.equal(h.state.cursorMs, target);
  }
});

test('late last-frame fallback callbacks cannot seek or move the position selected by a hold', () => {
  for (const seeking of [false, true]) {
    const h = harness({ paused: true, buffered: true }); h.state.previewMode = 'last-frame'; h.state.followPlayback = false;
    h.state.lastFramePending = { requestId: h.state.playRequestId, src: h.video.src, end: h.base + 30000, seeking };
    h.hold(); h.timers.advance(2 * 180); const target = h.state.cursorMs, window = h.state.timelineStartMs;
    h.sampleTime(29.999); h.context.finishLastRecordingFrame();
    assert.equal(h.state.cursorMs, target, String(seeking)); assert.equal(h.state.timelineStartMs, window);
    assert.equal(h.calls.seeks.length, 0); assert.equal(h.calls.previews.length, 0);
  }
});


test('十秒短按和长按从媒体小数时钟定位到整秒，缓冲快路也只提交一次', () => {
  for (const buffered of [false, true]) for (const held of [false, true]) for (const direction of [-1, 1]) {
    const h = harness({ buffered }), id = direction < 0 ? 'skip-back' : 'skip-forward';
    h.sampleTime(10.234);
    if (held) { h.hold(id); h.timers.advance(180); }
    else { h.$(id).emit('pointerdown'); h.timers.advance(100); }
    const expected = Math.max(h.day, h.base + (10 + direction * (held ? 20 : 10)) * 1000);
    h.release(id);
    assert.equal(h.state.cursorMs, expected, `${buffered}/${held}/${direction}`);
    assert.equal(h.state.cursorMs % 1000, 0);
    assert.equal(h.calls.previews.length + h.calls.seeks.length, 1);
    if (h.calls.previews.length) assert.equal(h.calls.previews[0].ms, expected);
    if (h.calls.seeks.length) assert.equal(h.calls.seeks[0], (expected - h.base) / 1000);
    assert.deepEqual(marks(h.state), [h.base + 1000, h.base + 90000]);
  }
});

test('十秒短按在日期末尾停于23:59:59，今日夹到当前整秒，回退不越日', () => {
  for (const mode of ['start', 'end', 'today']) {
    const h = harness({ paused: true, date: mode === 'today' ? '2020-02-04' : '2020-02-03' }); h.state.followPlayback = false;
    h.state.cursorMs = mode === 'start' ? h.day + 5234 : mode === 'end' ? h.day + 86395234 : h.now - 5234;
    h.context.stepReplay(mode === 'start' ? -10 : 10);
    const expected = mode === 'start' ? h.day : mode === 'end' ? h.day + 86399000 : Math.floor(h.now / 1000) * 1000;
    assert.deepEqual(h.calls.previews, [{ ms: expected, autoplay: false }]);
    assert.equal(h.state.cursorMs, expected); assert.equal(h.state.cursorMs % 1000, 0);
  }
});
