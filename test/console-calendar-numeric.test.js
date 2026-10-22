import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountCalendar, isCalendarDate } from '../public/touch-controls.js';

class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
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
    const day = grid.children.find(node => node.attributes['aria-label'] === '2026-10-01');
    assert.equal(day.attributes['aria-pressed'], 'true');
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
    grid.children.find(node => node.attributes['aria-label'] === '2026-09-15').emit('click');
    assert.equal(input.value, '2026-09-15');
    wrap.children.at(-1).emit('click'); assert.equal(input.value, '2026-10-01');
    assert.deepEqual(selected, ['2026-09-15', '2026-10-01']);
  });
  assert.equal(isCalendarDate('20261001'), false);
  assert.equal(isCalendarDate('2026-10-01'), true);
});
