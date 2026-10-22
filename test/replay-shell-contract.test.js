import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');

test('picture-first shell keeps selectors transient and logout in Settings', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  assert.match(html, /id="playback-toolbar" hidden/);
  assert.match(html, /id="playback-context"/);
  assert.ok(html.indexOf('id="logout"') > html.indexOf('id="view-settings"'));
  assert.doesNotMatch(html, /<header class="topbar"/);
  assert.ok(!html.includes('id="connection"'));
  assert.match(html, /id="boundary-in"/); assert.match(html, /id="edit-out"/);
});

test('short ranges have separate top and bottom hit areas and explicit mark actions', async () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  assert.match(css, /\.boundary-handle \{ top: -10px; height: 64px/); assert.match(css, /\.boundary-handle\.end \{ top: 54px/);
  for (const text of ['设置入点', '设置出点', '清除入点和出点']) assert.ok(html.includes(text));
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

test('timeline retains four explicit windows and precision input without duplicate help', async () => {
  const { statusDashboardPage } = await import('../lib/status-dashboard.js'); const html = statusDashboardPage();
  for (const id of ['timeline-start-label', 'timeline-middle-label', 'timeline-end-label', 'edit-in', 'edit-out']) assert.ok(html.includes(`id="${id}"`));
  for (const spanSeconds of [30, 300, 3600, 86400]) assert.ok(html.includes(`data-timeline-span="${spanSeconds}"`));
  for (const copy of ['timeline-window-label', '导出会在后台继续']) assert.ok(!html.includes(copy));
  for (const copy of ['先选择开始和结束时间。', '在时间轴定位，或播放到目标画面']) assert.ok(!script.includes(copy));
});

test('changing zoom keeps the playhead time and ignores unsupported spans', () => {
  const state = { date: '2026-09-30', segments: [{ start: '2026-09-30T00:00:00.000Z', duration: 86400 }], cursorMs: 20.25 * 3600000, inMs: null, outMs: null, timelineSpanSeconds: 3600, timelineStartMs: 20 * 3600000 };
  const context = vm.createContext({
    precisionTimeline: null, state, Math, document: { querySelectorAll: () => [] },
    dateStart: () => 0, timelineLimit: () => 86400000, renderTimeline() {}, syncTimelineZoomButtons() {}
  });
  vm.runInContext(script.slice(script.indexOf('function timelineWindow('), script.indexOf('function renderOverview(')), context);
  vm.runInContext(script.slice(script.indexOf('function setTimelineWindow('), script.indexOf('function renderTimeline(')), context);
  vm.runInContext('globalThis.TIMELINE_SPANS = [30, 300, 3600, 86400]', context);
  const cursor = state.cursorMs;
  context.setTimelineSpan(30); assert.equal(state.timelineSpanSeconds, 30);
  assert.equal(context.timelineWindow().start + 15000, cursor);
  context.setTimelineSpan(45); assert.equal(state.timelineSpanSeconds, 30);
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
  assert.match(css, /#view-replay \.boundary-handle\.end, #view-replay \.boundary-handle\.end:active \{ transform:translateX\(0\)/);
  assert.match(css, /\.boundary-handle \{ top: -10px; height: 64px; width: 44px/);
  const start = 100, end = 100.8, width = 44;
  assert.ok(start - width < start && start <= end && end < end + width);
});
