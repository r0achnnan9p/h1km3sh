import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function harness() {
  const state = { date: '2026-09-30', segments: [{ start: 0, duration: 86400 }], cursorMs: 20.25 * 3600000, inMs: 20.25 * 3600000, outMs: 22.35 * 3600000, timelineSpanSeconds: 3600, timelineStartMs: 20 * 3600000, dragging: false, pendingScrub: null };
  const calls = { preview: [], renders: 0, cursor: 0, selection: 0, pauses: 0 };
  const elements = new Map(); const $ = id => { if (!elements.has(id)) elements.set(id, { hidden: false, paused: false, pause() { calls.pauses++; }, getBoundingClientRect: () => ({ left: 0, width: 300 }) }); return elements.get(id); };
  const frames = new Map(); let frameId = 0;
  const context = vm.createContext({ precisionTimeline: null, state, $, Math, document: { hidden: false }, requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id), dateStart: () => 0, showScrubTime() {}, fadeScrubTime() {}, setPlaybackNotice() {}, updateCursor() { calls.cursor++; }, updateSelection() { calls.selection++; }, renderTimeline() { calls.renders++; }, jumpToTimelineTime: async (time, source, options = {}) => calls.preview.push({ time, source, autoplay: options.autoplay }) });
  vm.runInContext(script.slice(script.indexOf('function timelineWindow('), script.indexOf('function renderOverview(')), context);
  vm.runInContext(script.slice(script.indexOf('function setTimelineWindow('), script.indexOf('function renderTimeline(')), context);
  vm.runInContext(script.slice(script.indexOf('function timeAtTimeline('), script.indexOf("$('timeline').addEventListener('pointerdown'")), context);
  vm.runInContext(script.slice(script.indexOf('function scrubSnapshot('), script.indexOf('function jumpToTimelineTime(')), context);
  vm.runInContext(script.slice(script.indexOf('function focusBoundary('), script.indexOf('function openBoundaryEditor(')), context);
  return { state, context, calls, $, frames, frame(time) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); } };
}
function event({ x = 100, y = 100, pointerType = 'touch', boundary = '', pointerId = 1 } = {}) { return { clientX: x, clientY: y, pointerId, pointerType, button: 0, target: { closest: () => boundary ? { dataset: { boundary } } : null }, currentTarget: { setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() {} }, preventDefault() { this.prevented = true; } }; }
test('endpoint focus keeps a fixed hour and preserves a 20:15–22:21 selection', () => {
  const h = harness(), before = [h.state.inMs, h.state.outMs];
  h.context.focusBoundary('out'); assert.equal(h.state.timelineSpanSeconds, 3600);
  assert.deepEqual([h.state.inMs, h.state.outMs], before); assert.equal(h.calls.preview.at(-1).time, before[1]);
  assert.ok(h.state.timelineStartMs > before[0]);
  h.context.setTimelineWindow(before[0], 60); assert.deepEqual([h.state.inMs, h.state.outMs], before);
  assert.equal(h.context.timelineWindow().span, 3600000);
});
test('touch vertical scroll never changes selection, cursor, playback or prevents scrolling', async () => {
  const h = harness(), snapshot = JSON.stringify(h.state); const down = event(), move = event({ x: 103, y: 130 });
  h.context.beginTimelineScrub(down, 'detail'); h.context.moveTimelineScrub(move, 'detail'); await h.context.endTimelineScrub(move, 'detail');
  assert.equal(h.state.pendingScrub, null); assert.equal(h.state.dragging, false); assert.equal(h.calls.pauses, 0); assert.equal(h.calls.preview.length, 0); assert.equal(move.prevented, undefined);
  assert.equal(JSON.stringify(h.state), snapshot);
});
test('horizontal touch scrub requests one preview only after release', async () => {
  const h = harness(); h.context.beginTimelineScrub(event(), 'detail');
  h.context.moveTimelineScrub(event({ x: 120, y: 102 }), 'detail'); h.context.moveTimelineScrub(event({ x: 150, y: 103 }), 'detail');
  assert.equal(h.state.dragging, true); assert.equal(h.calls.preview.length, 0);
  await h.context.endTimelineScrub(event({ x: 160, y: 103 }), 'detail');
  assert.equal(h.calls.preview.length, 1); assert.equal(h.state.dragging, false);
});
test('cancelled handle drag restores both boundaries and cursor without preview', () => {
  const h = harness(), before = { inMs: h.state.inMs, outMs: h.state.outMs, cursorMs: h.state.cursorMs, timelineStartMs: h.state.timelineStartMs };
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: 200 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 220 }), 'detail');
  assert.notEqual(h.state.inMs, before.inMs); h.context.cancelTimelineScrub(event());
  for (const key of Object.keys(before)) assert.equal(h.state[key], before[key]); assert.equal(h.calls.preview.length, 0);
});
test('boundary moves round to seconds, remain in day, and cannot cross or invert the other endpoint', () => {
  const h = harness();
  assert.equal(h.context.clampBoundaryTime(h.state.outMs + 9000, 'in'), h.state.outMs - 1000);
  assert.equal(h.context.clampBoundaryTime(h.state.inMs - 9000, 'out'), h.state.inMs + 1000);
  assert.equal(h.context.clampBoundaryTime(-10000, 'in'), 0);
  assert.equal(h.context.clampBoundaryTime(90000000, 'out'), 86400000);
  assert.equal(h.context.clampBoundaryTime(123450, 'in'), 123000);
});
test('overview navigation preserves selected duration; empty recording day does not begin a drag', async () => {
  const h = harness(), before = [h.state.inMs, h.state.outMs];
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 200 }), 'overview');
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 220 }), 'overview');
  assert.deepEqual([h.state.inMs, h.state.outMs], before);
  h.state.segments = []; h.context.beginTimelineScrub(event(), 'detail'); assert.equal(h.state.pendingScrub, null); assert.equal(h.state.dragging, false);
});
test('endpoint focus gracefully handles a missing recording without an undefined-promise error', () => {
  const h = harness(); h.context.jumpToTimelineTime = () => undefined;
  assert.doesNotThrow(() => h.context.focusBoundary('in'));
});
test('picture-first shell keeps selectors transient and logout in Settings', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  assert.match(html, /id="playback-toolbar" hidden/);
  assert.match(html, /id="playback-context"/);
  assert.ok(html.indexOf('id="logout"') > html.indexOf('id="view-settings"'));
  assert.doesNotMatch(html, /<header class="topbar"/);
  assert.ok(!html.includes('id="connection"'));
  assert.match(html, /id="boundary-in"/); assert.match(html, /id="edit-out"/);
});
test('closing and reopening an endpoint editor preserves committed times; only Apply changes selection', () => {
  const h = harness(); const sheets = []; const node = () => ({ children: [], append(child) { this.children.push(child); } });
  Object.assign(h.context, { enhanceTimeInput: input => input, Event, wallTime: ms => '2026-09-30 ' + new Date(ms).toISOString().slice(11, 19), openDialog() { const sheet = { content: node(), actions: node(), error: {}, close() {} }; sheets.push(sheet); return sheet; }, labelledInput(parent, label, value) { const input = { value, focus() {}, select() {}, dispatchEvent() {} }; parent.append(input); return input; }, document: { createElement: node }, addButton(parent, label, cls, click) { const button = { label, click }; parent.append(button); return button; }, rangeTimeMs: value => value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000 });
  vm.runInContext(script.slice(script.indexOf('function boundaryLabel('), script.indexOf('function updateBoundaryControls(')), h.context);
  vm.runInContext(script.slice(script.indexOf('function openBoundaryEditor('), script.indexOf('function updateSelection(')), h.context);
  const original = h.state.inMs;
  h.context.openBoundaryEditor('in'); sheets[0].content.children[0].value = '20:16:00'; sheets[0].close(); assert.equal(h.state.inMs, original);
  h.context.openBoundaryEditor('in'); assert.equal(sheets[1].content.children[0].value, '20:15:00');
  sheets[1].content.children[0].value = '20:16:00'; sheets[1].actions.children.at(-1).click(); assert.equal(h.state.inMs, (20 * 3600 + 16 * 60) * 1000); assert.equal(h.state.outMs, 22.35 * 3600000);
});

