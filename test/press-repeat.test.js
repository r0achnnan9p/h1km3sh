import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPressRepeat, bindKeyRepeat } from '../public/press-repeat.js';

class Target {
  listeners = new Map();
  addEventListener(name, listener, options) {
    const entries = this.listeners.get(name) || [];
    entries.push({ listener, capture: options === true || options?.capture === true });
    this.listeners.set(name, entries);
  }
  removeEventListener(name, listener, options) {
    const capture = options === true || options?.capture === true;
    const remaining = (this.listeners.get(name) || []).filter(entry => entry.listener !== listener || entry.capture !== capture);
    if (remaining.length) this.listeners.set(name, remaining);
    else this.listeners.delete(name);
  }
  emit(name, properties = {}) {
    const event = {
      target: this, button: 0, pointerId: 1, isPrimary: true, detail: 1,
      defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...properties,
    };
    const entries = [...(this.listeners.get(name) || [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const { listener } of entries) {
      listener(event);
      if (event.stopped) break;
    }
    return event;
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.length, 0); }
}

function clock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const pending = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!pending) break;
        timers.delete(pending[0]); now = pending[1].at; pending[1].callback();
      }
      now = end;
    },
    get pending() { return timers.size; },
  };
}

function harness(options = {}) {
  const timers = clock(), window = new Target(), document = new Target(), button = new Target();
  window.setTimeout = timers.setTimeout; window.clearTimeout = timers.clearTimeout;
  document.defaultView = window; document.hidden = false; button.ownerDocument = document; button.disabled = false;
  const captured = new Set(), captureCalls = [], context = { seconds: 0 };
  button.setPointerCapture = id => { captured.add(id); captureCalls.push(id); };
  button.hasPointerCapture = id => captured.has(id);
  button.releasePointerCapture = id => { captured.delete(id); button.emit('lostpointercapture', { pointerId: id }); };
  const calls = { starts: 0, repeats: [], commits: [], cancels: [], clicks: 0 };
  // Deliberately register the ordinary action first: hold suppression must win.
  button.addEventListener('click', () => { calls.clicks++; });
  const binding = bindPressRepeat(button, {
    onStart: () => { calls.starts++; return context; },
    onRepeat: value => { value.seconds += 10; calls.repeats.push(value); },
    onCommit: value => calls.commits.push(value),
    onCancel: (value, reason) => calls.cancels.push({ value, reason }),
    ...options,
  });
  return { timers, window, document, button, captured, captureCalls, context, calls, binding,
    down: properties => button.emit('pointerdown', properties),
    up: properties => document.emit('pointerup', properties),
    click: properties => button.emit('click', properties),
  };
}

test('a short press preserves the existing click and never starts or captures a hold', () => {
  const h = harness(); h.down(); h.timers.advance(349); h.up();
  const event = h.click(); h.timers.advance(1000);
  assert.equal(h.calls.clicks, 1); assert.equal(event.defaultPrevented, false);
  assert.equal(h.calls.starts, 0); assert.deepEqual(h.calls.commits, []); assert.deepEqual(h.calls.cancels, []);
  assert.deepEqual(h.captureCalls, []); assert.equal(h.timers.pending, 0);
});

test('holding repeats local changes at the threshold and interval, then commits exactly once', () => {
  const h = harness(); h.down(); h.timers.advance(350);
  assert.equal(h.calls.starts, 1); assert.equal(h.context.seconds, 10); assert.equal(h.calls.commits.length, 0);
  h.timers.advance(359); assert.equal(h.context.seconds, 20);
  h.timers.advance(1); assert.equal(h.context.seconds, 30);
  assert.ok(h.calls.repeats.every(value => value === h.context));
  h.up(); h.up(); h.timers.advance(5000);
  assert.deepEqual(h.calls.commits, [h.context]); assert.deepEqual(h.calls.cancels, []);
  assert.equal(h.context.seconds, 30); assert.equal(h.captured.size, 0); assert.equal(h.timers.pending, 0);
  const event = h.click(); assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true); assert.equal(h.calls.clicks, 0);
});

test('the hold click is suppressed without swallowing keyboard, programmatic or later short clicks', () => {
  const h = harness(); h.down(); h.timers.advance(350); h.up();
  assert.equal(h.click({ detail: 0 }).defaultPrevented, false); assert.equal(h.calls.clicks, 1);
  assert.equal(h.click().defaultPrevented, true); assert.equal(h.calls.clicks, 1);
  h.down(); h.timers.advance(100); h.up(); assert.equal(h.click().defaultPrevented, false); assert.equal(h.calls.clicks, 2);
  // A browser may omit a cancelled hold's click entirely.
  h.down(); h.timers.advance(350); h.binding.cancel();
  h.down(); h.up(); h.click(); assert.equal(h.calls.clicks, 3);
});

