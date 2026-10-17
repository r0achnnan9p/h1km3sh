import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { statusDashboardPage } from '../lib/status-dashboard.js';
import { setButtonIcon, formatClipDuration } from '../public/ui-primitives.js';
import { findCoverageGap } from '../public/playback-coverage.js';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');

function loadFunction(context, name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing UI function: ${name}`);
  const lineEnd = script.indexOf('\n', start), firstLine = script.slice(start, lineEnd);
  const end = firstLine.endsWith('}') ? lineEnd : script.indexOf('\n}', lineEnd) + 2;
  assert.ok(end > start, `Unterminated UI function: ${name}`);
  vm.runInContext(script.slice(start, end), context);
}

class Element {
  hidden = false;
  disabled = false;
  style = {};
  dataset = {};
  attributes = {};
  children = [];
  listeners = new Map();
  title = '';
  classes = new Set();
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    contains: name => this.classes.has(name),
    toggle: (name, force = !this.classes.has(name)) => {
      if (force) this.classes.add(name); else this.classes.delete(name);
      return force;
    },
  };
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  dispatch(name) { for (const listener of this.listeners.get(name) || []) listener({ type: name }); }
  set innerHTML(value) { this.html = String(value); this.text = this.html.replace(/<[^>]*>/g, ''); }
  get innerHTML() { return this.html || ''; }
  set textContent(value) { this.text = String(value); this.html = ''; }
  get textContent() { return this.text || ''; }
}

function harness() {
  const day = Date.UTC(2026, 8, 30), hour = 3_600_000;
  const state = {
    date: '2026-09-30', playbackSource: 'dvr', previewMode: 'replay', busy: false,
    cursorMs: day + 12.25 * hour, inMs: day + 12.1 * hour, outMs: day + 12.4 * hour,
    timelineStartMs: day + 12 * hour, playbackAutoplay: false, followPlayback: false,
    playBounds: null, segments: [{ start: new Date(day + 12 * hour).toISOString(), duration: 3600 }],
  };
  const video = Object.assign(new Element(), {
    hidden: false, paused: true, ended: false, error: null, readyState: 0,
    currentTime: 0, src: 'http://test/live.mp4', currentSrc: '', muted: true,
  });
  const elements = new Map([['replay-player', video]]);
  const $ = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const segment = new Element(); segment.dataset.index = '0';
  const context = vm.createContext({
    state, $, Date, Math, Number, setButtonIcon, formatClipDuration, findCoverageGap,
    hasPlaybackSelection: () => true,
    dateStart: () => day,
    daySeconds: ms => (ms - day) / 1000,
    wallTime: (ms, seconds = true) => `2026-09-30 ${new Date(ms).toISOString().slice(11, seconds ? 19 : 16)}`,
    document: { createElement: () => new Element(), querySelectorAll: () => [segment] },
  });
  for (const name of [
    'segmentBounds', 'timelineWindow', 'timelineLimit', 'clampTimelineCenter', 'timelinePercent',
    'renderOverview', 'updateCursor', 'boundaryLabel', 'updateBoundaryControls', 'updateSelection',
    'syncPlaybackStatus', 'syncReplayToggle', 'syncReplayMute', 'toggleReplayMute',
  ]) loadFunction(context, name);
  context.renderTimeline = () => { context.renderOverview(); context.updateCursor(); context.updateSelection(); };
  const render = () => { context.renderOverview(); context.updateCursor(); context.updateSelection(); };
  return { context, state, video, $, day, segment, render };
}

function selectionSnapshot(h) {
  return {
    inMs: h.state.inMs, outMs: h.state.outMs,
    detail: { hidden: h.$('range-overlay').hidden, ...h.$('range-overlay').style },
    overview: { hidden: h.$('overview-selection').hidden, ...h.$('overview-selection').style },
    inHandle: { hidden: h.$('boundary-in').hidden, ...h.$('boundary-in').style },
    outHandle: { hidden: h.$('boundary-out').hidden, ...h.$('boundary-out').style },
    start: h.$('boundary-in-time').textContent, end: h.$('boundary-out-time').textContent,
    duration: h.$('selection-readout').textContent, exportDisabled: h.$('export-range').disabled,
  };
}

function wireMediaEvents(h) {
  loadFunction(h.context, 'finishLastRecordingFrame');
  Object.assign(h.context, {
    finishHlsStart() {}, stopPausedHlsPreview() {}, continueReplay() {},
    finishBufferedReplaySeek() {}, handlePlaybackError() {},
  });
  const begin = script.indexOf("$('replay-player').addEventListener('volumechange'");
  const end = script.indexOf("for (const boundary of ['in', 'out'])", begin);
  assert.ok(begin > 0 && end > begin);
  vm.runInContext(script.slice(begin, end), h.context);
}

test('entering live hides stale replay cursors and clocks without changing the selected export range', () => {
  const h = harness(); h.render();
  assert.equal(h.$('time-cursor').hidden, false);
  assert.equal(h.$('overview-cursor').hidden, false);
  assert.equal(h.segment.classList.contains('selected'), true);
  const selected = selectionSnapshot(h), cursor = h.state.cursorMs;
  h.state.previewMode = 'live'; h.state.playbackAutoplay = true; h.render();
  assert.equal(h.$('timeline-current-time').hidden, true);
  assert.equal(h.$('timeline-current-time').textContent, '', 'live must not display a stale replay timestamp');
  assert.equal(h.$('time-cursor').hidden, true);
  assert.equal(h.$('overview-cursor').hidden, true);
  assert.equal(h.$('overview-time-readout').textContent, '');
  assert.doesNotMatch(h.$('player-time-label').textContent, /12:15/);
  assert.doesNotMatch(h.$('timeline').getAttribute('aria-label') || '', /12:15/);
  assert.doesNotMatch(h.$('timeline-overview').getAttribute('aria-valuetext') || '', /12:15/);
  assert.doesNotMatch(h.$('timeline-overview').getAttribute('aria-valuetext') || '', /直播中/,
    'an overview in live mode must not announce successful playback while the player is connecting');
  assert.equal(h.segment.classList.contains('selected'), false);
  assert.equal(h.$('mark-in').disabled, true);
  assert.equal(h.$('mark-out').disabled, true);
  assert.equal(h.state.cursorMs, cursor, 'live must not replace a retained replay position with wall-clock time');
  assert.deepEqual(selectionSnapshot(h), selected);
});

test('renderOverview alone cannot bring back a live cursor after new recording segments arrive', () => {
  const h = harness(); h.render(); const selected = selectionSnapshot(h);
  h.state.previewMode = 'live'; h.state.segments.push({ start: new Date(h.day + 13 * 3_600_000).toISOString(), duration: 90 });
  h.context.renderOverview();
  assert.equal(h.$('overview-cursor').hidden, true);
  assert.equal(h.$('overview-time-readout').textContent, '');
  assert.doesNotMatch(h.$('timeline-overview').getAttribute('aria-valuetext') || '', /12:15/);
  assert.deepEqual(selectionSnapshot(h), selected);
});

test('go-live immediately clears the old accessible overview time without rebuilding the timeline', () => {
  const h = harness(); h.render(); const selected = selectionSnapshot(h);
  assert.match(h.$('timeline-overview').getAttribute('aria-valuetext'), /12:15/);
  h.state.previewMode = 'live'; h.context.updateCursor();
  assert.equal(h.$('time-cursor').hidden, true); assert.equal(h.$('overview-cursor').hidden, true);
  assert.equal(h.$('overview-time-readout').textContent, '');
  assert.match(h.$('timeline-overview').getAttribute('aria-valuetext'), /实时预览模式/);
  assert.doesNotMatch(h.$('timeline-overview').getAttribute('aria-valuetext'), /12:15|直播中/);
  assert.deepEqual(selectionSnapshot(h), selected);
});

test('live with a cleared replay cursor clears old labels and keeps an existing selection usable', () => {
  const h = harness(); h.render(); const selected = selectionSnapshot(h);
  h.state.previewMode = 'live'; h.state.cursorMs = null; h.render();
  for (const id of ['time-cursor', 'overview-cursor']) assert.equal(h.$(id).hidden, true);
  assert.equal(h.$('overview-time-readout').textContent, '');
  assert.doesNotMatch(h.$('player-time-label').textContent, /12:15/);
  assert.deepEqual(selectionSnapshot(h), selected);
});

test('returning to replay restores the retained position and mark controls', () => {
  const h = harness(); h.state.previewMode = 'live'; h.render();
  Object.assign(h.video, { paused: false, readyState: 4, currentSrc: h.video.src });
  h.state.previewMode = 'replay'; h.render();
  assert.equal(h.$('timeline-current-time').hidden, false);
  assert.equal(h.$('timeline-current-time').textContent, '12:15:00');
  assert.equal(h.$('time-cursor').hidden, false);
  assert.equal(h.$('overview-cursor').hidden, false);
  assert.equal(h.$('player-time-label').textContent, '回放中');
  assert.equal(h.$('overview-time-readout').textContent, '12:15');
  assert.equal(h.$('mark-in').disabled, false);
  assert.equal(h.$('mark-out').disabled, false);
});

test('same-window replay and SDK transitions refresh overview accessibility without a full render', () => {
  const h = harness(); h.state.previewMode = 'live'; h.render();
  const overview = h.$('timeline-overview');
  h.state.previewMode = 'replay'; h.context.updateCursor();
  assert.equal(overview.getAttribute('aria-valuetext'), '2026-09-30 12:15:00');
  assert.equal(overview.getAttribute('aria-valuenow'), '44100');
  h.state.playBounds = { sdkTimingUnknown: true }; h.context.updateCursor();
  assert.equal(overview.getAttribute('aria-valuetext'), '请求 2026-09-30 12:15:00');
  assert.equal(h.$('overview-time-readout').textContent, '请求 12:15');
  assert.equal(h.$('mark-in').disabled, true);
});

test('SDK timing-unknown labels identify a requested time and cannot mark an alleged current frame', () => {
  const h = harness(); h.state.playBounds = { sdkTimingUnknown: true };
  Object.assign(h.video, { paused: false, readyState: 4, currentSrc: h.video.src }); h.render();
  assert.match(h.$('player-time-label').textContent, /以画面为准/);
  assert.doesNotMatch(h.$('player-time-label').textContent, /12:15/);
  assert.match(h.$('overview-time-readout').textContent, /^请求\s+12:15/);
  assert.match(h.$('timeline').getAttribute('aria-label'), /请求/);
  assert.match(h.$('timeline-overview').getAttribute('aria-valuetext'), /请求/);
  assert.equal(h.$('mark-in').disabled, true);
  assert.equal(h.$('mark-out').disabled, true);
  for (const id of ['time-cursor', 'overview-cursor']) assert.equal(h.$(id).classList.contains('requested-time'), true);
  const selected = selectionSnapshot(h);
  h.state.previewMode = 'live'; h.render();
  assert.equal(h.$('overview-time-readout').textContent, '');
  assert.doesNotMatch(h.$('player-time-label').textContent, /请求|12:15/);
  assert.deepEqual(selectionSnapshot(h), selected);
});

test('only a loaded, matching, unpaused live video receives the active live label', () => {
  const h = harness(); h.state.previewMode = 'live'; h.state.playbackAutoplay = true;
  const label = h.$('player-time-label');
  h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '连接中'); assert.equal(label.classList.contains('is-live'), false);
  h.video.paused = false; h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '连接中', 'play intent and paused=false do not prove that media is ready');
  Object.assign(h.video, { readyState: 4, currentSrc: 'http://test/old.mp4' }); h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '连接中', 'a previous source cannot establish the current live status');
  h.video.currentSrc = h.video.src; h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '直播中'); assert.equal(label.classList.contains('is-live'), true);
  h.state.playbackWaiting = true; h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '连接中'); assert.equal(label.classList.contains('is-live'), false);
});

test('live paused, ended and failed states take precedence over a requested autoplay', () => {
  const h = harness(); h.state.previewMode = 'live'; h.state.playbackAutoplay = true;
  Object.assign(h.video, { readyState: 4, currentSrc: h.video.src });
  const label = h.$('player-time-label'); h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '直播已暂停'); assert.equal(label.classList.contains('is-live'), false);
  h.video.ended = true; h.context.syncPlaybackStatus(); assert.equal(label.textContent, '直播已结束');
  h.video.error = { code: 3 }; h.context.syncPlaybackStatus(); assert.equal(label.textContent, '连接失败');
  Object.assign(h.video, { error: null, ended: false, paused: false });
  h.state.previewFailed = true; h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '连接失败'); assert.equal(label.classList.contains('is-live'), false);
  h.video.hidden = true; h.context.syncPlaybackStatus();
  assert.equal(label.textContent, '—'); assert.equal(label.classList.contains('is-live'), false);
});

test('video waiting, playing and pause events refresh live status without waiting for cursor movement', () => {
  const h = harness(); h.state.previewMode = 'live';
  wireMediaEvents(h);
  Object.assign(h.video, { paused: false, readyState: 2, currentSrc: h.video.src });
  h.video.dispatch('waiting'); assert.equal(h.$('player-time-label').textContent, '连接中');
  h.video.readyState = 4;
  h.video.dispatch('playing'); assert.equal(h.$('player-time-label').textContent, '直播中');
  assert.equal(h.state.playbackWaiting, false);
  h.video.paused = true; h.video.dispatch('pause');
  assert.equal(h.$('player-time-label').textContent, '直播已暂停');
  h.video.ended = true; h.video.dispatch('ended');
  assert.equal(h.$('player-time-label').textContent, '直播已结束');
});

test('pausing a buffering live video immediately clears waiting without a later canplay event', () => {
  const h = harness(); h.state.previewMode = 'live'; wireMediaEvents(h);
  Object.assign(h.video, { paused: false, readyState: 2, currentSrc: h.video.src });
  h.video.dispatch('waiting');
  assert.equal(h.state.playbackWaiting, true); assert.equal(h.$('player-time-label').textContent, '连接中');
  h.video.paused = true; h.video.dispatch('pause');
  assert.equal(h.state.playbackWaiting, false);
  assert.equal(h.$('player-time-label').textContent, '直播已暂停');
  assert.equal(h.$('player-time-label').classList.contains('is-live'), false);
});

test('late waiting and playing events cannot override current media evidence', () => {
  const h = harness(); h.state.previewMode = 'live'; h.state.playbackWaiting = false; wireMediaEvents(h);
  Object.assign(h.video, { paused: false, readyState: 4, currentSrc: h.video.src });
  h.video.dispatch('waiting');
  assert.equal(h.state.playbackWaiting, false, 'a queued waiting event cannot relabel already-ready video');
  assert.equal(h.$('player-time-label').textContent, '直播中');
  h.video.currentSrc = 'http://test/previous.mp4'; h.state.playbackWaiting = true;
  h.video.dispatch('canplay');
  assert.equal(h.state.playbackWaiting, true, 'old-source canplay cannot clear current waiting state');
  h.state.previewFailed = true; h.video.dispatch('playing');
  assert.equal(h.state.previewFailed, true, 'old-source playing cannot clear failure');
  assert.equal(h.$('player-time-label').textContent, '连接失败');
  assert.equal(h.$('player-time-label').classList.contains('is-live'), false);
});

test('replay status distinguishes loading, paused, ended, failed and SDK unknown timing', () => {
  const h = harness(), label = h.$('player-time-label');
  h.context.syncPlaybackStatus(); assert.equal(label.textContent, '载入中');
  assert.equal(label.getAttribute('aria-live'), 'off', 'regular replay time updates must not announce each second');
  Object.assign(h.video, { readyState: 4, currentSrc: h.video.src });
  h.context.syncPlaybackStatus(); assert.equal(label.textContent, '回放已暂停');
  h.video.ended = true; h.context.syncPlaybackStatus(); assert.equal(label.textContent, '本段结束');
  h.video.error = { code: 3 }; h.context.syncPlaybackStatus(); assert.equal(label.textContent, '回放失败');
  Object.assign(h.video, { paused: false, ended: false, error: null });
  h.state.playBounds = { sdkTimingUnknown: true }; h.context.syncPlaybackStatus();
  assert.match(label.textContent, /以画面为准/); assert.doesNotMatch(label.textContent, /\d\d:\d\d/);
  assert.equal(label.getAttribute('aria-live'), 'polite');
  assert.equal(label.classList.contains('is-live'), false);
});

test('transport labels describe live/replay actions and sound icons remain accessible after toggling', () => {
  const h = harness();
  for (const [mode, noun] of [['live', '直播'], ['replay', '录像']]) {
    h.state.previewMode = mode;
    for (const paused of [true, false]) {
      h.video.paused = paused; h.context.syncReplayToggle();
      const toggle = h.$('playback-toggle'), label = `${paused ? '播放' : '暂停'}${noun}`;
      assert.equal(toggle.getAttribute('aria-label'), label); assert.equal(toggle.title, label);
      assert.equal(toggle.getAttribute('aria-pressed'), String(!paused));
      assert.equal(h.$('skip-back').hidden, false, 'transport layout stays stable in live and replay');
      assert.equal(h.$('skip-back').disabled, mode === 'live' || !h.state.segments.length);
      assert.equal(h.$('skip-forward').hidden, false);
      assert.equal(h.$('transport-toggle').getAttribute('aria-label'), label);
      assert.equal(h.$('transport-toggle').getAttribute('aria-pressed'), String(!paused));
    }
  }
  const sound = h.$('playback-mute'); h.context.syncReplayMute();
  assert.match(sound.innerHTML, /<svg[^>]+aria-hidden="true"/);
  assert.equal(sound.getAttribute('aria-label'), '开启声音'); assert.equal(sound.title, '开启声音');
  h.context.toggleReplayMute();
  assert.equal(sound.getAttribute('aria-label'), '静音'); assert.equal(sound.title, '静音');
  assert.equal(sound.getAttribute('aria-pressed'), 'true'); assert.match(sound.innerHTML, /<svg/);
  assert.equal(sound.textContent, '', 'sound buttons remain icon-only after state changes');
});

test('a failed video cannot retain the pause icon even if paused remains false', () => {
  const h = harness(); Object.assign(h.video, { paused: false, readyState: 4, currentSrc: h.video.src });
  for (const [mode, noun] of [['live', '直播'], ['replay', '录像']]) {
    h.state.previewMode = mode;
    for (const nativeError of [true, false]) {
      h.video.error = nativeError ? { code: 3 } : null; h.state.previewFailed = !nativeError;
      h.context.syncReplayToggle();
      assert.equal(h.$('playback-toggle').getAttribute('aria-pressed'), 'false');
      assert.equal(h.$('playback-toggle').getAttribute('aria-label'), `播放${noun}`);
      assert.equal(h.$('playback-toggle').title, `播放${noun}`);
      assert.match(h.$('player-time-label').textContent, /失败/);
    }
  }
});

test('transport HTML supplies Chinese accessible labels, icon visuals and 44px touch targets', () => {
  const html = statusDashboardPage();
  const expected = new Map([
    ['go-live', '回到直播'], ['transport-toggle', '播放回放'], ['playback-mute', '开启声音'],
    ['replay-fullscreen', '全屏回放'], ['previous-day', '前一天'], ['next-day', '后一天'],
    ['skip-back', '后退 10 秒，长按连续后退'], ['skip-forward', '前进 10 秒，长按连续前进'],
  ]);
  for (const [id, label] of expected) {
    const button = html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?<\\/button>`))?.[0];
    assert.ok(button, `${id} exists`);
    assert.match(button, new RegExp(`aria-label="${label}"`));
    assert.match(button, new RegExp(`title="${label}`));
    assert.match(button, /<svg[^>]+aria-hidden="true"/);
  }
  assert.match(html, /id="playback-toggle"[^>]*tabindex="-1"[^>]*hidden inert/);
  assert.match(html, /id="playback-toggle-label" class="sr-only"/);
  assert.match(html, /id="player-time-label"[^>]*role="status"/);
  const touchRule = css.match(/\.precision-layout #view-replay\.focus-replay \.transport-buttons > button \{([^}]+)\}/)?.[1];
  assert.ok(touchRule);
  assert.match(touchRule, /min-width:var\(--control\)/); assert.match(touchRule, /min-height:var\(--control\)/);
  assert.ok(Number(css.match(/--control:\s*(\d+)px/)?.[1]) >= 44);
  assert.match(css, /#view-replay\.focus-replay \.transport-buttons > button svg \{[^}]*width:26px; height:26px;[^}]*fill:none; stroke:currentColor; stroke-width:1\.8/);
  assert.match(css, /\.sr-only\s*\{[^}]*clip-path:\s*inset\(50%\)/);
});

