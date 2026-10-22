import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');
function editor() {
  const state = { date: '2026-10-08', playbackSource: 'mediamtx', selectedCamera: 'camera-a', configRevision: 'revision-1', playbackSelectionVersion: 3, cursorMs: 12000, inMs: 10000, outMs: 30000 };
  const actions = new Map(), input = { value: '12000', setAttribute() {}, focus() { this.focused = true; }, select() { this.selected = true; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const sheet = { content: {}, actions: {}, error: {}, close() { this.closed = true; }, setPending(value) { this.pending = value; } };
  const jumps = [];
  const context = vm.createContext({ state, openDialog: () => sheet, labelledInput: () => input, enhanceTimeInput: node => node,
    boundaryLabel: String, dateStart: () => 0, timelineLimit: () => 60000,
    rangeTimeMs(value) { if (!/^\d+$/.test(value)) throw new Error('时间格式无效'); return Number(value); },
    addButton(_parent, label, _className, action) { actions.set(label, action); }, openRangeEditor() { sheet.rangeOpened = true; },
    async jumpToTimelineTime(ms, source, options) { jumps.push({ ms, source, options }); state.cursorMs = ms; },
  });
  vm.runInContext(source.slice(source.indexOf('function playbackContextKey('), source.indexOf('function updateSelection(')), context);
  vm.runInContext(source.slice(source.indexOf('function openPlaybackTimeEditor()'), source.indexOf('function openRangeEditor(')), context);
  context.openPlaybackTimeEditor();
  return { state, input, sheet, jumps, actions };
}

test('精确定位只改变播放位置，保留入出点并按暂停状态调用同一预览入口', async () => {
  const h = editor(); h.input.value = '22000'; await h.actions.get('定位')();
  assert.equal(h.state.cursorMs, 22000);
  assert.deepEqual([h.state.inMs, h.state.outMs], [10000, 30000]);
  assert.equal(h.jumps.length, 1); assert.equal(h.jumps[0].options.autoplay, false); assert.equal(h.sheet.closed, true);
});

test('非法、未来及来源改变后的定位不发送媒体请求，也不改变已有选段', async () => {
  for (const scenario of ['invalid', 'future', 'source']) {
    const h = editor(); h.input.value = scenario === 'invalid' ? '坏时间' : scenario === 'future' ? '61000' : '22000';
    if (scenario === 'source') h.state.playbackSelectionVersion++;
    await h.actions.get('定位')();
    assert.equal(h.jumps.length, 0); assert.equal(h.state.cursorMs, 12000);
    assert.deepEqual([h.state.inMs, h.state.outMs], [10000, 30000]);
    assert.ok(h.sheet.error.textContent); assert.equal(h.sheet.closed, undefined);
  }
});

test('当前时间弹层保留编辑选段入口', () => {
  const h = editor(); h.actions.get('编辑选段')();
  assert.equal(h.sheet.closed, true); assert.equal(h.sheet.rangeOpened, true);
});

test('提交提示到期隐藏操作；键盘焦点停留时保留提示，点击只导航任务', () => {
  class Node {
    children = []; listeners = {}; classList = { toggle() {}, add() {}, remove() {} };
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute() {}
    contains(node) { return this.children.includes(node); }
  }
  const toast = new Node(), document = { activeElement: null, createElement: () => new Node() };
  const timers = [], routes = [], selectedTabs = [];
  const context = vm.createContext({ document, $: () => toast, toastTimer: null, iconSvg: () => '',
    setButtonIcon(button, _icon, label) { button.label = label; }, navigate: view => routes.push(view), selectTaskTab: upload => selectedTabs.push(upload),
    clearTimeout() {}, setTimeout(fn) { timers.push(fn); return timers.length; },
  });
  vm.runInContext(source.slice(source.indexOf('function openTaskPage('), source.indexOf('function selectTaskTab(')), context);
  vm.runInContext(source.slice(source.indexOf('function notify('), source.indexOf('async function api(')), context);
  context.notify('已提交', false, { kind: 'exports', range: '08:00:00 → 08:00:10' });
  const arrow = toast.children.find(node => node.label === '查看任务');
  document.activeElement = arrow; timers.shift()(); assert.equal(toast.hidden, false);
  document.activeElement = null; timers.shift()(); assert.equal(toast.hidden, true);
  context.notify('已提交', false, { kind: 'exports', range: '08:00:00 → 08:00:10' });
  toast.children.find(node => node.label === '查看任务').listeners.click();
  assert.deepEqual(routes, ['tasks']); assert.deepEqual(selectedTabs, [false]); assert.equal(toast.hidden, true);
});


test('精确定位弹层同步全选旧时间，直接覆盖时不会重新定位或改动入出点', () => {
  const h = editor();
  assert.equal(h.input.focused, true); assert.equal(h.input.selected, true);
  assert.equal(h.input.selectionStart, 0); assert.equal(h.input.selectionEnd, h.input.value.length);
  h.input.value = h.input.value.slice(0, h.input.selectionStart) + '22000' + h.input.value.slice(h.input.selectionEnd);
  assert.equal(h.input.value, '22000'); assert.equal(h.state.cursorMs, 12000);
  assert.deepEqual([h.state.inMs, h.state.outMs], [10000, 30000]); assert.equal(h.jumps.length, 0);
});
