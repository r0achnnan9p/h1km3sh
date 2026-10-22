import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { setButtonIcon } from '../public/ui-primitives.js';
import { statusDashboardPage } from '../lib/status-dashboard.js';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function harness({ source = 'mediamtx', safari = true } = {}) {
  const notices = [], pending = [], elements = new Map(), timers = new Map(); let timerId = 0;
  const state = { date: '2026-09-30', cursorMs: 0, playRequestId: 0, playBounds: null, followPlayback: false, playbackSource: source, selectedCamera: 'D1', segments: [{ start: '2026-09-30T12:00:00Z', duration: 90 }] };
  const start = Date.parse(state.segments[0].start);
  const video = { src: '', currentSrc: '', currentTime: 0, readyState: 0, paused: true, ended: false, hidden: true, error: null, setAttribute() {}, removeAttribute(key) { if (key === 'src') this.src = ''; }, pause() { this.paused = true; }, load() { this.ended = false; this.readyState = 0; this.currentTime = 0; }, play() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); } };
  const $ = id => { if (id === 'replay-player') return video; if (!elements.has(id)) elements.set(id, { value: id === 'dvr-channel' ? '201' : 'dvr-id', hidden: true, attributes: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; } }); return elements.get(id); };
  const context = vm.createContext({ state, $, setButtonIcon, syncPlaybackStatus() {}, cancelReplayHold() {}, interruptTimelineScrub() {}, timelineLimit: () => start + 86400000, replayHoldButtons: [], AbortController, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); }, hasPlaybackSelection: () => true, navigator: { userAgent: safari ? 'iPhone Safari/' : 'Chrome/' }, Date, Math, Number, URL, URLSearchParams, location: { href: 'http://test/' }, appPath: x => x, wallTime: String,
    segmentBounds: item => ({ start: Date.parse(item.start), end: Date.parse(item.start) + item.duration * 1000 }), updateCursor() {}, syncReplayToggle() {}, setPlaybackNotice: (...value) => notices.push(value) });
  for (const [begin, end] of [['function clearReplay(', 'function syncReplayToggle('], ['function syncReplayMute(', 'function selectTime('], ['function selectTime(', 'function setPlaybackNotice(']]) vm.runInContext(script.slice(script.indexOf(begin), script.indexOf(end)), context);
  function readyHls(time = 0) { Object.assign(video, { currentSrc: video.src, currentTime: time, readyState: 4, seeking: false, seekable: { length: 1, start: () => 0, end: () => 30 } }); context.finishHlsStart(); }
  function ended(duration = 30) { if (state.pendingHlsStart) readyHls(); Object.assign(video, { currentSrc: video.src, currentTime: duration, duration, ended: true, hidden: false }); state.followPlayback = true; context.continueReplay(); }
  return { context, state, video, notices, pending, start, ended, readyHls, timers, $ };
}
test('Safari standard MP4 preparations are bounded and continue entire requested segment', async () => {
  const h = harness(); await h.context.playAt(h.start);
  assert.equal(new URL(h.video.src, 'http://test').searchParams.get('duration'), '30.000');
  assert.equal(h.state.playBounds.end, h.start + 90_000);
  h.ended(); assert.equal(h.state.playBounds.start, h.start + 30_000); assert.equal(h.state.playBounds.duration, 30);
  h.ended(); assert.equal(h.state.playBounds.start, h.start + 60_000);
  const id = h.state.playRequestId; h.ended(); assert.equal(h.state.playRequestId, id);
});
test('shorter clip never skips its unplayed tail and short remainder stays bounded', async () => {
  const h = harness(); await h.context.playAt(h.start + 58_000); h.ended(28);
  assert.equal(h.state.playBounds.start, h.start + 86_000); assert.equal(h.state.playBounds.duration, 4);
});
test('fMP4 fallback continues capped chunks; desktop and DVR existing streaming spans remain unchanged', async () => {
  const h = harness(); await h.context.playAt(h.start);
  h.video.currentSrc = h.video.src; h.context.handlePlaybackError();
  assert.equal(h.state.playFormat, 'fmp4'); assert.equal(h.state.playBounds.duration, 30);
  h.ended(); assert.equal(h.state.playBounds.start, h.start + 30_000);
  for (const options of [{ safari: false }, { source: 'dvr', safari: false }]) {
    const f = harness(options); await f.context.playAt(f.start); assert.equal(f.state.playFormat, 'fmp4'); assert.equal(f.state.playBounds.duration, 90);
    const id = f.state.playRequestId; f.ended(90); assert.equal(f.state.playRequestId, id);
  }
});
test('stale ended/error after rapid seek, channel clear or stopped playback cannot load next chunk', async () => {
  const h = harness(); await h.context.playAt(h.start); const old = h.video.src;
  await h.context.playAt(h.start + 10_000); const id = h.state.playRequestId;
  Object.assign(h.video, { ended: true, currentSrc: old, duration: 30 }); h.state.followPlayback = true;
  h.context.continueReplay(); h.context.handlePlaybackError(); assert.equal(h.state.playRequestId, id); assert.equal(h.state.playFormat, 'mp4');
  h.context.clearReplay(); const cleared = h.state.playRequestId; h.context.continueReplay(); assert.equal(h.state.playRequestId, cleared); assert.equal(h.state.playBounds, null);
});
test('late play promise from old seek or previous format cannot overwrite current notice', async () => {
  const h = harness(); await h.context.playAt(h.start); await h.context.playAt(h.start + 10_000);
  h.pending[0].resolve(); await Promise.resolve(); assert.equal(h.notices.length, 0);
  h.video.currentSrc = h.video.src; h.context.handlePlaybackError(); const n = h.notices.length;
  h.pending[1].resolve(); await Promise.resolve(); assert.equal(h.notices.length, n);
});

