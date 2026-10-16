import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this._value = ''; this.disabled = false; }
  get value() { return this.tag === 'select' ? this.children.find(node => node.value === this._value)?.value ?? this.children[0]?.value ?? '' : this._value; }
  set value(value) { this._value = value; }
  get options() { return this.children; }
  replaceChildren(...nodes) { this.children = nodes; this._value = ''; }
  append(...nodes) { this.children.push(...nodes); }
}
const sourceSnapshot = () => ({ revision: 'r1', dvrs: [{ id: 'a', name: 'DVR A' }, { id: 'b', name: 'DVR B' }],
  cameras: [{ id: 'cam-a', name: 'Camera A' }, { id: 'cam-b', name: 'Camera B' }] });

function configHarness(playbackSource = 'dvr') {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(['dvr-select', 'camera-select', 'dvr-channel', 'playback-source'].includes(id) ? 'select' : 'div'));
    return nodes.get(id);
  };
  const state = { configRevision: 'r1', playbackSource, selectedCamera: 'cam-a', inMs: 1000, outMs: 2000, cursorMs: 1500, segments: [{ origin: 'a' }],
    selectedChannel: '101', dvrChannels: { a: '101' }, dvrChannelCache: { a: {} }, dvrChannelRequestId: 0, segmentRequestId: 0 };
  let resets = 0;
  const context = vm.createContext({ $, state, document: { createElement: tag => new Element(tag) },
    renderConsoleConfig() {}, updateSelection() {}, setPlaybackNotice() {},
    clearMarkedRange() { state.inMs = state.outMs = null; },
    invalidatePlaybackSelection() { resets++; state.segmentRequestId++; state.segments = []; state.cursorMs = null; },
  });
  vm.runInContext(script.slice(script.indexOf('function fillCameras('), script.indexOf("$('camera-select').addEventListener")), context);
  vm.runInContext(script.slice(script.indexOf('function fillDvrDevices('), script.indexOf('function hasPlaybackSelection(')), context);
  vm.runInContext(script.slice(script.indexOf('// Configuration is fetched separately'), script.indexOf('async function loadConsoleConfig(')), context);
  context.fillDvrDevices(sourceSnapshot().dvrs); context.fillCameras(sourceSnapshot().cameras);
  $('dvr-select').value = 'a';
  const channel = new Element('option'); channel.value = '101'; $('dvr-channel').append(channel);
  return { context, state, $, resets: () => resets };
}

test('first settings read and repeated unchanged reads preserve selected range, coverage and DVR channel', () => {
  const h = configHarness(), segments = h.state.segments;
  for (let attempt = 0; attempt < 3; attempt++) {
    h.context.acceptConsoleConfig(sourceSnapshot());
    assert.equal(h.state.inMs, 1000); assert.equal(h.state.outMs, 2000);
    assert.equal(h.state.cursorMs, 1500); assert.equal(h.state.segments, segments);
    assert.equal(h.state.selectedChannel, '101'); assert.equal(h.state.dvrChannels.a, '101');
    assert.equal(h.state.dvrChannelRequestId, 0); assert.equal(h.resets(), 0);
  }
});

test('a genuinely changed configuration still invalidates old range, coverage and DVR channels exactly once', () => {
  const h = configHarness();
  h.context.acceptConsoleConfig(sourceSnapshot());
  h.context.acceptConsoleConfig({ ...sourceSnapshot(), revision: 'r2' });
  assert.equal(h.state.inMs, null); assert.equal(h.state.outMs, null); assert.equal(h.state.cursorMs, null);
  assert.equal(h.state.segments.length, 0); assert.equal(h.state.selectedChannel, '');
  assert.equal(Object.keys(h.state.dvrChannels).length, 0); assert.equal(Object.keys(h.state.dvrChannelCache).length, 0);
  assert.equal(h.$('dvr-channel').disabled, true); assert.equal(h.state.dvrChannelRequestId, 1);
  assert.equal(h.resets(), 1);
  h.context.acceptConsoleConfig({ ...sourceSnapshot(), revision: 'r2' });
  assert.equal(h.resets(), 1);
});