test('central transport starts the selected recording when the player has no source yet', async () => {
  const h = harness(), calls = []; let toggles = 0;
  h.context.jumpToTimelineTime = async (...args) => calls.push(args);
  h.context.setPlaybackNotice = () => {};
  h.context.toggleReplayPlayback = () => { toggles++; };
  loadFunction(h.context, 'toggleTransportPlayback');
  h.video.hidden = true; h.context.syncReplayToggle();
  assert.equal(h.$('transport-toggle').disabled, false);
  await h.context.toggleTransportPlayback();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], h.state.cursorMs);
  assert.equal(calls[0][2].autoplay, true);
  h.video.hidden = false; await h.context.toggleTransportPlayback(); assert.equal(toggles, 1);
  h.video.hidden = true; h.state.segments = []; await h.context.toggleTransportPlayback();
  assert.equal(calls.length, 1); h.context.syncReplayToggle(); assert.equal(h.$('transport-toggle').disabled, true);
});

test('date navigation is grouped with the date and the player keeps one ordered transport row', () => {
  const html = statusDashboardPage();
  const transport = html.match(/<div class="transport-buttons">([\s\S]*?)<\/div>/)?.[1];
  const dates = html.match(/<div class="replay-date-controls">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(transport); assert.ok(dates);
  const buttonIds = markup => [...markup.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(buttonIds(transport), ['skip-back', 'transport-toggle', 'skip-forward']);
  assert.deepEqual(buttonIds(dates), ['previous-day', 'playback-context', 'next-day']);
  for (const id of [...buttonIds(transport), ...buttonIds(dates)]) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id + ' must not be cloned for another viewport');
  }
  assert.match(html, /class="legacy-timeline-metadata" hidden inert>[\s\S]*?id="fine-back"[\s\S]*?id="fine-forward"/);
  assert.doesNotMatch(script, /\$\('fine-back'\)\.addEventListener/);
  assert.doesNotMatch(script, /\$\('fine-forward'\)\.addEventListener/);
});

