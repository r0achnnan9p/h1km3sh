import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { bindPressRepeat } from '../public/press-repeat.js';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function harness() {
  const state = { date: '2026-09-30', cursorMs: 5226000, inMs: null, outMs: null, playBounds: { start: 5226000, duration: 600 }, playRequestId: 0, playbackSource: 'mediamtx', selectedCamera: 'D2', segments: [{ start: '1970-01-01T00:00:00Z', duration: 86400 }], timelineSpanSeconds: 3600, timelineStartMs: 4800000, dragging: false, followPlayback: false };
  const elements = new Map(), notices = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, { hidden: false, paused: true, readyState: 0, error: null, seeking: false, currentTime: 0, duration: NaN, src: 'http://test/old', currentSrc: 'http://test/old', listeners: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; }, pause() { this.paused = true; }, play() { return Promise.reject(new Error('Playback unavailable')); }, load() {}, getBoundingClientRect: () => ({ left: 0, width: 300 }) }); return elements.get(id); };
  const context = vm.createContext({ state, $, bindPressRepeat, replayHoldButtons: [], Math, Number, Date, URL, URLSearchParams, navigator: { userAgent: 'iPhone Safari/' }, appPath: x => x, dateStart: () => 0, wallTime: ms => '1970-01-01 ' + new Date(ms).toISOString().slice(11, 19), updateCursor() {}, updateSelection() {}, renderTimeline() {}, syncReplayToggle() {}, setPlaybackNotice() {}, notify: (...args) => notices.push(args), handlePlaybackError() {} });
  for (const [start, end] of [
    ['function stopHlsPreview(', 'function syncReplayToggle('],
    ['function segmentBounds(', 'function renderOverview('],
    ['function setTimelineWindow(', 'function renderTimeline('],
    ['function selectTime(', 'function handlePlaybackError('],
    ['function jumpToTimelineTime(', '// Lifecycle interruption'],
    ['function boundaryLabel(', 'function updateBoundaryControls('],
    [script.includes('function syncPlaybackCursor(') ? 'function syncPlaybackCursor(' : 'function markPlaybackBoundary(', "document.addEventListener('keydown'"],
    ["$('replay-player').addEventListener('play',", "$('replay-player').addEventListener('pause',"],
  ]) vm.runInContext(script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start))), context);
  return { state, context, $, video: $('replay-player'), notices, mark: boundary => context.markPlaybackBoundary(boundary), timeupdate: () => $('replay-player').listeners.timeupdate() };
}
function playing(h, seconds) {
  Object.assign(h.video, { currentSrc: h.video.src, currentTime: seconds, duration: 600, readyState: 4, paused: false });
  h.video.listeners.playing?.();
}
test('unready or failed media cannot override the explicitly selected boundary', () => {
  const h = harness(); h.video.currentTime = 30; h.video.duration = 600;
  h.mark('in'); assert.equal(h.state.inMs, 5226000);
  h.state.cursorMs = 5286000; h.video.error = { code: 3 };
  h.timeupdate(); h.mark('out'); assert.equal(h.state.outMs, 5286000);
});
test('jumping to a later time can mark an end while playback stays unavailable', async () => {
  const h = harness(); h.mark('in');
  await h.context.jumpToTimelineTime(5286000);
  h.timeupdate(); h.mark('out');
  assert.equal(h.state.inMs, 5226000); assert.equal(h.state.outMs, 5286000);
});
test('new selection invalidates the previous playing clock until the new source plays', async () => {
  const h = harness(); playing(h, 20); h.timeupdate();
  await h.context.jumpToTimelineTime(5286000);
  // Pending load: metadata/clock events from the previous source must be ignored.
  h.video.currentTime = 20; h.video.duration = 600;
  h.timeupdate(); h.mark('out'); assert.equal(h.state.outMs, 5286000);
  playing(h, 3); h.timeupdate(); assert.equal(h.state.cursorMs, 5289000);
  h.mark('out'); assert.equal(h.state.outMs, 5289000);
});
test('playing and paused frames share the same clock with the boundary buttons', () => {
  const h = harness(); playing(h, 2); h.timeupdate(); assert.equal(h.state.cursorMs, 5228000);
  h.video.currentTime = 4; h.mark('in'); assert.equal(h.state.inMs, 5230000);
  h.video.paused = true; h.video.currentTime = 9; h.timeupdate(); h.mark('out'); assert.equal(h.state.outMs, 5235000);
});
test('dragging, seeking and decoder errors cannot move the chosen cursor', () => {
  for (const mode of ['dragging', 'seeking', 'error']) {
    const h = harness(); playing(h, 2); h.timeupdate();
    h.state.cursorMs = 5400000;
    if (mode === 'dragging') h.state.dragging = true;
    else h.video[mode] = mode === 'error' ? { code: 3 } : true;
    h.timeupdate(); h.mark('out'); assert.equal(h.state.outMs, 5400000, mode);
  }
});
test('equal or reversed endpoints reject without silently erasing the existing range', () => {
  const h = harness(); h.mark('in'); h.mark('out'); assert.equal(h.state.outMs, null);
  h.state.cursorMs -= 1000; h.mark('out'); assert.equal(h.state.outMs, null);
  h.state.cursorMs += 11000; h.mark('out'); assert.equal(h.state.outMs, 5236000);
  h.state.cursorMs += 1000; h.mark('in'); assert.equal(h.state.inMs, 5226000); assert.equal(h.state.outMs, 5236000);
});
test('old-source playing and time updates cannot arm the new source clock', async () => {
  const h = harness(); playing(h, 20); await h.context.jumpToTimelineTime(5286000);
  h.video.paused = false; h.video.listeners.playing(); h.timeupdate(); h.mark('out');
  assert.equal(h.state.followPlayback, false); assert.equal(h.state.outMs, 5286000);
});
test('the media clock cannot mark past the stream or selected day', () => {
  const h = harness(); h.state.playBounds = { start: 86390000, duration: 30 };
  playing(h, 45); h.mark('out'); assert.equal(h.state.outMs, 86400000);
  h.state.playBounds = { start: 5226000, duration: 30 }; h.mark('in'); assert.equal(h.state.inMs, 5256000);
});