test('queued ended while dragging cannot restart playback or overwrite the chosen cursor', async () => {
  const h = harness(); await h.context.playAt(h.start); h.state.dragging = true; h.state.cursorMs = h.start + 15_000;
  const id = h.state.playRequestId; h.ended(); assert.equal(h.state.playRequestId, id); assert.equal(h.state.cursorMs, h.start + 15_000);
});


test('replay starts muted with an accessible sound button, including DVR', async () => {
  const html = statusDashboardPage();
  assert.match(html, /<video id="replay-player" muted playsinline/);
  assert.match(html, /<button[^>]+id="playback-mute"[^>]+aria-label="开启声音"[^>]+aria-pressed="false"[^>]*><svg[\s\S]*?<\/svg><\/button>/);
  assert.match(script, /addEventListener\('volumechange', syncReplayMute\)/);
  for (const source of ['mediamtx', 'dvr']) {
    const h = harness({ source }); h.context.clearReplay(); await h.context.playAt(h.start); h.context.syncReplayMute();
    const button = h.$('playback-mute');
    assert.equal(h.video.muted, true); assert.equal(button.hidden, false); assert.equal(button.attributes['aria-label'], '开启声音');
    h.context.toggleReplayMute(); assert.equal(h.video.muted, false); assert.equal(button.attributes['aria-label'], '静音'); assert.equal(button.attributes['aria-pressed'], 'true');
    h.context.toggleReplayMute(); assert.equal(h.video.muted, true); assert.equal(button.attributes['aria-pressed'], 'false');
    h.context.clearReplay(); h.context.syncReplayMute(); assert.equal(button.hidden, true);
  }
});
test('explicit replay unmute survives seeking, format fallback and chunk continuation; a new source resets it', async () => {
  const h = harness(); h.context.clearReplay(); await h.context.playAt(h.start); h.context.toggleReplayMute();
  await h.context.playAt(h.start + 10_000); assert.equal(h.video.muted, false);
  h.video.currentSrc = h.video.src; h.context.handlePlaybackError(); assert.equal(h.video.muted, false);
  h.ended(); assert.equal(h.video.muted, false); assert.equal(h.state.playBounds.start, h.start + 40_000);
  h.context.clearReplay(); h.state.selectedCamera = 'D2'; await h.context.playAt(h.start); assert.equal(h.video.muted, true);
});

test('paused precision seeks never request autoplay, including format fallback and stale ended events', async () => {
  const h = harness(); await h.context.playAt(h.start + 10_000, { autoplay: false });
  assert.equal(h.pending.length, 0); assert.equal(h.video.paused, true); assert.equal(h.state.cursorMs, h.start + 10_000);
  h.video.currentSrc = h.video.src; h.context.handlePlaybackError(); assert.equal(h.state.playFormat, 'fmp4'); assert.equal(h.pending.length, 0);
  const id = h.state.playRequestId; h.ended(); assert.equal(h.state.playRequestId, id); assert.equal(h.pending.length, 0);
});
test('ten-second precision steps preserve paused intent and sample the current playback cursor', () => {
  const h = harness(); h.video.hidden = false; h.video.paused = true; h.state.cursorMs = h.start;
  const calls = []; Object.assign(h.context, { dateStart: () => h.start, clampTimelineCenter: ms => Math.max(h.start, Math.min(h.start + 86399999, ms)), renderTimeline() {}, syncPlaybackCursor() { h.state.cursorMs = h.start + 9000; }, showScrubTime() {}, fadeScrubTime() {}, jumpToTimelineTime: (time, source, options) => calls.push({ time, source, autoplay: options.autoplay }) });
  vm.runInContext(script.slice(script.indexOf('function stepReplay('), script.indexOf('// Lifecycle interruption')), h.context);
  h.context.stepReplay(10); assert.deepEqual(calls[0], { time: h.start + 19000, source: 'detail', autoplay: false });
  h.video.paused = false; h.context.stepReplay(-10); assert.equal(calls[1].autoplay, true);
  h.video.paused = true; h.state.playbackAutoplay = true; h.state.followPlayback = false; h.context.stepReplay(10); assert.equal(calls[2].autoplay, true);
});