test('icon day buttons change exactly one day across month boundaries and reject the future', () => {
  const h = harness(); let changes = 0;
  h.context.today = () => '2026-10-08'; h.context.Event = class { constructor(type){this.type=type;} };
  h.$('date-select').dispatchEvent = event => { assert.equal(event.type,'change'); changes++; };
  loadFunction(h.context,'changeReplayDay');
  h.$('date-select').value = '2026-10-01'; h.context.changeReplayDay(-1);
  assert.equal(h.$('date-select').value,'2026-09-30'); assert.equal(changes,1);
  h.context.changeReplayDay(1); assert.equal(h.$('date-select').value,'2026-10-01'); assert.equal(changes,2);
  h.$('date-select').value='2026-10-07'; h.context.changeReplayDay(1);
  assert.equal(h.$('next-day').disabled,true); assert.equal(changes,3);
  h.context.changeReplayDay(1); assert.equal(h.$('date-select').value,'2026-10-08'); assert.equal(changes,3);
});

test('recording list renders refresh central and seek availability without a media event', () => {
  const h=harness(); loadFunction(h.context,'updateTimelineLabels');
  h.video.hidden=true; h.state.segments=[]; h.context.updateTimelineLabels();
  assert.equal(h.$('transport-toggle').disabled,true);
  h.state.segments=[{start:new Date(h.day).toISOString(),duration:3600}]; h.context.updateTimelineLabels();
  assert.equal(h.$('transport-toggle').disabled,false); assert.equal(h.$('skip-back').disabled,false);
  h.state.previewMode='live'; h.context.updateTimelineLabels(); assert.equal(h.$('skip-back').disabled,true); assert.equal(h.$('fine-back').disabled,true);
  h.state.segments=[]; h.context.updateTimelineLabels(); assert.equal(h.$('transport-toggle').disabled,true);
});