test('pointer cancellation stops repeats, cancels once and suppresses any trailing pointer click', () => {
  const h = harness(); h.down(); h.timers.advance(350);
  h.document.emit('pointercancel'); h.up(); h.document.emit('pointercancel'); h.timers.advance(3000);
  assert.deepEqual(h.calls.cancels, [{ value: h.context, reason: 'pointercancel' }]); assert.deepEqual(h.calls.commits, []);
  assert.equal(h.context.seconds, 10); assert.equal(h.timers.pending, 0); assert.equal(h.captured.size, 0);
  assert.equal(h.click().defaultPrevented, true);
});

test('capture transferred from a descendant does not cancel the hold; losing button capture does', () => {
  const h = harness(); h.down(); h.timers.advance(350);
  h.button.emit('lostpointercapture', { target: new Target() }); h.timers.advance(180);
  assert.equal(h.context.seconds, 20); assert.deepEqual(h.calls.cancels, []);
  h.button.emit('lostpointercapture'); h.timers.advance(1000); h.up();
  assert.deepEqual(h.calls.cancels, [{ value: h.context, reason: 'lostpointercapture' }]);
  assert.deepEqual(h.calls.commits, []); assert.equal(h.timers.pending, 0);
});

test('blur and page hiding cancel both armed and repeating presses without a commit', () => {
  for (const hidden of [false, true]) for (const started of [false, true]) {
    const h = harness(); h.down(); h.timers.advance(started ? 350 : 100);
    if (hidden) { h.document.hidden = true; h.document.emit('visibilitychange'); }
    else h.window.emit('blur');
    h.timers.advance(3000); h.up();
    assert.equal(h.timers.pending, 0); assert.deepEqual(h.calls.commits, []);
    assert.deepEqual(h.calls.cancels, started ? [{ value: h.context, reason: hidden ? 'hidden' : 'blur' }] : []);
  }
});

test('disabled buttons, nonprimary pointers and non-left mouse buttons cannot arm a hold', () => {
  for (const mode of ['disabled', 'aria-disabled', 'hidden', 'secondary-pointer', 'right-button']) {
    const h = harness();
    if (mode === 'disabled') h.button.disabled = true;
    if (mode === 'aria-disabled') h.button.getAttribute = name => name === 'aria-disabled' ? 'true' : null;
    if (mode === 'hidden') h.document.hidden = true;
    h.down({ isPrimary: mode !== 'secondary-pointer', button: mode === 'right-button' ? 2 : 0 }); h.timers.advance(1000); h.up();
    assert.equal(h.calls.starts, 0, mode); assert.equal(h.timers.pending, 0, mode);
  }
});

test('becoming disabled before the threshold or release cancels rather than commits', () => {
  for (const started of [false, true]) for (const releaseFirst of [false, true]) {
    const h = harness(); h.down(); h.timers.advance(started ? 350 : 100); h.button.disabled = true;
    if (releaseFirst) h.up();
    h.timers.advance(3000); h.up();
    assert.deepEqual(h.calls.commits, []);
    assert.equal(h.calls.starts, started ? 1 : 0); assert.equal(h.context.seconds, started ? 10 : 0);
    assert.deepEqual(h.calls.cancels, started ? [{ value: h.context, reason: 'unavailable' }] : []);
    assert.equal(h.timers.pending, 0);
  }
});

test('another pointer cannot replace, release or cancel the owning gesture', () => {
  const h = harness(); h.down(); h.timers.advance(350);
  h.down({ pointerId: 2, isPrimary: false }); h.up({ pointerId: 2 });
  h.document.emit('pointercancel', { pointerId: 2 }); h.button.emit('lostpointercapture', { pointerId: 2 });
  h.timers.advance(180); assert.equal(h.context.seconds, 20); assert.equal(h.calls.starts, 1);
  assert.deepEqual(h.calls.cancels, []); assert.deepEqual(h.calls.commits, []);
  h.up(); assert.deepEqual(h.calls.commits, [h.context]);
});

test('leaving before the threshold disarms; an active hold blocks the native context menu', () => {
  const h = harness(); h.down(); h.button.emit('pointerleave'); h.timers.advance(1000);
  assert.equal(h.calls.starts, 0); assert.equal(h.timers.pending, 0);
  assert.equal(h.button.emit('contextmenu').defaultPrevented, false);
  h.down(); h.timers.advance(350); assert.equal(h.button.emit('contextmenu').defaultPrevented, true);
  h.up(); assert.equal(h.button.emit('contextmenu').defaultPrevented, false);
});

test('document release settles a hold even when pointer capture is unsupported', () => {
  const h = harness(); h.button.setPointerCapture = () => { throw new Error('not supported'); };
  h.down(); h.timers.advance(350); h.up({ target: new Target() });
  assert.deepEqual(h.calls.commits, [h.context]); assert.equal(h.timers.pending, 0);
});