async function bufferedHarness({ paused = false } = {}) {
  const h = harness(); let loads = 0;
  const load = h.video.load; h.video.load = () => { loads++; load.call(h.video); };
  Object.assign(h.context, { dateStart: () => h.start, clampTimelineCenter: ms => Math.max(h.start, Math.min(h.start + 86399999, ms)), renderTimeline() {}, timelineLimit: () => h.start + 86400000,
    timelineWindow: () => ({ start: h.start, end: h.start + 3600000, span: 3600000 }), setTimelineWindow() {}, renderTimeline() {}, showScrubTime() {}, fadeScrubTime() {},
    jumpToTimelineTime: (time, source, options) => h.context.playAt(time, options) });
  vm.runInContext(script.slice(script.indexOf('function stepReplay('), script.indexOf('// Lifecycle interruption')), h.context);
  vm.runInContext(script.slice(script.indexOf('function syncPlaybackCursor('), script.indexOf('function markPlaybackBoundary(')), h.context);
  await h.context.playAt(h.start, { autoplay: !paused });
  const ranges = { length: 1, start: () => 0, end: () => 30 };
  Object.assign(h.video, { currentSrc: h.video.src, readyState: 4, paused, duration: 30, currentTime: 2, buffered: ranges, seekable: ranges, seeking: false });
  h.state.followPlayback = true; h.state.cursorMs = h.start + 2000;
  return { ...h, loads: () => loads };
}
test('buffered 10-second steps reuse the source and hold the requested clock until seeked', async () => {
  const h = await bufferedHarness(), src = h.video.src, request = h.state.playRequestId;
  h.context.stepReplay(10); assert.equal(h.video.currentTime, 12); assert.equal(h.state.cursorMs, h.start + 12000);
  assert.equal(h.video.src, src); assert.equal(h.state.playRequestId, request); assert.equal(h.loads(), 1);
  h.video.seeking = true; h.video.currentTime = 2; h.context.syncPlaybackCursor();
  assert.equal(h.state.cursorMs, h.start + 12000, 'late pre-seek timeupdate cannot rewind the target');
  h.context.stepReplay(10); assert.equal(h.video.currentTime, 22); assert.equal(h.state.cursorMs, h.start + 22000);
  h.context.finishBufferedReplaySeek(); assert.ok(h.state.pendingLocalSeek, 'an old seeked while the current seek is unsettled is ignored');
  h.video.seeking = false; h.context.finishBufferedReplaySeek();
  assert.equal(h.state.pendingLocalSeek, null); assert.equal(h.state.followPlayback, true); assert.equal(h.video.paused, false); assert.equal(h.loads(), 1);
});
test('paused buffered steps stay paused, accurate and do not issue new play requests', async () => {
  const h = await bufferedHarness({ paused: true }); const requests = h.pending.length;
  h.context.stepReplay(10); assert.equal(h.video.currentTime, 12); assert.equal(h.video.paused, true); assert.equal(h.state.playbackAutoplay, false);
  h.context.finishBufferedReplaySeek(); h.context.stepReplay(-10); h.context.finishBufferedReplaySeek();
  assert.equal(h.state.cursorMs, h.start + 2000); assert.equal(h.video.currentTime, 2); assert.equal(h.pending.length, requests); assert.equal(h.loads(), 1);
});
test('cross-chunk steps retain source generation guards against late seeked and play responses', async () => {
  const h = await bufferedHarness(), oldSrc = h.video.src, oldPlay = h.pending[0];
  h.context.stepReplay(10); h.context.stepReplay(10); h.context.stepReplay(10);
  assert.equal(h.state.playBounds.start, h.start + 32000); assert.equal(h.loads(), 2); assert.equal(h.state.pendingLocalSeek, null);
  const notices = h.notices.length, nextSrc = h.video.src, nextRequest = h.state.playRequestId;
  h.video.currentSrc = oldSrc; h.video.currentTime = 22; h.context.finishBufferedReplaySeek();
  oldPlay.reject(new Error('late old source')); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.state.cursorMs, h.start + 32000); assert.equal(h.video.src, nextSrc); assert.equal(h.state.playRequestId, nextRequest); assert.equal(h.notices.length, notices);
});
test('buffer gaps, changed camera/date, DVR and unloaded sources never use the local seek path', async () => {
  for (const mutate of [h => { h.video.buffered = { length: 0 }; }, h => { h.video.seekable = { length: 0 }; }, h => { h.state.selectedCamera = 'D2'; }, h => { h.state.date = '2026-10-01'; }, h => { h.state.playbackSource = 'dvr'; }, h => { h.video.currentSrc = 'old-source'; }, h => { h.video.readyState = 0; }]) {
    const h = await bufferedHarness(); mutate(h); const before = h.video.currentTime;
    assert.equal(h.context.tryBufferedReplaySeek(h.start + 12000, true), false); assert.equal(h.video.currentTime, before);
  }
});
test('an unchanged buffered seek needs no seeked event, while an imprecise seek falls back', async () => {
  const h = await bufferedHarness(); assert.equal(h.context.tryBufferedReplaySeek(h.start + 2000, true), true); assert.ok(!h.state.pendingLocalSeek);
  h.context.stepReplay(10); h.video.currentTime = 7; h.context.finishBufferedReplaySeek();
  assert.equal(h.state.playBounds.start, h.start + 12000); assert.equal(h.loads(), 2); assert.equal(h.state.pendingLocalSeek, null);
});

test('a user pause during local seek is preserved if the browser needs a source fallback', async () => {
  const h = await bufferedHarness(); h.context.stepReplay(10);
  h.video.pause(); h.state.playbackAutoplay = false; h.video.currentTime = 7;
  const plays = h.pending.length; h.context.finishBufferedReplaySeek();
  assert.equal(h.state.playBounds.start, h.start + 12000); assert.equal(h.state.playbackAutoplay, false);
  assert.equal(h.video.paused, true); assert.equal(h.pending.length, plays);
});

