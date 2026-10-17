import { formatClipDuration, setButtonIcon } from '../public/ui-primitives.js';
import { findCoverageGap, countCoverageGaps, listCoverageGaps } from '../public/playback-coverage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
const inMs = Date.parse('2026-01-01T20:00:00+08:00'), outMs = inMs + 60_000;
const gapSegments = [
  { startMs: inMs, endMs: inMs + 10_000 },
  { startMs: inMs + 20_000, endMs: inMs + 40_000 },
  { startMs: inMs + 50_000, endMs: outMs },
];
const expectedRows = [
  '2026-01-01 20:00:10 → 2026-01-01 20:00:20',
  '2026-01-01 20:00:40 → 2026-01-01 20:00:50',
];
const plain = value => JSON.parse(JSON.stringify(value));

// Execute the production handlers and helpers without duplicating their logic.
// Explicit section boundaries fail loudly if the application is reorganized.
function section(start, end) {
  const first = script.indexOf(start), last = script.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`);
  return script.slice(first, last);
}
class Element {
  children = []; listeners = new Map(); attributes = new Map(); style = {};
  hidden = false; disabled = false; value = ''; textContent = ''; classes = new Set();
  classList = {
    add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name),
    toggle: (name, enabled) => { if (enabled) this.classes.add(name); else this.classes.delete(name); },
  };
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { if (!this.disabled) return this.listeners.get('click')?.(); }
}
function harness({ gaps = true, source = 'mediamtx' } = {}) {
  const elements = new Map(), sheets = [], requests = [], notices = [], logouts = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  $('dvr-select').value = 'recorder-a'; $('dvr-channel').value = '201';
  const state = { playbackSource: source, selectedCamera: 'camera-a', date: '2026-01-01', configRevision: 1,
    inMs, outMs, segments: gaps ? gapSegments : [{ startMs: inMs, endMs: outMs }], busy: false, timelineSpanSeconds: 300 };
  const timers = new Map(); let timerId = 0, refreshes = 0;
  let respond = async () => Response.json({ success: true, taskId: 'task-a', status: 'queued' });
  const context = vm.createContext({
    $, state, formatClipDuration, setButtonIcon, findCoverageGap, countCoverageGaps, listCoverageGaps,
    AbortController, consoleSession: 1, exportSubmission: null, pendingTaskFocus: null,
    dateParts: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    document: { body: { dataset: { view: 'replay' } }, createElement: () => new Element() },
    body: JSON.stringify, appPath: value => value,
    setTimeout: (action, delay) => { const id = ++timerId; timers.set(id, { action, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => {
      requests.push({ url, options, payload: JSON.parse(options.body) });
      return respond(url, options);
    },
    notify: (...args) => notices.push(args),
    refreshState: async () => { refreshes++; },
    updateBoundaryControls() {},
    loggedOut: message => { logouts.push(message); context.consoleSession++; context.cancelExportSubmission(true); },
    openDialog: (title, copy, options) => {
      const sheet = { title, copy, options, content: new Element(), actions: new Element(), error: new Element(), closed: false,
        close() { this.closed = true; } };
      sheets.push(sheet); return sheet;
    },
  });
  for (const [start, end] of [
    ['function wallTime(', 'function daySeconds('],
    ['async function api(', 'async function requestJson('],
    ['function hasPlaybackSelection(', 'function invalidatePlaybackSelection('],
    ['function timelineWindow(', 'function renderOverview('],
    ['function playbackContextKey(', 'function requirePlaybackContext('],
    ['function updateSelection(', 'function clearReplay('],
    ["$('export-range').addEventListener('click'", 'function prettyBytes('],
    ['function addButton(', 'function addSettingsRefresh('],
    ['function rememberSubmittedTask(', 'function revealSubmittedTask('],
  ]) vm.runInContext(section(start, end), context);
  context.updateSelection();
  return { context, state, $, sheets, requests, notices, logouts, timers,
    get refreshes() { return refreshes; },
    setFetch: value => { respond = value; },
    fireDeadline() {
      const entry = [...timers].find(([, timer]) => timer.delay === 20_000);
      assert.ok(entry, 'submission must install its bounded deadline');
      timers.delete(entry[0]); entry[1].action();
    },
    holdFetch() {
      respond = (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  };
}
function assertIdle(h) {
  assert.equal(h.state.busy, false);
  assert.equal(h.context.exportSubmission, null);
  assert.equal(h.$('export-range').disabled, false);
  assert.equal(h.$('cancel-export').hidden, true);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 20_000), false);
}

for (const trigger of ['selection-gap-warning', 'export-range']) {
  test(`${trigger} immediately lists every known interruption without a network request`, async () => {
    const h = harness();
    assert.equal(h.$('selection-gap-warning').hidden, false);
    assert.equal(h.$('selection-gap-count').textContent, '2');
    assert.equal(h.$('selection-gap-warning').getAttribute('aria-label'), '查看 2 处录像中断的时间范围');
    const clicked = h.$(trigger).click();
    assert.equal(h.sheets.length, 1, 'the dialog appears synchronously, before waiting for a server response');
    await clicked;
    assert.equal(h.requests.length, 0);
    const sheet = h.sheets[0];
    assert.deepEqual(sheet.content.children[0].children.map(row => row.textContent), expectedRows);
    assert.match(sheet.copy, /只保留已有画面/);
    assert.equal(h.state.busy, false); assert.equal(h.$('cancel-export').hidden, true);
    assert.deepEqual(sheet.actions.children.map(button => button.textContent), ['取消', '接受中断并导出']);
  });
}

test('cancelling the interruption dialog preserves the selected range and submits nothing', async () => {
  const h = harness(); await h.$('export-range').click();
  h.sheets[0].actions.children[0].click();
  assert.equal(h.sheets[0].closed, true); assert.equal(h.requests.length, 0);
  assert.equal(h.state.inMs, inMs); assert.equal(h.state.outMs, outMs); assertIdle(h);
});

test('explicit acceptance sends the captured selection once and records the returned task', async () => {
  const h = harness(); let resolve;
  h.setFetch(() => new Promise(done => { resolve = done; }));
  await h.$('export-range').click(); const sheet = h.sheets[0];
  const first = sheet.actions.children[1].click();
  await sheet.actions.children[1].click();
  assert.equal(sheet.closed, true); assert.equal(h.requests.length, 1);
  assert.equal(h.state.busy, true); assert.equal(h.$('cancel-export').hidden, false);
  assert.equal(h.$('selection-gap-warning').disabled, true);
  assert.deepEqual(h.requests[0].payload, { source: 'mediamtx', camera: 'camera-a', mode: 'copy',
    start: '2026-01-01 20:00:00', end: '2026-01-01 20:01:00', acceptGaps: true });
  resolve(Response.json({ success: true, taskId: 'accepted-a' })); await first;
  assert.deepEqual(plain(h.context.pendingTaskFocus), { kind: 'exports', id: 'accepted-a' });
  assert.match(h.notices.at(-1)[0], /跳过录像中断/); assert.equal(h.refreshes, 1); assertIdle(h);
});

for (const [name, change] of [
  ['date', h => { h.state.date = '2026-01-02'; }],
  ['camera', h => { h.state.selectedCamera = 'camera-b'; }],
  ['source', h => { h.state.playbackSource = 'dvr'; }],
  ['in point', h => { h.state.inMs += 1_000; }],
  ['out point', h => { h.state.outMs -= 1_000; }],
  ['configuration revision', h => { h.state.configRevision++; }],
  ['selection generation', h => { h.state.playbackSelectionVersion = 1; }],
]) test(`a changed ${name} invalidates an already open gap confirmation`, async () => {
  const h = harness(); await h.$('export-range').click(); const sheet = h.sheets[0];
  change(h); await sheet.actions.children[1].click();
  assert.equal(h.requests.length, 0); assert.equal(sheet.closed, false);
  assert.match(sheet.error.textContent, /已改变/); assert.equal(h.state.busy, false);
});

test('a complete MediaMTX range submits directly without accepting gaps or stale DVR fields', async () => {
  const h = harness({ gaps: false });
  assert.equal(h.$('selection-gap-warning').hidden, true);
  await h.$('export-range').click();
  assert.equal(h.sheets.length, 0); assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].payload, { source: 'mediamtx', camera: 'camera-a', mode: 'copy', start: '2026-01-01 20:00:00', end: '2026-01-01 20:01:00' });
  assertIdle(h);
});

test('DVR submission retains the recorder/channel contract and ignores MediaMTX gaps', async () => {
  const h = harness({ source: 'dvr' }); await h.$('export-range').click();
  assert.equal(h.sheets.length, 0);
  assert.deepEqual(h.requests[0].payload, { source: 'hikvision', deviceId: 'recorder-a', channel: '201', dvrMethod: 'auto',
    start: '2026-01-01 20:00:00', end: '2026-01-01 20:01:00' });
  const snapshot = h.context.captureExportSelection(); h.$('dvr-channel').value = '301';
  assert.equal(await h.context.submitExportSelection(snapshot), false); assert.equal(h.requests.length, 1);
  assert.match(h.notices.at(-1)[0], /已改变/); assertIdle(h);
});

test('duplicate submit calls while pending share one request and one cancellation signal', async () => {
  const h = harness({ gaps: false }); h.holdFetch();
  const selection = h.context.captureExportSelection(), first = h.context.submitExportSelection(selection);
  assert.equal(await h.context.submitExportSelection(selection), false);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].options.signal.aborted, false);
  h.$('cancel-export').click(); await first;
  assert.equal(h.requests[0].options.signal.aborted, true); assertIdle(h);
});

test('cancel aborts the actual HTTP signal, releases the busy controls and preserves the selection', async () => {
  const h = harness({ gaps: false }); h.holdFetch();
  const pending = h.$('export-range').click();
  assert.equal(h.state.busy, true); assert.equal(h.$('cancel-export').hidden, false);
  h.$('cancel-export').click(); await pending;
  assert.equal(h.requests[0].options.signal.aborted, true); assertIdle(h);
  assert.equal(h.state.inMs, inMs); assert.equal(h.state.outMs, outMs);
  assert.match(h.notices.at(-1)[0], /已停止等待.*任务页取消/); assert.equal(h.refreshes, 1);
  h.setFetch(async () => Response.json({ taskId: 'retried-a' })); await h.$('export-range').click();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].options.signal.aborted, false);
  assert.equal(h.context.pendingTaskFocus.id, 'retried-a'); assertIdle(h);
});

test('the twenty-second deadline aborts the request and restores usable controls with explicit feedback', async () => {
  const h = harness({ gaps: false }); h.holdFetch();
  const pending = h.$('export-range').click(); h.fireDeadline(); await pending;
  assert.equal(h.requests[0].options.signal.aborted, true); assertIdle(h);
  assert.match(h.notices.at(-1)[0], /核验超时.*查看任务状态/); assert.equal(h.notices.at(-1)[1], true);
  assert.equal(h.sheets.length, 0); assert.equal(h.refreshes, 1);
});

test('a network failure after acceptance restores controls and requires a fresh confirmation before retrying', async () => {
  const h = harness(); h.setFetch(async () => { throw new Error('synthetic network outage'); });
  await h.$('export-range').click(); await h.sheets[0].actions.children[1].click();
  assert.equal(h.sheets[0].closed, true); assertIdle(h);
  assert.match(h.notices.at(-1)[0], /synthetic network outage/); assert.equal(h.notices.at(-1)[1], true);
  assert.equal(h.state.inMs, inMs); assert.equal(h.state.outMs, outMs);
  await h.$('export-range').click();
  assert.equal(h.sheets.length, 2); assert.equal(h.requests.length, 1, 'opening the replacement confirmation does not resend the export');
});

test('new authoritative server gaps open confirmation after busy state settles', async () => {
  const h = harness({ gaps: false }), coverage = { missingSeconds: 5, missingIntervals: [{ start: '2026-01-01 20:00:25', end: '2026-01-01 20:00:30' }] };
  h.setFetch(async () => Response.json({ code: 'MEDIAMTX_GAPS', coverage, error: 'confirm missing footage' }, { status: 409 }));
  await h.$('export-range').click();
  assert.equal(h.requests.length, 1); assert.equal('acceptGaps' in h.requests[0].payload, false);
  assert.equal(h.sheets.length, 1); assertIdle(h);
  assert.equal(h.sheets[0].content.children[0].children[0].textContent, '2026-01-01 20:00:25 → 2026-01-01 20:00:30');
});

for (const [name, change] of [
  ['another tab', h => { h.context.document.body.dataset.view = 'settings'; }],
  ['another selected channel', h => { h.state.selectedCamera = 'camera-b'; }],
  ['a changed range', h => { h.state.outMs += 10_000; }],
]) test(`a late server gap result does not open a dialog over ${name}`, async () => {
  const h = harness({ gaps: false }); let resolve;
  h.setFetch(() => new Promise(done => { resolve = done; }));
  const pending = h.$('export-range').click(); change(h);
  resolve(Response.json({ code: 'MEDIAMTX_GAPS', coverage: { missingIntervals: expectedRows }, error: 'gap' }, { status: 409 }));
  await pending; assert.equal(h.sheets.length, 0); assertIdle(h);
  assert.match(h.notices.at(-1)[0], /返回回放页查看并确认/);
});

test('server empty-footage rejection provides feedback without reopening a gap sheet or erasing markers', async () => {
  const h = harness({ gaps: false });
  h.setFetch(async () => Response.json({ code: 'MEDIAMTX_EMPTY', error: 'empty' }, { status: 422 }));
  await h.$('export-range').click(); assertIdle(h);
  assert.equal(h.sheets.length, 0); assert.match(h.notices.at(-1)[0], /没有可导出的 MediaMTX 录像/);
  assert.equal(h.state.inMs, inMs); assert.equal(h.state.outMs, outMs);
});

test('logout silently cancels an in-flight submission and suppresses obsolete feedback', async () => {
  const h = harness({ gaps: false }); h.holdFetch();
  const pending = h.$('export-range').click(); h.context.loggedOut('signed out'); await pending;
  assert.equal(h.requests[0].options.signal.aborted, true); assert.equal(h.notices.length, 0);
  assert.equal(h.sheets.length, 0); assert.equal(h.context.pendingTaskFocus, null); assertIdle(h);
});

test('a late success from a previous console session does not focus a task or show a toast', async () => {
  const h = harness({ gaps: false }); let resolve;
  h.setFetch(() => new Promise(done => { resolve = done; }));
  const pending = h.$('export-range').click(); h.context.consoleSession++;
  resolve(Response.json({ taskId: 'obsolete-task' })); await pending;
  assert.equal(h.notices.length, 0); assert.equal(h.context.pendingTaskFocus, null); assert.equal(h.refreshes, 0); assertIdle(h);
});

test('invalid or missing selections never show gap consent or submit an export', async () => {
  for (const change of [h => { h.state.inMs = null; }, h => { h.state.outMs = inMs; }, h => { h.state.selectedCamera = ''; }]) {
    const h = harness(); change(h); h.context.updateSelection();
    await h.$('export-range').listeners.get('click')(); h.$('selection-gap-warning').click();
    assert.equal(h.requests.length, 0); assert.equal(h.sheets.length, 0);
  }
});

test('API wrapper preserves authoritative gap coverage and code for user confirmation', async () => {
  const coverage = { missingSeconds: 15, missingIntervals: [{ startMs: 1000, endMs: 16000 }] };
  const context = vm.createContext({ appPath: value => value, loggedOut() {}, fetch: async () => ({ status: 409, ok: false,
    headers: { get: () => 'application/json' }, json: async () => ({ error: '录像缺口', code: 'MEDIAMTX_GAPS', coverage }) }) });
  vm.runInContext(section('async function api(', 'async function requestJson('), context);
  await assert.rejects(context.api('/console/api/export'), error => error.code === 'MEDIAMTX_GAPS' && error.coverage === coverage && error.status === 409);
});