test('first settings read with actual device fill cannot pair replacement DVR B with DVR A coverage', () => {
  const h = configHarness();
  h.context.acceptConsoleConfig({ ...sourceSnapshot(), revision: 'r2', dvrs: [sourceSnapshot().dvrs[1]] });
  assert.equal(h.$('dvr-select').value, 'b'); assert.equal(h.$('dvr-channel').disabled, true);
  assert.equal(h.state.selectedChannel, ''); assert.equal(h.state.inMs, null); assert.equal(h.state.outMs, null);
  assert.equal(h.state.segments.length, 0); assert.equal(h.resets(), 1);
});

test('first settings read invalidates changed same-ID endpoints/mappings and fails safe without a bootstrap revision', () => {
  for (const baseline of ['r1', null]) {
    const h = configHarness(); h.state.configRevision = baseline;
    h.context.acceptConsoleConfig({ ...sourceSnapshot(), revision: 'r2' });
    assert.equal(h.$('dvr-select').value, 'a'); assert.equal(h.$('dvr-channel').disabled, true);
    assert.equal(h.state.inMs, null); assert.equal(h.state.segments.length, 0); assert.equal(h.resets(), 1);
  }
});

test('same-revision discovery replacement invalidates active camera coverage but unrelated list changes preserve DVR selection', () => {
  const snapshot = { ...sourceSnapshot(), cameras: [sourceSnapshot().cameras[1]] };
  const camera = configHarness('mediamtx'); camera.context.acceptConsoleConfig(snapshot);
  assert.equal(camera.state.selectedCamera, 'cam-b'); assert.equal(camera.state.inMs, null); assert.equal(camera.resets(), 1);
  const recorder = configHarness('dvr'); recorder.context.acceptConsoleConfig(snapshot);
  assert.equal(recorder.state.selectedCamera, 'cam-b'); assert.equal(recorder.$('dvr-select').value, 'a');
  assert.equal(recorder.state.inMs, 1000); assert.equal(recorder.state.selectedChannel, '101'); assert.equal(recorder.resets(), 0);
});

test('a new login/bootstrap records the playback source revision and stale recorder test results are cleared', async () => {
  const h = configHarness(); h.context.acceptConsoleConfig(sourceSnapshot());
  vm.runInContext("recorderChecks.set('a', '连接正常')", h.context);
  Object.assign(h.context, { showBoot() {}, setConnection() {}, renderPasswordMode() {}, renderOutputs() {}, renderTasks() {}, renderSettings() {},
    loadCache: async () => {}, connectEvents() {}, loadSegments: async () => {}, navigate() {}, clock() {}, location: { hash: '#replay' },
  });
  vm.runInContext(script.slice(script.indexOf('async function start('), script.indexOf('function clock(')), h.context);
  await h.context.start({ ...sourceSnapshot(), configRevision: 'r2' });
  assert.equal(h.state.configRevision, 'r2');
  h.context.acceptConsoleConfig({ ...sourceSnapshot(), revision: 'r2' });
  assert.equal(h.resets(), 0);
  assert.equal(vm.runInContext('recorderChecks.size', h.context), 0);
});

function navigationHarness() {
  const views = ['replay', 'library', 'tasks', 'settings'];
  const makeNode = (key, view) => ({ dataset: { [key]: view }, classList: { toggle() {} }, setAttribute() {} });
  const panels = views.map(view => makeNode('panel', view)), buttons = views.map(view => makeNode('view', view));
  const scrolls = [], pushes = [], loads = [];
  const workspace = { scrollTop: 250 };
  const document = { body: { dataset: { view: 'replay' } }, querySelector: selector => selector === '.workspace-main' ? workspace : null, querySelectorAll: selector => selector === '[data-panel]' ? panels : buttons };
  const context = vm.createContext({ document, location: { hash: '#replay' },
    history: { pushState: (...args) => pushes.push(args) }, window: { scrollTo: (...args) => scrolls.push(args) },
    clearReplay() {}, settingsInline: null, outputFeed: null, outputPlayers: { pauseAll() {} }, activeDialog: null, notify() {},
    refreshOutputs: async () => loads.push('library'), refreshState: async () => loads.push('tasks'),
    loadSettings: async () => loads.push('settings'), loadCache: async () => {}, loadConsoleConfig: async () => {},
  });
  vm.runInContext(script.slice(script.indexOf('function navigate('), script.indexOf("document.querySelectorAll('[data-view]').forEach(button => button.addEventListener")), context);
  return { context, document, workspace, scrolls, pushes, loads };
}