test('desktop DVR first tries original-codec fMP4, then compatible H264 with the same track and full duration', async () => {
  const h = harness({ source: 'dvr', safari: false }); await h.context.playAt(h.start);
  const native = new URL(h.video.src, 'http://test');
  assert.equal(native.searchParams.get('format'), 'fmp4'); assert.equal(native.searchParams.get('channel'), '201'); assert.equal(native.searchParams.get('duration'), '90.000');
  const old = h.video.src; h.video.currentSrc = old; h.context.handlePlaybackError();
  const compatible = new URL(h.video.src, 'http://test');
  assert.equal(compatible.searchParams.get('format'), 'compat'); assert.equal(compatible.searchParams.get('channel'), '201'); assert.equal(compatible.searchParams.get('start'), native.searchParams.get('start')); assert.equal(compatible.searchParams.get('duration'), '90.000');
  assert.ok(h.notices.some(item => item[0] === '正在切换兼容预览…'));
  const request = h.state.playRequestId, current = h.video.src;
  h.context.handlePlaybackError(); assert.equal(h.state.playRequestId, request); assert.equal(h.video.src, current, 'stale native-format error cannot mutate compatibility playback');
  h.video.currentSrc = current; h.context.handlePlaybackError();
  assert.match(h.notices.at(-1)[0], /读取或解码 DVR/); assert.doesNotMatch(h.notices.at(-1)[0], /浏览器/);
});
test('DVR compatibility fallback preserves paused intent and never requests autoplay', async () => {
  const h = harness({ source: 'dvr', safari: false }); await h.context.playAt(h.start, { autoplay: false });
  h.video.currentSrc = h.video.src; h.context.handlePlaybackError();
  assert.equal(h.state.playFormat, 'compat'); assert.equal(h.pending.length, 0); assert.equal(h.video.paused, true); assert.equal(h.state.playBounds.duration, 90);
});

test('iPhone DVR history and live both select native HLS without completed MP4 preparation', async () => {
  const h = harness({ source: 'dvr' }); h.state.segments[0].duration = 900;
  await h.context.playAt(h.start);
  const first = new URL(h.video.src, 'http://test');
  assert.equal(first.searchParams.get('format'), 'hls'); assert.equal(first.searchParams.get('duration'), '120.000');
  assert.equal(first.searchParams.get('channel'), '201'); assert.ok(first.searchParams.get('client')); assert.equal(first.searchParams.get('generation'), '1');
  assert.equal(h.state.playBounds.end, h.start + 900_000);
  h.ended(120); assert.equal(h.state.playBounds.start, h.start + 120_000); assert.equal(h.state.playBounds.duration, 120);
  for (let group = 2; group <= 7; group++) { h.ended(120); assert.equal(h.state.playBounds.start, h.start + group * 120_000); }
  assert.equal(h.state.playBounds.duration, 60); const completedRequest = h.state.playRequestId;
  h.ended(60); assert.equal(h.state.playRequestId, completedRequest);
  const next = new URL(h.video.src, 'http://test'); assert.ok(Number(next.searchParams.get('generation')) > Number(first.searchParams.get('generation')));
  h.context.startDvrLive(); assert.equal(new URL(h.video.src, 'http://test').searchParams.get('format'), 'hls');
});

test('HLS fallback and clear send bounded stop requests; stale errors cannot replace newer playback', async () => {
  const h = harness({ source: 'dvr' }), stopped = [];
  h.context.fetch = (url, options) => { stopped.push({ url, options, payload: JSON.parse(options.body) }); return Promise.resolve(); };
  await h.context.playAt(h.start, { autoplay: false });
  const old = h.video.src; h.video.currentSrc = old; h.context.handlePlaybackError();
  assert.equal(h.state.playFormat, 'fmp4'); assert.equal(h.pending.length, 0); assert.equal(h.video.paused, true);
  assert.equal(stopped.length, 1); assert.equal(stopped[0].url, '/console/api/dvr-preview/stop'); assert.equal(stopped[0].options.keepalive, true);
  assert.ok(stopped[0].payload.generation < Number(new URL(h.video.src, 'http://test').searchParams.get('generation')));
  const current = h.video.src; h.context.handlePlaybackError(); assert.equal(h.video.src, current);
  await h.context.playAt(h.start + 10_000); h.context.clearReplay();
  assert.equal(stopped.length, 2); assert.equal(h.video.hidden, true); assert.equal(h.state.playBounds, null);
  let pagehide, stops = 0, clears = 0, cancels = 0;
  const lifecycle = { state: {}, window: { addEventListener(name, fn) { assert.equal(name, 'pagehide'); pagehide = fn; } }, cancelReplayHold() { cancels++; }, stopHlsPreview() { stops++; }, clearReplay() { clears++; } };
  vm.runInNewContext(script.split('\n').find(line => line.startsWith("window.addEventListener('pagehide'")), lifecycle);
  pagehide(); assert.equal(stops, 1, 'DVR stop remains bound to pagehide'); assert.equal(cancels, 1, 'pagehide cancels a pending replay gesture');
  lifecycle.state.mediaLive = {}; pagehide(); assert.equal(clears, 1, 'WebRTC closes and returns to a reconnectable replay state'); assert.equal(cancels, 2, 'live pagehide also cancels a pending gesture');
});