test('natural playback moves the ruler under its centre; unready and dragged clocks cannot move it', () => {
  const h = harness(); h.state.timelineStartMs = 0; h.state.playBounds = { start: 3590000, duration: 600 };
  let renders = 0; h.context.renderTimeline = () => renders++;
  playing(h, 0); h.timeupdate(); assert.equal(h.state.timelineStartMs, 1790000);
  playing(h, 2); h.timeupdate(); assert.equal(h.state.timelineStartMs + 1800000, h.state.cursorMs);
  for (let time = 3; time <= 10; time++) { playing(h, time); h.timeupdate(); assert.equal(h.state.timelineStartMs + 1800000, h.state.cursorMs); }
  const moved = h.state.timelineStartMs;
  h.state.dragging = true; playing(h, 590); h.timeupdate(); assert.equal(h.state.timelineStartMs, moved);
  h.state.dragging = false; h.state.pendingScrub = { pointerId: 1 }; h.timeupdate(); assert.equal(h.state.timelineStartMs, moved);
  h.state.pendingScrub = null; h.video.readyState = 0; h.timeupdate(); assert.equal(h.state.timelineStartMs, moved);
});
test('marking an offscreen paused point makes the new marker visible without changing the selected time', () => {
  const h = harness(); h.state.timelineStartMs = 0; h.state.cursorMs = 8 * 3600000; h.state.followPlayback = false;
  h.video.paused = true; h.mark('in');
  const view = h.context.timelineWindow(); assert.equal(h.state.inMs, 8 * 3600000);
  assert.ok(h.state.inMs >= view.start && h.state.inMs <= view.end); assert.equal(view.span, 3600000);
});
