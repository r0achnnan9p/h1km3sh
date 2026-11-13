import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountCalendar, isCalendarDate } from '../public/touch-controls.js';

class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  focus() { this.focused = true; }
  get days() { return this.children.flatMap(row => row.children.flatMap(cell => cell.children)); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  emit(type, event = {}) { this.listeners[type]?.(event); }
}

function withCalendar(action) {
  const original = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  try {
    const selected = [];
    const wrap = mountCalendar(new Element(), { value: '2026-09-30', today: () => '2026-10-01', onSelect: value => selected.push(value) });
    const input = wrap.children[0].children[1], bar = wrap.children[1], grid = wrap.children[3], error = wrap.children[4];
    action({ wrap, input, grid, error, selected, month: bar.children[1] });
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
}

test('numeric keypad date input accepts eight digits and emits canonical YYYY-MM-DD on change', () => {
  withCalendar(({ input, selected, error, month, grid }) => {
    assert.equal(input.inputMode, 'numeric'); assert.equal(input.maxLength, 10);
    assert.match(input.placeholder, /20260930/);
    input.value = '20261001'; input.emit('change');
    assert.deepEqual(selected, ['2026-10-01']); assert.equal(input.value, '2026-10-01'); assert.equal(error.textContent, '');
    assert.equal(month.textContent, '2026 年 10 月');
    const day = grid.days.find(node => node.attributes['aria-label'] === '2026-10-01');
    assert.equal(grid.children.flatMap(row => row.children).find(cell => cell.children.includes(day)).attributes['aria-selected'], 'true');
  });
});

test('Enter supports valid compact leap dates and existing hyphenated date input', () => {
  withCalendar(({ input, selected }) => {
    let prevented = 0;
    for (const [typed, expected] of [['20240229', '2024-02-29'], ['2026-12-31', '2026-12-31']]) {
      input.value = typed; input.emit('keydown', { key: 'Enter', preventDefault() { prevented++; } });
      assert.equal(selected.at(-1), expected); assert.equal(input.value, expected);
    }
    assert.equal(prevented, 2); assert.equal(selected.length, 2);
  });
});

test('invalid compact, incomplete and invalid hyphenated dates retain typed input without changing selection', () => {
  withCalendar(({ input, selected, error, month }) => {
    for (const value of ['20260229', '20260931', '20261301', '20260001', '20261000', '2026101', '202610011', '2026-02-29', '2026-1-1', '', 'abcdefgh']) {
      input.value = value; input.emit('change');
      assert.equal(selected.length, 0, value); assert.equal(input.value, value);
      assert.match(error.textContent, /有效日期/); assert.equal(month.textContent, '2026 年 9 月');
    }
    input.value = '20261001'; input.emit('change');
    assert.equal(error.textContent, ''); assert.deepEqual(selected, ['2026-10-01']);
  });
});

test('calendar day buttons and today retain canonical selection; core calendar validation stays strict', () => {
  withCalendar(({ wrap, input, grid, selected }) => {
    grid.days.find(node => node.attributes['aria-label'] === '2026-09-15').emit('click');
    assert.equal(input.value, '2026-09-15');
    wrap.children.at(-1).emit('click'); assert.equal(input.value, '2026-10-01');
    assert.deepEqual(selected, ['2026-09-15', '2026-10-01']);
  });
  assert.equal(isCalendarDate('20261001'), false);
  assert.equal(isCalendarDate('2026-10-01'), true);
});

test('calendar candidates stay unsubmitted, including Safari Enter delivered just after compositionend', () => {
  withCalendar(({ input, selected }) => {
    input.value = '20240229';
    const enter = (timeStamp, extra) => input.emit('keydown', { key: 'Enter', timeStamp, preventDefault() {}, ...extra });
    enter(500, { isComposing: true }); enter(510, { keyCode: 229 });
    input.emit('compositionstart'); enter(515); input.emit('compositionend', { timeStamp: 520 });
    enter(519); enter(522);
    assert.deepEqual(selected, []);
    enter(1000);
    assert.deepEqual(selected, ['2024-02-29']);
  });
});

test('calendar has one tab stop; arrows and Page keys cross months without committing a date', () => {
  withCalendar(({ grid, selected, month, input }) => {
    const current = () => {
      const stops = grid.days.filter(day => day.tabIndex === 0);
      assert.equal(stops.length, 1);
      return stops[0];
    };
    function press(key, nextDate) {
      grid.emit('keydown', { key, target: current(), preventDefault() {} });
      assert.equal(current().getAttribute('aria-label'), nextDate);
      assert.equal(current().focused, true);
    }
    assert.equal(grid.getAttribute('role'), 'grid');
    assert.equal(current().getAttribute('aria-label'), '2026-09-30');
    press('ArrowRight', '2026-10-01'); press('Home', '2026-09-28'); press('End', '2026-10-04');
    press('ArrowUp', '2026-09-27'); press('ArrowDown', '2026-10-04');
    assert.deepEqual(selected, []);
    input.value = '20240131'; input.emit('change');
    press('PageDown', '2024-02-29'); press('PageUp', '2024-01-29');
    assert.equal(month.textContent, '2024 年 1 月');
    assert.deepEqual(selected, ['2024-01-31']);
    grid.emit('keydown', { key: 'ArrowDown', altKey: true, target: current(), preventDefault() { assert.fail(); } });
    assert.equal(current().getAttribute('aria-label'), '2024-01-29');
  });
});