test('pausing HLS beyond the idle limit preserves the picture and exact cursor, then reopens historical playback', async () => {
  const h = harness({ source: 'dvr' }), stopped = []; let now = h.start;
  h.context.Date = class extends Date { static now() { return now; } };
  h.context.fetch = (_url, options) => { stopped.push(JSON.parse(options.body)); return Promise.resolve(); };
  Object.assign(h.context, { dateStart: () => h.start, clampTimelineCenter: ms => Math.max(h.start, Math.min(h.start + 86399999, ms)), renderTimeline() {}, timelineWindow: () => ({ start: h.start, end: h.start + 3600000, span: 3600000 }), updateCursor() {} });
  vm.runInContext(script.slice(script.indexOf('function syncPlaybackCursor('), script.indexOf('function markPlaybackBoundary(')), h.context);
  vm.runInContext(script.slice(script.indexOf('async function toggleReplayPlayback('), script.indexOf('function updateTimelineHover(')), h.context);
  await h.context.playAt(h.start);
  const source = h.video.src; h.readyHls();
  Object.assign(h.video, { currentSrc: source, currentTime: 7.25, readyState: 4, paused: false }); h.state.followPlayback = true;
  await h.context.toggleReplayPlayback();
  assert.equal(h.state.cursorMs, h.start + 7250); assert.equal(h.video.src, source); assert.equal(h.video.hidden, false); assert.equal(h.video.paused, true);
  assert.equal(h.state.hlsStopped, true); assert.equal(stopped.length, 1);
  now += 30000; h.video.currentTime = 37.25; h.context.syncPlaybackCursor(); h.context.handlePlaybackError();
  assert.equal(h.state.cursorMs, h.start + 7250, 'stopped-session or delayed media events cannot move the saved pause point');
  await h.context.toggleReplayPlayback();
  const reopened = new URL(h.video.src, 'http://test');
  assert.equal(Date.parse(reopened.searchParams.get('start')), h.start + 7250); assert.equal(reopened.searchParams.get('format'), 'hls');
  assert.equal(h.state.hlsStopped, false); assert.ok(Number(reopened.searchParams.get('generation')) > stopped[0].generation);
});

test('a paused HLS precision seek stops preparation once its frame is loaded and ignores stale loadeddata', async () => {
  const h = harness({ source: 'dvr' }), stopped = [];
  h.context.fetch = (_url, options) => { stopped.push(JSON.parse(options.body)); return Promise.resolve(); };
  await h.context.playAt(h.start + 10000, { autoplay: false });
  Object.assign(h.video, { readyState: 4, currentSrc: 'old-source', paused: true }); h.context.stopPausedHlsPreview();
  assert.equal(stopped.length, 0);
  h.video.currentSrc = h.video.src; h.context.finishHlsStart(); h.context.stopPausedHlsPreview();
  assert.equal(stopped.length, 1); assert.equal(h.state.hlsStopped, true); assert.equal(h.state.cursorMs, h.start + 10000);
  assert.equal(h.video.hidden, false); assert.equal(h.pending.length, 0);
});

test('DVR live keeps recording cursor/marks separate, with two formats and a main-track replay transition', async () => {
  const h = harness({ source: 'dvr', safari: false }); h.state.cursorMs = h.start + 5000; h.state.inMs = h.start; h.state.outMs = h.start + 20000;
  h.context.startDvrLive(); const live = h.video.src, liveRequest = h.state.playRequestId;
  assert.equal(h.state.previewMode, 'live'); assert.match(live, /\/live\?channel=201&format=fmp4/); assert.equal(h.state.cursorMs, h.start + 5000);
  Object.assign(h.context, { dateStart: () => h.start, clampTimelineCenter: ms => Math.max(h.start, Math.min(h.start + 86399999, ms)), renderTimeline() {}, timelineWindow: () => ({ start: h.start, end: h.start + 3600000, span: 3600000 }), updateSelection() {}, boundaryLabel: String, notify() {} });
  vm.runInContext(script.slice(script.indexOf('function syncPlaybackCursor('), script.indexOf("$('mark-in').addEventListener")), h.context);
  Object.assign(h.video, { currentSrc: live, currentTime: 420, readyState: 4, paused: false }); h.state.followPlayback = true;
  h.context.syncPlaybackCursor(); h.context.markPlaybackBoundary('in'); h.context.markPlaybackBoundary('out');
  assert.equal(h.state.cursorMs, h.start + 5000); assert.equal(h.state.inMs, h.start); assert.equal(h.state.outMs, h.start + 20000);
  h.context.handlePlaybackError(); assert.match(h.video.src, /\/live\?channel=201&format=compat/); assert.equal(h.state.playRequestId, liveRequest);
  await h.context.playAt(h.start + 10000); assert.equal(h.state.previewMode, 'replay'); assert.match(h.video.src, /\/stream\?channel=201/); assert.match(h.video.src, /format=fmp4/);
  const replay = h.video.src; h.video.currentSrc = live; h.context.handlePlaybackError(); assert.equal(h.video.src, replay);
});
test('live completion never advances a recording chunk and can be explicitly restarted', () => {
  const h = harness({ source: 'dvr' }); h.context.startDvrLive(); const request = h.state.playRequestId;
  Object.assign(h.video, { currentSrc: h.video.src, ended: true, currentTime: 600, duration: 600 }); h.context.continueReplay();
  assert.equal(h.state.playRequestId, request); assert.equal(h.state.playbackAutoplay, false); assert.match(h.notices.at(-1)[0], /点“回到直播”重连/);
  h.context.startDvrLive(); assert.ok(h.state.playRequestId > request); assert.equal(h.state.previewMode, 'live');
});
test('ten-second shortcuts do nothing in live mode; delayed live play promise cannot overwrite replay', async () => {
  const h = harness({ source: 'dvr' }); h.context.startDvrLive(); h.readyHls(6); const pending = h.pending[0];
  Object.assign(h.context, { syncPlaybackCursor: () => assert.fail('live must not sample recording clock') });
  vm.runInContext(script.slice(script.indexOf('function stepReplay('), script.indexOf('// Lifecycle interruption')), h.context);
  const request = h.state.playRequestId; h.context.stepReplay(10); assert.equal(h.state.playRequestId, request);
  await h.context.playAt(h.start); const noticeCount = h.notices.length; pending.resolve(); await Promise.resolve();
  assert.equal(h.state.previewMode, 'replay'); assert.equal(h.notices.length, noticeCount);
});