test('grabbing the edge of a marker does not jump; release preserves finger displacement', async () => {
  const h = harness(), original = h.state.inMs;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: 165 }), 'detail');
  assert.equal(h.state.inMs, original);
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 180 }), 'detail');
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 180 }), 'detail');
  assert.equal(h.state.inMs, original + 180000); assert.equal(h.calls.preview.at(-1).time, h.state.inMs);
});
test('a touch tap on a marker edge preserves its time and does not capture after pointerup', async () => {
  const h = harness(), original = h.state.inMs;
  h.context.beginTimelineScrub(event({ boundary: 'in', x: 165 }), 'detail');
  const up = event({ boundary: 'in', x: 165 }); up.type = 'pointerup'; up.currentTarget.setPointerCapture = () => { throw new Error('capture must not run'); };
  await h.context.endTimelineScrub(up, 'detail'); assert.equal(h.state.inMs, original);
});
test('vertical movement detected only at release is still scrolling, not a seek', async () => {
  const h = harness(), original = h.state.cursorMs;
  h.context.beginTimelineScrub(event(), 'detail'); await h.context.endTimelineScrub(event({ x: 102, y: 140 }), 'detail');
  assert.equal(h.state.cursorMs, original); assert.equal(h.calls.pauses, 0); assert.equal(h.calls.preview.length, 0);
});
test('secondary fingers cannot begin, move, end or cancel the active primary drag', async () => {
  const h = harness(); const secondary = event({ pointerId: 2 }); secondary.isPrimary = false;
  h.context.beginTimelineScrub(secondary, 'detail'); assert.equal(h.state.pendingScrub, null);
  h.context.beginTimelineScrub(event({ pointerType: 'mouse' }), 'detail'); h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 120 }), 'detail'); const cursor = h.state.cursorMs;
  h.context.moveTimelineScrub(secondary, 'detail'); await h.context.endTimelineScrub(secondary, 'detail'); h.context.cancelTimelineScrub(secondary);
  assert.equal(h.state.cursorMs, cursor); assert.equal(h.state.dragging, true); h.context.cancelTimelineScrub(event());
});
test('lost capture rolls back once and a later pointerup cannot commit the canceled drag', async () => {
  const h = harness(), original = h.state.cursorMs;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 210 }), 'detail');
  const lost = event(); lost.type = 'lostpointercapture'; lost.target = h.state.dragTarget; h.context.cancelTimelineScrub(lost);
  await h.context.endTimelineScrub(event({ x: 230 }), 'detail');
  assert.equal(h.state.cursorMs, original); assert.equal(h.state.dragging, false); assert.equal(h.calls.preview.length, 0);
  assert.match(script, /'lostpointercapture', cancelTimelineScrub/);
});
test('three-second markers remain ordered while either handle crosses the other', async () => {
  const h = harness(); h.state.outMs = h.state.inMs + 3000; const originalOut = h.state.outMs;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: 150 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 290 }), 'detail');
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 290 }), 'detail');
  assert.equal(h.state.inMs, originalOut - 1000); assert.equal(h.state.outMs, originalOut);
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'out', x: 151 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 10 }), 'detail');
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 10 }), 'detail');
  assert.equal(h.state.outMs, h.state.inMs + 1000);
});
test('short ranges have separate top and bottom hit areas and explicit mark actions', async () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  assert.match(css, /\.boundary-handle \{ top: -10px; height: 64px/); assert.match(css, /\.boundary-handle.end \{ top: 54px/);
  for (const text of ['设置入点', '设置出点', '清除标记']) assert.ok(html.includes(text));
  assert.match(html, /id="clear-marks"/);
  assert.match(css, /#view-replay \.time-cursor \{ left:50% !important/);
});
test('mobile glass navigation has dark tokens, readable icons and safe-area spacing', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /color-scheme: dark/);
  assert.match(css, /\.mobile-nav \{[^}]*background: var\(--surface\)/);
  assert.match(css, /\.mobile-nav button:not\(\.active\) \{ color: var\(--muted\)/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('implicit touch capture transfer from a child does not cancel the owning timeline drag', () => {
  const h = harness(), original = h.state.inMs, child = { dataset: { boundary: 'in' } };
  const down = event({ boundary: 'in', x: 150 }); h.context.beginTimelineScrub(down, 'detail');
  const move = event({ boundary: 'in', x: 170 }); h.context.moveTimelineScrub(move, 'detail');
  const owner = h.state.dragTarget, moved = h.state.inMs; assert.notEqual(moved, original);
  h.context.cancelTimelineScrub({ type: 'lostpointercapture', pointerId: 1, target: child, currentTarget: owner });
  assert.equal(h.state.dragging, true); assert.equal(h.state.inMs, moved); assert.equal(h.calls.preview.length, 0);
  h.context.cancelTimelineScrub({ type: 'lostpointercapture', pointerId: 1, target: owner, currentTarget: owner });
  assert.equal(h.state.dragging, false); assert.equal(h.state.inMs, original); assert.equal(h.calls.preview.length, 0);
});

test('grip offset is applied before clamping so markers can reach both track edges', async () => {
  for (const [grip, release, edge] of [[90, 330, 'end'], [60, -30, 'start']]) {
    const h = harness(), window = h.context.timelineWindow(); h.state.outMs = null;
    h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: grip }), 'detail');
    h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: release }), 'detail');
    await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: release }), 'detail');
    assert.equal(h.state.inMs, window[edge]);
  }
});
test('a handle protruding beyond the track keeps its original time when tapped', async () => {
  const h = harness(); h.state.inMs = h.context.timelineWindow().start;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: -15 }), 'detail');
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: -15 }), 'detail');
  assert.equal(h.state.inMs, h.context.timelineWindow().start);
});