test('switching tabs starts at the page heading while reselecting the current tab does not jump', () => {
  const h = navigationHarness();
  h.context.navigate('settings');
  assert.equal(h.document.body.dataset.view, 'settings'); assert.deepEqual(h.scrolls, [[0, 0]]);
  assert.equal(h.workspace.scrollTop, 0); h.workspace.scrollTop = 160;
  h.context.navigate('settings'); assert.equal(h.scrolls.length, 1);
  assert.equal(h.workspace.scrollTop, 160, 'reselecting preserves inner scroll');
  h.context.navigate('library'); assert.deepEqual(h.scrolls, [[0, 0], [0, 0]]);
  assert.equal(h.workspace.scrollTop, 0);
  assert.ok(h.loads.includes('settings')); assert.ok(h.loads.includes('library'));
});

test('history navigation and invalid routes also start the newly visible view at the top without adding history', () => {
  const h = navigationHarness();
  h.context.navigate('tasks', false); assert.equal(h.pushes.length, 0); assert.deepEqual(h.scrolls, [[0, 0]]);
  h.context.navigate('missing-view', false);
  assert.equal(h.document.body.dataset.view, 'replay'); assert.equal(h.pushes.length, 0); assert.equal(h.scrolls.length, 2);
});

function keyboardHarness(view) {
  const handlers = [], steps = [];
  let toggles = 0, prevented = 0;
  class HTMLElement { constructor(tag = '') { this.tag = tag; } matches(selector) { return selector.split(',').map(value => value.trim()).includes(this.tag); } }
  const document = { body: { dataset: { view } }, addEventListener: (_, handler) => handlers.push(handler) };
  const context = vm.createContext({ document, HTMLElement, activeDialog: null, $: () => ({ hidden: false }),
    stepReplay: seconds => steps.push(seconds), toggleReplayPlayback: () => toggles++,
  });
  const start = script.indexOf("document.addEventListener('keydown', event => {");
  vm.runInContext(script.slice(start, script.indexOf("$('export-range').addEventListener", start)), context);
  const key = (code, extras = {}) => handlers[0]({ code, target: {}, preventDefault() { prevented++; }, ...extras });
  return { context, steps, key, toggles: () => toggles, prevented: () => prevented, HTMLElement };
}

test('replay shortcuts cannot start hidden playback from library, tasks, settings or the signed-out screen', () => {
  for (const view of ['library', 'tasks', 'settings', undefined]) {
    const h = keyboardHarness(view);
    for (const code of ['Comma', 'Period', 'Space']) h.key(code);
    assert.equal(h.steps.length, 0); assert.equal(h.toggles(), 0); assert.equal(h.prevented(), 0);
  }
});

test('replay shortcuts still work and leave dialog, editable and modifier keys alone', () => {
  const h = keyboardHarness('replay');
  h.key('Comma'); h.key('Period'); h.key('Space');
  assert.deepEqual(h.steps, [-10, 10]); assert.equal(h.toggles(), 1); assert.equal(h.prevented(), 3);
  h.context.activeDialog = { open: true }; h.key('Comma'); h.context.activeDialog = null;
  const input = new h.HTMLElement(); input.matches = () => true; h.key('Period', { target: input });
  const editable = new h.HTMLElement(); editable.isContentEditable = true; h.key('Space', { target: editable });
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) h.key('Period', { [modifier]: true });
  assert.deepEqual(h.steps, [-10, 10]); assert.equal(h.toggles(), 1); assert.equal(h.prevented(), 3);
});