test('HLS requests frame preloading but gates play, cursor and continuation until its zero-origin frame is loaded', async () => {
  const h = harness({ source: 'dvr' }); await h.context.playAt(h.start);
  assert.equal(h.video.preload, 'auto'); assert.equal(h.pending.length, 0); assert.ok(h.state.pendingHlsStart);
  Object.assign(h.video, { currentSrc: h.video.src, readyState: 1, currentTime: 0 }); h.context.finishHlsStart();
  assert.equal(h.pending.length, 0, 'metadata is not a decoded historical frame');
  Object.assign(h.context, { dateStart: () => h.start, clampTimelineCenter: ms => Math.max(h.start, Math.min(h.start + 86399999, ms)), renderTimeline() {}, timelineWindow: () => ({ start: h.start, end: h.start + 3600000, span: 3600000 }), updateCursor() {} });
  vm.runInContext(script.slice(script.indexOf('function syncPlaybackCursor('), script.indexOf('function markPlaybackBoundary(')), h.context);
  Object.assign(h.video, { readyState: 4, currentTime: 8, ended: true }); h.state.followPlayback = true;
  h.context.syncPlaybackCursor(); const request = h.state.playRequestId; h.context.continueReplay();
  assert.equal(h.state.cursorMs, h.start); assert.equal(h.state.playRequestId, request);
  h.readyHls(); assert.equal(h.state.pendingHlsStart, null); assert.equal(h.pending.length, 1); assert.equal(h.timers.size, 0);
  h.context.finishHlsStart(); assert.equal(h.pending.length, 1, 'later readiness events never restart a settled source');
});

test('native HLS initially choosing a later frame gets exactly one precise zero seek before playback', async () => {
  const h = harness({ source: 'dvr' }); await h.context.playAt(h.start);
  let time = 8, assignments = 0;
  Object.defineProperty(h.video, 'currentTime', { configurable: true, get: () => time, set(value) { assignments++; time = value; h.video.seeking = true; } });
  Object.assign(h.video, { currentSrc: h.video.src, readyState: 4, seekable: { length: 1, start: () => 0, end: () => 12 } });
  h.context.finishHlsStart(); assert.equal(assignments, 1); assert.equal(time, 0); assert.equal(h.pending.length, 0);
  h.context.finishHlsStart(); assert.equal(assignments, 1); assert.equal(h.pending.length, 0);
  h.video.seeking = false; h.context.finishHlsStart(); assert.equal(h.pending.length, 1); assert.equal(h.state.pendingHlsStart, null);
  time = 10; h.context.finishHlsStart(); assert.equal(assignments, 1, 'ordinary playback never jumps back');
});

test('paused HLS never freezes a wrong initial frame, and pause intent survives origin correction', async () => {
  for (const autoplay of [false, true]) {
    const h = harness({ source: 'dvr' }), stopped = []; h.context.fetch = (_url, options) => { stopped.push(JSON.parse(options.body)); return Promise.resolve(); };
    await h.context.playAt(h.start + 10000, { autoplay });
    let time = 8;
    Object.defineProperty(h.video, 'currentTime', { configurable: true, get: () => time, set(value) { time = value; h.video.seeking = true; } });
    Object.assign(h.video, { currentSrc: h.video.src, readyState: 4, seekable: { length: 1, start: () => 0, end: () => 12 } });
    h.context.stopPausedHlsPreview(); assert.equal(stopped.length, 0);
    h.context.finishHlsStart(); assert.equal(stopped.length, 0); assert.equal(h.pending.length, 0);
    h.state.playbackAutoplay = false; h.video.seeking = false; h.context.finishHlsStart();
    assert.equal(stopped.length, 1); assert.equal(time, 0); assert.equal(h.pending.length, 0); assert.equal(h.state.cursorMs, h.start + 10000); assert.equal(h.state.hlsStopped, true);
    h.context.finishHlsStart(); assert.equal(h.pending.length, 0);
  }
});

