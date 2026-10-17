import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { rangeTimeMs } from '../public/touch-controls.js';

const source = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function harness(playbackSource = 'mediamtx') {
  const day = Date.parse('2026-10-01T00:00:00+08:00'), inputs = [], sheets = [], actions = [];
  const node = () => ({ children: [], append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener() {}, focus() {} });
  const controls = new Map(), $ = id => { if (!controls.has(id)) controls.set(id, { value: id === 'dvr-select' ? 'recorder-a' : id === 'dvr-channel' ? '101' : '', classList: { add() {} } }); return controls.get(id); };
  const state = { date: '2026-10-01', playbackSource, selectedCamera: 'camera-a', playbackSelectionVersion: 3, configRevision: 'revision-1', inMs: null, outMs: null, cursorMs: day, timelineStartMs: day, timelineSpanSeconds: 3600,
    previewMode: 'live', playRequestId: 7, playbackAutoplay: true };
  const context = vm.createContext({ state, Math, rangeTimeMs, clampTimelineCenter: ms => Math.max(day, Math.min(day + 86399999, ms)), dateStart: () => day, timelineLimit: () => day + 86400000,
    boundaryLabel: ms => ms === day + 86400000 ? '24:00:00' : new Date(ms + 8 * 3600000).toISOString().slice(11, 19),
    $, document: { createElement: node }, renderTimeline() {}, updateSelection() {},
    formatClipDuration: ms => String(ms), enhanceTimeInput: input => input,
    labelledInput(parent, label, value, options) { const input = { ...node(), label, value, options }; inputs.push(input); parent.append(input); return input; },
    openDialog(title, description) { const sheet = { title, description, content: node(), actions: node(), error: {}, close() { this.closed = true; } }; sheets.push(sheet); return sheet; },
    addButton(parent, label, cls, click) { const button = { label, click }; actions.push(button); parent.append(button); return button; },
  });
  vm.runInContext(source.slice(source.indexOf('function timelineWindow('), source.indexOf('function renderOverview(')), context);
  vm.runInContext(source.slice(source.indexOf('function setTimelineWindow('), source.indexOf('function renderTimeline(')), context);
  vm.runInContext(source.slice(source.indexOf('function openRangeEditor('), source.indexOf('function recoverOutputRename(')), context);
  vm.runInContext(source.slice(source.indexOf('function playbackContextKey('), source.indexOf('function openBoundaryEditor(')), context);
  context.openRangeEditor();
  return { state, day, inputs, context, $, sheet: sheets[0], apply: () => actions[0].click() };
}

test('manual short range reveals both markers without seeking or changing live playback', () => {
  const h = harness(); h.inputs[0].value = '214025'; h.inputs[1].value = '214035'; h.apply();
  assert.equal(h.sheet.title, '编辑选段'); assert.equal(h.sheet.description, '2026-10-01'); assert.equal(h.sheet.closed, true);
  assert.equal(h.state.outMs - h.state.inMs, 10000); assert.equal(h.state.timelineSpanSeconds, 3600);
  assert.ok(h.state.inMs >= h.state.timelineStartMs && h.state.outMs <= h.state.timelineStartMs + 3600000);
  assert.equal(h.state.previewMode, 'live'); assert.equal(h.state.cursorMs, h.day); assert.equal(h.state.playRequestId, 7); assert.equal(h.state.playbackAutoplay, true);
  assert.match(h.inputs[0].options.placeholder, /2140.*214025/);
});

test('long, whole-day and day-end ranges retain exact boundaries while keeping the one-hour viewport centred with at most half-hour padding', () => {
  for (const [start, end, seconds] of [['201500', '222100', 7560], ['0000', '240000', 86400], ['235950', '240000', 10]]) {
    const h = harness(); h.inputs[0].value = start; h.inputs[1].value = end; h.apply();
    assert.equal(h.state.outMs - h.state.inMs, seconds * 1000); assert.equal(h.state.timelineSpanSeconds, 3600);
    assert.ok(h.state.timelineStartMs >= h.day - 1800000 && h.state.timelineStartMs + 3600000 <= h.day + 88200000);
    assert.ok(h.state.inMs >= h.state.timelineStartMs && h.state.inMs <= h.state.timelineStartMs + 3600000);
  }
});

test('invalid range leaves the existing selection and viewport unchanged', () => {
  const h = harness(); Object.assign(h.state, { inMs: h.day + 1000, outMs: h.day + 2000 });
  h.inputs[0].value = '214035'; h.inputs[1].value = '214025'; h.apply();
  assert.equal(h.state.inMs, h.day + 1000); assert.equal(h.state.outMs, h.day + 2000); assert.equal(h.state.timelineStartMs, h.day); assert.ok(h.sheet.error.textContent);
});


test('date, camera, source, configuration revision and selection generation changes reject stale manual range edits', () => {
  for (const [reason, mutate] of [
    ['date', h => { h.state.date = '2026-10-02'; }],
    ['camera', h => { h.state.selectedCamera = 'camera-b'; }],
    ['source', h => { h.state.playbackSource = 'dvr'; }],
    ['configuration', h => { h.state.configRevision = 'revision-2'; }],
    ['generation', h => { h.state.playbackSelectionVersion++; }],
  ]) {
    const h = harness();
    h.inputs[0].value = '214025'; h.inputs[1].value = '214035'; mutate(h);
    Object.assign(h.state, { inMs: h.day + 5000, outMs: h.day + 15000 });
    const before = [h.state.inMs, h.state.outMs, h.state.cursorMs, h.state.timelineStartMs, h.state.playRequestId];
    h.apply();
    assert.deepEqual([h.state.inMs, h.state.outMs, h.state.cursorMs, h.state.timelineStartMs, h.state.playRequestId], before, reason);
    assert.match(h.sheet.error.textContent, /已改变.*重新打开/); assert.notEqual(h.sheet.closed, true);
  }
});

test('a stale DVR range editor cannot apply its times to a newly selected recorder or channel', () => {
  for (const [control, next] of [['dvr-select', 'recorder-b'], ['dvr-channel', '201']]) {
    const h = harness('dvr'); Object.assign(h.state, { inMs: h.day + 5000, outMs: h.day + 15000 });
    h.inputs[0].value = '214025'; h.inputs[1].value = '214035'; h.$(control).value = next; h.apply();
    assert.equal(h.state.inMs, h.day + 5000); assert.equal(h.state.outMs, h.day + 15000);
    assert.equal(h.state.timelineStartMs, h.day); assert.match(h.sheet.error.textContent, /已改变/); assert.notEqual(h.sheet.closed, true);
  }
});