test('comma/period/space work from ordinary and role buttons and cancel native Space activation', () => {
  const h = keyboardHarness('replay');
  for (const tag of ['button', '[role="button"]']) {
    const target = new h.HTMLElement(tag);
    h.key('Comma', { target }); h.key('Period', { target });
    let nativeClickAllowed = true;
    h.key('Space', { target, preventDefault() { nativeClickAllowed = false; } });
    assert.equal(nativeClickAllowed, false);
  }
  assert.deepEqual(h.steps, [-10, 10, -10, 10]); assert.equal(h.toggles(), 2);
});
test('held shortcuts prevent browser defaults but perform one operation per physical press', () => {
  const h = keyboardHarness('replay'), target = new h.HTMLElement('button');
  for (const code of ['Comma', 'Period', 'Space']) {
    h.key(code, { target });
    for (let repeat = 0; repeat < 4; repeat++) h.key(code, { target, repeat: true });
  }
  assert.deepEqual(h.steps, [-10, 10]); assert.equal(h.toggles(), 1); assert.equal(h.prevented(), 15);
  h.key('Space', { target }); assert.equal(h.toggles(), 2);
});
test('all text entry controls, contenteditable, dialogs and composition retain native keyboard behavior', () => {
  const h = keyboardHarness('replay');
  for (const tag of ['input', 'textarea', 'select']) for (const code of ['Comma', 'Period', 'Space']) h.key(code, { target: new h.HTMLElement(tag) });
  const editable = new h.HTMLElement('div'); editable.isContentEditable = true;
  for (const code of ['Comma', 'Period', 'Space']) { h.key(code, { target: editable }); h.key(code, { isComposing: true }); }
  h.context.activeDialog = { open: true };
  for (const code of ['Comma', 'Period', 'Space']) h.key(code, { target: new h.HTMLElement('button') });
  assert.deepEqual(h.steps, []); assert.equal(h.toggles(), 0); assert.equal(h.prevented(), 0);
});


test('playback transport retains exactly ten-second jump buttons and keyboard shortcuts', () => {
  const css = fs.readFileSync(new URL('../public/console.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../lib/status-dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#skip-back,\s*#skip-forward \{[^}]*display: none/);
  assert.match(css, /#skip-back, #skip-forward \{ display: inline-flex/);
  assert.match(css, /#skip-back \{ grid-column: 1/);
  assert.match(css, /#skip-forward \{ grid-column: 3/);
  assert.match(html, /id="skip-back"/); assert.match(html, /id="skip-forward"/);
  const h = keyboardHarness('replay'); h.key('Comma'); h.key('Period'); h.key('Space');
  assert.deepEqual(h.steps, [-10, 10]); assert.equal(h.toggles(), 1);
});

test('desktop shortcuts share existing actions and honor local timeline handling', () => {
  const h = keyboardHarness('replay'), clicks = [], spans = [];
  h.context.$ = id => ({ hidden: false, disabled: false, click: () => clicks.push(id), focus: () => clicks.push('focus:' + id) });
  h.context.setTimelineSpan = value => spans.push(value);
  for (const key of ['ArrowLeft','ArrowRight','KeyI','KeyO','KeyF','KeyM','Escape','Digit1','Digit2','Digit3','Digit4']) h.key(key);
  assert.deepEqual(h.steps, [-10,10]);
  assert.deepEqual(clicks, ['mark-in','mark-out','replay-fullscreen','playback-mute','clear-marks']);
  assert.deepEqual(spans,[30,300,3600,86400]);
  h.key('ArrowLeft',{defaultPrevented:true});h.key('KeyI',{repeat:true});assert.equal(h.steps.length,2);assert.equal(clicks.length,5);
  h.context.document.body.dataset.view='library';h.key('Slash');assert.equal(clicks.at(-1),'focus:output-search');
});


test('Escape exits CSS fullscreen or pending entry without clearing marked range', () => {
  for (const mode of ['css', 'pending']) {
    const h = keyboardHarness('replay'); let exited=0, cleared=0;
    h.context.$ = id => ({hidden:false, disabled:false, classList:{contains: name => mode==='css' && name==='replay-expanded'}, click:()=>cleared++});
    h.context.replayFullscreenPending=mode==='pending'; h.context.leaveReplayFullscreen=()=>exited++;
    h.key('Escape'); assert.equal(exited,1); assert.equal(cleared,0);
  }
});