test('empty HLS seekability waits for origin, while missing origin and failed seeks fall back once', async () => {
  const waiting = harness({ source: 'dvr' }); await waiting.context.playAt(waiting.start);
  Object.assign(waiting.video, { currentSrc: waiting.video.src, readyState: 4, currentTime: 8, seekable: { length: 0 } });
  waiting.context.finishHlsStart(); assert.equal(waiting.state.playFormat, 'hls'); assert.equal(waiting.pending.length, 0);
  waiting.video.seekable = { length: 1, start: () => 0, end: () => 12 }; waiting.context.finishHlsStart();
  assert.equal(waiting.video.currentTime, 0); assert.equal(waiting.state.pendingHlsStart.seekRequested, true);
  waiting.context.finishHlsStart(); assert.equal(waiting.pending.length, 1);
  for (const failure of ['origin-missing', 'throws', 'clamped']) {
    const h = harness({ source: 'dvr' }); await h.context.playAt(h.start, { autoplay: false });
    Object.assign(h.video, { currentSrc: h.video.src, readyState: 4, currentTime: 8, seekable: { length: 1, start: () => failure === 'origin-missing' ? 2 : 0, end: () => 12 } });
    let attempts = 0; h.video.load = () => { h.video.ended = false; h.video.readyState = 0; };
    if (failure !== 'origin-missing') Object.defineProperty(h.video, 'currentTime', { configurable: true, get: () => 8, set() { attempts++; if (failure === 'throws') throw new Error('not seekable'); } });
    h.context.finishHlsStart(); h.context.finishHlsStart();
    assert.equal(h.state.playFormat, 'fmp4', failure); assert.equal(h.state.pendingHlsStart, null); assert.equal(h.pending.length, 0); assert.equal(h.timers.size, 0);
    assert.equal(attempts, failure === 'origin-missing' ? 0 : 1, failure);
  }
});

test('HLS origin watchdog is bounded and stale readiness/timers cannot replace a newer source', async () => {
  for (const next of ['timeout', 'replacement', 'clear', 'stop', 'fallback']) {
    const h = harness({ source: 'dvr' }); await h.context.playAt(h.start);
    const oldSrc = h.video.src, timer = [...h.timers.values()][0]; assert.equal(timer.ms, 20000);
    if (next === 'replacement') await h.context.playAt(h.start + 10000);
    if (next === 'clear') h.context.clearReplay();
    if (next === 'stop') h.context.stopHlsPreview();
    if (next === 'fallback') { h.video.currentSrc = oldSrc; h.context.handlePlaybackError(); }
    const current = h.video.src, request = h.state.playRequestId;
    timer.fn(); timer.fn();
    if (next === 'timeout') { assert.equal(h.state.playFormat, 'fmp4'); assert.equal(h.state.pendingHlsStart, null); }
    else { assert.equal(h.video.src, current); assert.equal(h.state.playRequestId, request); }
    if (next === 'replacement') {
      Object.assign(h.video, { currentSrc: oldSrc, readyState: 4, currentTime: 0 }); h.context.finishHlsStart();
      assert.ok(h.state.pendingHlsStart); assert.equal(h.pending.length, 0);
    }
  }
});

test('play toggle cannot bypass pending HLS origin and a rejected autoplay remains resumable', async () => {
  const h = harness({ source: 'dvr' });
  vm.runInContext(script.slice(script.indexOf('async function toggleReplayPlayback('), script.indexOf('function updateTimelineHover(')), h.context);
  await h.context.playAt(h.start); await h.context.toggleReplayPlayback(); assert.equal(h.pending.length, 0);
  h.readyHls(); h.pending[0].reject(new Error('user gesture required')); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.state.hlsStopped, false); assert.equal(h.state.playbackAutoplay, false); assert.equal(h.video.hidden, false);
  assert.match(h.notices.at(-1)[0], /点播放键开始/);
  const src = h.video.src, request = h.state.playRequestId, tapped = h.context.toggleReplayPlayback();
  assert.equal(h.pending.length, 2, 'the tap invokes play synchronously on the already verified source');
  assert.equal(h.state.pendingHlsStart, null); h.pending[1].resolve(); await tapped;
  assert.equal(h.video.src, src); assert.equal(h.state.playRequestId, request); assert.equal(h.state.playbackAutoplay, true);
});

test('capped HLS fallback continues the requested recording and honors a short final group', async () => {
  const h = harness({ source: 'dvr' }); h.state.segments[0].duration = 250;
  await h.context.playAt(h.start); h.video.currentSrc = h.video.src; h.context.handlePlaybackError();
  assert.equal(h.state.playFormat, 'fmp4'); assert.equal(h.state.playBounds.duration, 120);
  h.ended(120); assert.equal(h.state.playBounds.start, h.start + 120000); assert.equal(h.state.playBounds.duration, 120);
  h.ended(118); assert.equal(h.state.playBounds.start, h.start + 238000); assert.equal(h.state.playBounds.duration, 12);
  h.ended(12); assert.equal(h.state.playBounds.start, h.start + 238000);
});