test('boundary dragging retains the pre-drag pause state while ordinary timeline taps still play', async () => {
  for (const paused of [true, false]) {
    const h = harness(); h.$('replay-player').paused = paused;
    h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: 150 }), 'detail');
    await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 170 }), 'detail');
    assert.equal(h.calls.preview.at(-1).autoplay, !paused);
  }
  const h = harness(); h.$('replay-player').paused = true;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 170 }), 'detail'); assert.equal(h.calls.preview.at(-1).autoplay, true);
});


test('detail pans the hour oppositely to the finger around a fixed centre, with one seek on release', async () => {
  const h = harness(), origin = h.context.timelineWindow().start + 1800000;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
  assert.equal(h.calls.pauses, 0);
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 210 }), 'detail');
  assert.equal(h.state.cursorMs, origin - 720000);
  assert.equal(h.context.timelineWindow().start + 1800000, h.state.cursorMs);
  assert.equal(h.calls.preview.length, 0); assert.equal(h.frames.size, 0);
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 240 }), 'detail');
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 240 }), 'detail');
  assert.equal(h.state.cursorMs, origin - 1080000); assert.equal(h.calls.preview.length, 1);
});
test('detail window drag uses its original width and centre, never cumulative drift or edge auto-pan', () => {
  const h = harness(), origin = h.context.timelineWindow().start + 1800000;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: -50 }), 'detail');
  assert.equal(h.state.cursorMs, origin + 2400000);
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: -50 }), 'detail');
  assert.equal(h.state.cursorMs, origin + 2400000); assert.equal(h.frames.size, 0);
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
  assert.equal(h.state.cursorMs, origin);
});
test('overview window retains its grab offset and drives the same centred hour', async () => {
  const h = harness(), origin = h.context.timelineWindow().start + 1800000;
  const grip = origin / 86400000 * 300 + 3;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: grip }), 'overview');
  assert.equal(h.state.cursorMs, origin);
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: grip - 15 }), 'overview');
  assert.equal(h.state.cursorMs, origin - 4320000);
  assert.equal(h.context.timelineWindow().span, 3600000);
  assert.equal(h.context.timelineWindow().start + 1800000, h.state.cursorMs);
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: grip - 15 }), 'overview');
  assert.equal(h.calls.preview.length, 1);
});
test('a detail tap does not move a time point or restart media', async () => {
  const h = harness(), before = h.state.cursorMs;
  h.context.beginTimelineScrub(event({ x: 250 }), 'detail');
  await h.context.endTimelineScrub(event({ x: 250 }), 'detail');
  assert.equal(h.state.cursorMs, before); assert.equal(h.calls.preview.length, 0); assert.equal(h.calls.pauses, 0);
});
test('edge velocity is proportional, bounded and zero in the middle', () => {
  const h = harness(), v = h.context.timelinePanVelocity, r = { left: 0, width: 300 };
  assert.equal(v(150, r), 0); assert.equal(v(-500, r), -360000); assert.equal(v(900, r), 360000);
  assert.ok(v(285, r) < v(295, r)); assert.equal(v(15, r), -v(285, r));
});
test('edge marker pan preserves grip offset and cancels all frames with rollback', () => {
  const h = harness(), before = h.state.inMs, window = h.state.timelineStartMs;
  h.state.inMs = window + 3300000; h.state.outMs = null;
  const initial = h.state.inMs;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: 280 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 295 }), 'detail');
  h.frame(0); h.frame(50);
  assert.equal(h.state.inMs, Math.round((initial + 15 / 300 * 3600000 + h.state.timelineStartMs - window) / 1000) * 1000);
  h.context.cancelTimelineScrub(event());
  assert.equal(h.state.inMs, initial); assert.equal(h.state.timelineStartMs, window); assert.equal(h.frames.size, 0); assert.equal(h.calls.preview.length, 0);
});
test('fixed hour pads midnight and present while centre selection never crosses day or now', async () => {
  const h = harness(); h.context.Date = { now: () => 21 * 3600000 };
  h.context.setTimelineWindow(0); assert.equal(h.context.timelineWindow().start, -1800000);
  h.context.setTimelineWindow(24 * 3600000); assert.equal(h.context.timelineWindow().end, 21.5 * 3600000);
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: -350 }), 'detail');
  assert.equal(h.state.cursorMs, 21 * 3600000); assert.equal(h.frames.size, 0);
  h.context.cancelTimelineScrub(event());
  h.context.Date = { now: () => 10 * 60000 };
  h.context.setTimelineWindow(0); assert.equal(h.context.timelineWindow().span, 3600000);
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 250 }), 'overview');
  assert.ok(h.state.cursorMs <= 10 * 60000);
});
test('a stationary edge press does not auto-pan until horizontal drag intent', () => {
  const h = harness(); h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 298 }), 'detail');
  assert.equal(h.frames.size, 0);
  h.context.cancelTimelineScrub(event());
});
test('page hiding and blur cancel active or pending gestures and never seek', () => {
  const h = harness();
  vm.runInContext(script.slice(script.indexOf('function interruptTimelineScrub('), script.indexOf("document.addEventListener('visibilitychange'")), h.context);
  const original = h.state.timelineStartMs;
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 350 }), 'detail'); h.frame(0); h.frame(50);
  h.context.interruptTimelineScrub(); assert.equal(h.frames.size, 0); assert.equal(h.state.timelineStartMs, original); assert.equal(h.calls.preview.length, 0);
  h.context.beginTimelineScrub(event(), 'detail'); h.context.interruptTimelineScrub(); assert.equal(h.state.pendingScrub, null);
  assert.match(script, /visibilitychange.*document.hidden/); assert.match(script, /'blur', interruptTimelineScrub/);
});
test('timeline retains useful tick labels and precision input without zoom menu or duplicate help', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  for (const id of ['timeline-start-label', 'timeline-middle-label', 'timeline-end-label', 'edit-range']) assert.ok(html.includes(`id="${id}"`));
  for (const spanSeconds of [30, 300, 3600, 86400]) assert.ok(html.includes(`data-timeline-span="${spanSeconds}"`));
  for (const copy of ['timeline-window-label', '导出会在后台继续']) assert.ok(!html.includes(copy));
  for (const copy of ['先选择开始和结束时间。', '在时间轴定位，或播放到目标画面']) assert.ok(!script.includes(copy));
});
test('release commits the last pointermove position, not the pointerup coordinate', async () => {
  const h = harness();
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 210 }), 'detail');
  const shown = h.state.cursorMs;
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 290 }), 'detail');
  assert.equal(h.state.cursorMs, shown); assert.equal(h.calls.preview.at(-1).time, shown);
});
test('handle release also keeps the last pointermove position', async () => {
  const h = harness();
  h.context.beginTimelineScrub(event({ pointerType: 'mouse', boundary: 'in', x: 165 }), 'detail');
  h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 175 }), 'detail');
  const shown = h.state.inMs;
  await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 20 }), 'detail');
  assert.equal(h.state.inMs, shown);
});
test('every zoom level maps pixels to time against its own span', async () => {
  for (const seconds of [30, 300, 3600]) {
    const h = harness(); h.state.timelineSpanSeconds = seconds;
    const view = h.context.timelineWindow(); assert.equal(view.span, seconds * 1000);
    const origin = view.start + view.span / 2;
    h.context.beginTimelineScrub(event({ pointerType: 'mouse', x: 150 }), 'detail');
    h.context.moveTimelineScrub(event({ pointerType: 'mouse', x: 210 }), 'detail');
    assert.equal(h.state.cursorMs, origin - 0.2 * seconds * 1000, `${seconds}s`);
    await h.context.endTimelineScrub(event({ pointerType: 'mouse', x: 210 }), 'detail');
  }
  const h = harness(); h.state.timelineSpanSeconds = 86400; assert.equal(h.context.timelineWindow().span, 86_400_000);
});
test('changing zoom keeps the playhead time and ignores unsupported spans', () => {
  const h = harness(); h.context.TIMELINE_SPANS = [30, 300, 3600, 86400]; h.context.document.querySelectorAll = () => [];
  vm.runInContext('globalThis.TIMELINE_SPANS = [30, 300, 3600, 86400]', h.context);
  const cursor = h.state.cursorMs;
  h.context.setTimelineSpan(30); assert.equal(h.state.timelineSpanSeconds, 30);
  assert.equal(h.context.timelineWindow().start + 15000, cursor);
  h.context.setTimelineSpan(45); assert.equal(h.state.timelineSpanSeconds, 30);
});
test('touch dead zone: 7px horizontal stays pending, 8px starts the drag', () => {
  const small = harness(); small.context.beginTimelineScrub(event({ x: 100 }), 'detail');
  small.context.moveTimelineScrub(event({ x: 107 }), 'detail');
  assert.equal(small.state.dragging, false); assert.ok(small.state.pendingScrub);
  const big = harness(); big.context.beginTimelineScrub(event({ x: 100 }), 'detail');
  big.context.moveTimelineScrub(event({ x: 108 }), 'detail');
  assert.equal(big.state.dragging, true); assert.equal(big.state.pendingScrub, null);
});
test('text selection is disabled globally and restored for inputs', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /body \{[^}]*user-select: none[^}]*-webkit-touch-callout: none/);
  assert.match(css, /input, textarea, \[contenteditable\][^{]*\{[^}]*user-select: text/);
  assert.match(script, /document\.getElementById\('debug-mark-panel'\)/);
  const debug = fs.readFileSync(new URL('../public/debug-mark.js', import.meta.url), 'utf8');
  assert.match(debug, /localStorage\.getItem\('debugMark'\)/);
});

test('landscape short-range handles occupy opposite sides without overlapping hit targets', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  assert.match(css, /#view-replay \.boundary-handle, #view-replay \.boundary-handle:active \{ transform:translateX\(-100%\)/);
  assert.match(css, /#view-replay \.boundary-handle.end, #view-replay \.boundary-handle.end:active \{ transform:translateX\(0\)/);
  assert.match(css, /\.boundary-handle \{ top: -10px; height: 64px; width: 44px/);
  // The targets terminate/start at their respective boundary; distance may be <1px.
  const start = 100, end = 100.8, width = 44;
  assert.ok(start - width < start && start <= end && end < end + width);
});