test('external cancellation is idempotent and a callback can cancel without rescheduling', () => {
  const h = harness(); h.down(); h.timers.advance(350);
  assert.equal(h.binding.cancel('source-changed'), true); assert.equal(h.binding.cancel('again'), false);
  h.up(); h.timers.advance(1000);
  assert.deepEqual(h.calls.cancels, [{ value: h.context, reason: 'source-changed' }]); assert.deepEqual(h.calls.commits, []);
  let binding, repeats = 0, cancels = 0;
  const other = harness({ onRepeat() { repeats++; binding.cancel('boundary'); }, onCancel() { cancels++; } }); binding = other.binding;
  other.down(); other.timers.advance(5000);
  assert.equal(repeats, 1); assert.equal(cancels, 1); assert.equal(other.timers.pending, 0);
});

test('cancelling an armed press prevents a late click from acting on a changed source', () => {
  const h = harness(); h.down(); h.timers.advance(100); h.binding.cancel('source-changed');
  h.up(); h.timers.advance(1000);
  assert.equal(h.click().defaultPrevented, true); assert.equal(h.calls.clicks, 0);
  assert.equal(h.calls.starts, 0); assert.deepEqual(h.calls.cancels, []); assert.equal(h.timers.pending, 0);
  h.down(); h.up(); h.click(); assert.equal(h.calls.clicks, 1);
});

test('destroy clears timers, capture and listeners, including when a hold is active', () => {
  for (const started of [false, true]) {
    const h = harness(); h.down(); h.timers.advance(started ? 350 : 100);
    h.binding.destroy(); h.binding.destroy(); h.timers.advance(3000); h.up();
    assert.equal(h.timers.pending, 0); assert.equal(h.captured.size, 0);
    assert.equal(h.document.listenerCount, 0); assert.equal(h.window.listenerCount, 0); assert.equal(h.button.listenerCount, 1);
    assert.deepEqual(h.calls.commits, []); assert.deepEqual(h.calls.cancels, started ? [{ value: h.context, reason: 'destroyed' }] : []);
    h.down(); h.timers.advance(1000); h.click(); assert.equal(h.calls.clicks, 1);
  }
});

test('a repeat callback failure releases ownership and never leaves a background timer', () => {
  const h = harness({ onRepeat() { throw new Error('repeat failed'); } }); h.down();
  assert.throws(() => h.timers.advance(350), /repeat failed/);
  assert.deepEqual(h.calls.cancels, [{ value: h.context, reason: 'callback-error' }]);
  assert.equal(h.timers.pending, 0); assert.equal(h.captured.size, 0); h.up(); assert.deepEqual(h.calls.commits, []);
});

test('a failed start also stops the timer and suppresses its trailing click', () => {
  const h = harness({ onStart() { throw new Error('start failed'); } }); h.down();
  assert.throws(() => h.timers.advance(350), /start failed/);
  assert.equal(h.timers.pending, 0); assert.equal(h.captured.size, 0);
  h.up(); assert.equal(h.click().defaultPrevented, true); assert.deepEqual(h.calls.commits, []);
});

test('custom timings work, while invalid intervals cannot create an unbounded timer loop', () => {
  const h = harness({ delay: 20, interval: 10 }); h.down(); h.timers.advance(19); assert.equal(h.context.seconds, 0);
  h.timers.advance(21); assert.equal(h.context.seconds, 30); h.up();
  for (const timing of [{ delay: -1 }, { delay: NaN }, { interval: 0 }, { interval: Infinity }]) {
    assert.throws(() => bindPressRepeat(new Target(), timing), TypeError);
  }
});

function keyHarness(options = {}) {
  const timers = clock(), document = new Target(), window = new Target();
  document.defaultView = window; document.hidden = false;
  window.setTimeout = timers.setTimeout; window.clearTimeout = timers.clearTimeout;
  const calls = { starts: [], repeats: [], commits: [], cancels: [] }, context = { steps: 0 };
  const binding = bindKeyRepeat(document, {
    resolve: event => event.code === 'Comma' ? -10 : event.code === 'Period' ? 10 : null,
    canStart: () => options.allowed !== false,
    canContinue: () => options.blocked !== true,
    onStart: action => { calls.starts.push(action); return context; },
    onRepeat: (value, action) => { value.steps += action; calls.repeats.push(action); },
    onCommit: (value, action) => calls.commits.push([action, value.steps]),
    onCancel: (value, action, reason) => calls.cancels.push({ action, reason }),
    ...options,
  });
  const event = (code, properties = {}) => ({ code, key: code, target: {}, ...properties });
  return { timers, document, window, calls, context, binding, options,
    down: (code = 'Comma', properties) => document.emit('keydown', event(code, properties)),
    up: (code = 'Comma', properties) => document.emit('keyup', event(code, properties)),
  };
}