const sdkPrepared = id => ({ success: true, mediaUrl: `/console/api/dvr-sdk-preview/${id}/media.mp4`, actualDurationSeconds: 28.2 });
const sdkId = 'b88a6eb6-967c-47bd-b75f-1e61c85d873b';
function sdkHarness() {
  const h = harness({ source: 'dvr' }); h.state.dvrSdkDevices = { 'dvr-id': true };
  const requests = [], stops = [];
  h.context.api = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  h.context.fetch = async (url, options) => { stops.push({ url, options }); return {}; };
  return { ...h, requests, stops };
}
const tickSdk = () => new Promise(resolve => setImmediate(resolve));
test('SDK preview is explicitly bounded and preserves unknown timing without frame marks or auto continuation', async () => {
  const h = sdkHarness(); await h.context.playAt(h.start);
  assert.equal(h.state.playFormat, 'sdk'); assert.equal(h.state.playBounds.duration, 30);
  assert.equal(new URL(h.requests[0].url, 'http://test').searchParams.get('duration'), '30');
  assert.equal(h.$('mark-in').disabled, true); assert.equal(h.$('mark-out').disabled, true);
  assert.match(h.notices.at(-1)[0], /SDK 准备中.*30 秒/);
  h.requests[0].resolve(sdkPrepared(sdkId)); await tickSdk();
  assert.match(h.video.src, /dvr-sdk-preview/); assert.equal(h.state.playBounds.actualDurationSeconds, 28.2);
  h.pending[0].resolve(); await tickSdk(); assert.match(h.notices.at(-1)[0], /导出时间手填/);
  vm.runInContext(script.slice(script.indexOf('function syncPlaybackCursor('), script.indexOf("$('mark-in').addEventListener")), h.context);
  h.state.inMs = null; h.context.markPlaybackBoundary('in'); assert.equal(h.state.inMs, null);
  const cursor = h.state.cursorMs; Object.assign(h.video, { currentTime: 15, readyState: 4, currentSrc: h.video.src }); h.state.followPlayback = true;
  h.context.syncPlaybackCursor(); assert.equal(h.state.cursorMs, cursor);
  h.ended(28.2); assert.equal(h.requests.length, 1); assert.match(h.notices.at(-1)[0], /本段结束/);
});
test('SDK new seek cancels preparation and old responses cannot replace the new clip', async () => {
  const h = sdkHarness(); await h.context.playAt(h.start); const first = h.requests[0];
  await h.context.playAt(h.start + 10000); assert.equal(first.options.signal.aborted, true);
  assert.equal(h.stops.length, 1); assert.match(h.stops[0].url, /dvr-sdk-preview\/stop/);
  h.requests[1].resolve(sdkPrepared(sdkId)); await tickSdk(); const current = h.video.src;
  first.resolve(sdkPrepared('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')); await tickSdk(); assert.equal(h.video.src, current);
  h.context.clearReplay(); assert.equal(h.video.src, ''); assert.equal(h.state.playBounds, null); assert.equal(h.stops.length, 2);
});
test('SDK preparation errors remain explicit and never silently fall back to whole-file HTTP or RTSP', async () => {
  const h = sdkHarness(); await h.context.playAt(h.start, { autoplay: false });
  h.requests[0].reject(new Error('SDK 安装不可用')); await tickSdk();
  assert.match(h.notices.at(-1)[0], /SDK 安装不可用/); assert.equal(h.notices.at(-1)[1], true);
  assert.equal(h.pending.length, 0); assert.equal(h.state.playbackFormats.length, 0);
});


test('iPhone Safari, Edge and Mac Safari use native live HLS, desktop Chrome keeps fMP4', () => {
  for (const ua of ['Mozilla/5.0 (iPhone) Version/18 Safari/604.1', 'Mozilla/5.0 (iPhone) EdgiOS/140 Mobile Safari/605.1', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Version/18 Safari/605.1']) {
    const h = harness({ source: 'dvr' }); h.context.navigator.userAgent = ua;
    h.context.startDvrLive();
    assert.equal(h.state.playFormat, 'hls'); assert.equal(h.state.playBounds.duration, 600);
    assert.equal([...h.timers.values()][0].ms, 75000, 'watchdog includes metadata, serial sub/main preparation and player load');
    assert.equal(new URL(h.video.src, 'http://test').searchParams.get('format'), 'hls');
    h.readyHls(8); assert.equal(h.state.pendingHlsStart, null); assert.equal(h.pending.length, 1);
    assert.equal(h.video.currentTime, 8, 'live must not seek to historical origin zero');
  }
  const desktop = harness({ source: 'dvr', safari: false }); desktop.context.startDvrLive();
  assert.equal(desktop.state.playFormat, 'fmp4');
});

test('paused live HLS resumes as live rather than silently opening historical playback', async () => {
  const h = harness({ source: 'dvr' }); h.context.startDvrLive(); h.readyHls(8);
  vm.runInContext(script.slice(script.indexOf('async function toggleReplayPlayback('), script.indexOf('function updateTimelineHover(')), h.context);
  h.video.paused = false; h.context.syncPlaybackCursor = () => {};
  await h.context.toggleReplayPlayback(); assert.equal(h.state.hlsStopped, true);
  const old = h.state.playRequestId; await h.context.toggleReplayPlayback();
  assert.equal(h.state.previewMode, 'live'); assert.equal(h.state.playFormat, 'hls');
  assert.ok(h.state.playRequestId > old); assert.match(h.video.src, /\/live\?/);
});