test('keyboard shortcuts start immediately, repeat on their own clock and commit once on keyup', () => {
  const h = keyHarness(); const event = h.down();
  assert.equal(event.defaultPrevented, true); assert.deepEqual(h.calls.repeats, [-10]); assert.equal(h.context.steps, -10);
  h.timers.advance(349); assert.deepEqual(h.calls.repeats, [-10]);
  h.timers.advance(1); assert.deepEqual(h.calls.repeats, [-10, -10]); assert.equal(h.context.steps, -20);
  h.timers.advance(180); assert.deepEqual(h.calls.repeats, [-10, -10, -10]);
  // Native key repeat must not add a second gesture or another step.
  h.down('Comma', { repeat: true }); h.timers.advance(180); assert.deepEqual(h.calls.repeats, [-10, -10, -10, -10]);
  h.up(); h.up(); h.timers.advance(5000);
  assert.deepEqual(h.calls.commits, [[-10, -40]]); assert.equal(h.timers.pending, 0);
});

test('a different keyup cannot settle the active hold, and canStart blocks without preventing the browser', () => {
  const h = keyHarness(); h.down('Period'); h.up('Comma');
  assert.deepEqual(h.calls.commits, []); h.up('Period'); assert.deepEqual(h.calls.commits, [[10, 10]]);
  const blocked = keyHarness({ allowed: false }), event = blocked.down();
  assert.equal(event.defaultPrevented, false); assert.deepEqual(blocked.calls.starts, []); assert.equal(blocked.timers.pending, 0);
  assert.equal(blocked.down('Comma', { repeat: true }).defaultPrevented, false);
  assert.equal(keyHarness().down('KeyI').defaultPrevented, false);
});

test('blur, page hiding and destroy abandon an active hold without committing', () => {
  const blurred = keyHarness(); blurred.down(); blurred.window.emit('blur');
  assert.deepEqual(blurred.calls.cancels, [{ action: -10, reason: 'blur' }]); assert.equal(blurred.timers.pending, 0);
  blurred.up(); assert.deepEqual(blurred.calls.commits, []);
  const hidden = keyHarness(); hidden.down('Period'); hidden.document.hidden = true; hidden.document.emit('visibilitychange');
  assert.deepEqual(hidden.calls.cancels, [{ action: 10, reason: 'hidden' }]); assert.equal(hidden.timers.pending, 0);
  const destroyed = keyHarness(); destroyed.down(); destroyed.binding.destroy(); destroyed.binding.destroy();
  assert.deepEqual(destroyed.calls.cancels, [{ action: -10, reason: 'destroyed' }]);
  assert.equal(destroyed.document.listenerCount, 0); assert.equal(destroyed.window.listenerCount, 0);
});

test('keyboard repeat callback failures release ownership and leave no timer behind', () => {
  const h = keyHarness({ onRepeat() { throw new Error('key repeat failed'); } });
  assert.throws(() => h.down(), /key repeat failed/);
  assert.deepEqual(h.calls.cancels, [{ action: -10, reason: 'callback-error' }]);
  assert.equal(h.timers.pending, 0);
});

test('focus in a text field, IME composition or a blocked dialog abandons a held shortcut before keyup', () => {
  const focused = keyHarness(); focused.down();
  focused.document.emit('focusin', { target: { matches: selector => selector.includes('input') } });
  assert.deepEqual(focused.calls.cancels, [{ action: -10, reason: 'focus' }]);
  assert.equal(focused.timers.pending, 0);
  focused.up(); assert.deepEqual(focused.calls.commits, []);

  const composing = keyHarness(); composing.down('Period');
  composing.document.emit('compositionstart', { target: {} });
  assert.deepEqual(composing.calls.cancels, [{ action: 10, reason: 'composition' }]);
  composing.up('Period'); assert.deepEqual(composing.calls.commits, []);

  const dialog = keyHarness(); dialog.down(); dialog.options.blocked = true;
  dialog.document.emit('focusin', { target: { matches: () => false } });
  assert.deepEqual(dialog.calls.cancels, [{ action: -10, reason: 'blocked' }]);
  dialog.up(); assert.deepEqual(dialog.calls.commits, []);

  const tick = keyHarness(); tick.down(); tick.options.blocked = true;
  tick.timers.advance(350);
  assert.deepEqual(tick.calls.cancels, [{ action: -10, reason: 'blocked' }]);
  assert.deepEqual(tick.calls.repeats, [-10]); assert.equal(tick.timers.pending, 0);
  tick.up(); assert.deepEqual(tick.calls.commits, []);

  const released = keyHarness(); released.down(); released.options.blocked = true; released.up();
  assert.deepEqual(released.calls.cancels, [{ action: -10, reason: 'blocked' }]);
  assert.deepEqual(released.calls.commits, []);
});
