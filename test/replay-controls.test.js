import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayControls } from '../public/replay-controls.js';

function clock() {
  let now = 0, next = 0;
  const timers = new Map(), callbacks = [];
  return {
    setTimer(callback, delay) {
      const id = ++next;
      callbacks.push(callback);
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = end;
    },
    get pending() { return timers.size; },
    get lastCallback() { return callbacks.at(-1); },
  };
}
function harness(options = {}) {
  const timers = clock(), visibility = [], modes = [];
  const controls = createReplayControls({
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onVisibilityChange: value => visibility.push(value),
    onModeChange: value => modes.push(value),
    ...options,
  });
  return { controls, timers, visibility, modes };
}

test('controls start in select mode and stay visible until auto-hide is enabled', () => {
  const h = harness();
  assert.equal(h.controls.mode, 'select');
  assert.equal(h.controls.visible, true);
  h.timers.advance(10000);
  assert.equal(h.timers.pending, 0);
  assert.deepEqual(h.visibility, []);
  h.controls.setEnabled(true);
  h.timers.advance(2499); assert.equal(h.controls.visible, true);
  h.timers.advance(1); assert.equal(h.controls.visible, false);
  assert.deepEqual(h.visibility, [false]);
  assert.equal(h.timers.pending, 0);
});

test('watch and select modes both auto-hide; mode changes only notify local presentation', () => {
  const h = harness(); h.controls.setEnabled(true);
  h.timers.advance(2500); assert.equal(h.controls.visible, false);
  assert.equal(h.controls.setMode('watch'), true);
  assert.equal(h.controls.visible, true); assert.equal(h.controls.mode, 'watch');
  h.timers.advance(2500); assert.equal(h.controls.visible, false);
  h.controls.setMode('select');
  h.timers.advance(2500); assert.equal(h.controls.visible, false);
  assert.deepEqual(h.modes, ['watch', 'select']);
  assert.deepEqual(h.visibility, [false, true, false, true, false]);
  assert.equal(h.controls.setMode('select'), false);
  assert.throws(() => h.controls.setMode('unknown'), TypeError);
});

test('pointer or keyboard activity wakes the panel and gives a full fresh idle period', () => {
  const h = harness(); h.controls.setEnabled(true);
  h.timers.advance(2000); h.controls.show();
  h.timers.advance(2499); assert.equal(h.controls.visible, true);
  h.timers.advance(1); assert.equal(h.controls.visible, false);
  assert.equal(h.controls.show(), true);
  assert.equal(h.controls.consumeClick({ detail: 0 }), false);
  assert.equal(h.timers.pending, 1);
  h.timers.advance(2500); assert.equal(h.controls.visible, false);
});

test('a hidden panel consumes its wake tap including pointerup and the trailing click', () => {
  const h = harness(); h.controls.setEnabled(true); h.timers.advance(2500);
  assert.equal(h.controls.pointerDown({ pointerId: 7 }), true);
  assert.equal(h.controls.visible, true);
  h.timers.advance(10000); assert.equal(h.controls.visible, true);
  assert.equal(h.controls.pointerUp({ pointerId: 7 }), true);
  assert.equal(h.controls.consumeClick({ detail: 1, pointerId: 7 }), true);
  assert.equal(h.controls.consumeClick({ detail: 1, pointerId: 7 }), false);
  h.timers.advance(2499); assert.equal(h.controls.visible, true);
  h.timers.advance(1); assert.equal(h.controls.visible, false);
});

test('a visible control still responds to one tap and a held pointer cannot disappear', () => {
  const h = harness(); h.controls.setEnabled(true);
  assert.equal(h.controls.pointerDown({ pointerId: 3 }), false);
  h.timers.advance(10000); assert.equal(h.controls.visible, true);
  assert.equal(h.controls.pointerUp({ pointerId: 3 }), false);
  assert.equal(h.controls.consumeClick({ detail: 1, pointerId: 3 }), false);
  h.timers.advance(2500); assert.equal(h.controls.visible, false);
});

test('an omitted wake click never swallows the next genuine pointer gesture', () => {
  for (const nextId of [7, 8]) {
    const h = harness(); h.controls.setEnabled(true); h.timers.advance(2500);
    h.controls.pointerDown({ pointerId: 7 }); h.controls.pointerUp({ pointerId: 7 });
    assert.equal(h.controls.consumeClick({ detail: 0 }), false, 'keyboard access remains available');
    assert.equal(h.controls.pointerDown({ pointerId: nextId }), false);
    assert.equal(h.controls.pointerUp({ pointerId: nextId }), false);
    assert.equal(h.controls.consumeClick({ detail: 1, pointerId: nextId }), false);
  }
});

test('a fresh tap in portrait remains actionable after a cancelled landscape press', () => {
  const h = harness(); h.controls.setEnabled(true);
  h.controls.pointerDown({ pointerId: 7 });
  h.controls.setEnabled(false); h.controls.reset();
  h.controls.pointerUp({ pointerId: 7 });
  assert.equal(h.controls.pointerDown({ pointerId: 7 }), false);
  assert.equal(h.controls.pointerUp({ pointerId: 7 }), false);
  assert.equal(h.controls.consumeClick({ detail: 1, pointerId: 7 }), false);
  assert.equal(h.timers.pending, 0);
});

test('pointer cancellation cannot activate a control through a late click', () => {
  const h = harness(); h.controls.setEnabled(true);
  h.controls.pointerDown({ pointerId: 5 });
  assert.equal(h.controls.pointerUp({ type: 'pointercancel', pointerId: 5 }), true);
  assert.equal(h.controls.consumeClick({ detail: 0 }), false);
  assert.equal(h.controls.consumeClick({ detail: 1, pointerId: 5 }), true);
  h.timers.advance(2500); assert.equal(h.controls.visible, false);
});

test('secondary and non-left pointers cannot arm or release the owning wake gesture', () => {
  const h = harness(); h.controls.setEnabled(true); h.timers.advance(2500);
  assert.equal(h.controls.pointerDown({ pointerId: 1, button: 2 }), false);
  assert.equal(h.controls.pointerDown({ pointerId: 2, isPrimary: false }), false);
  assert.equal(h.controls.visible, false);
  h.controls.pointerDown({ pointerId: 1 });
  assert.equal(h.controls.pointerUp({ pointerId: 2 }), false);
  assert.equal(h.controls.consumeClick({ detail: 1, pointerId: 2 }), false);
  h.timers.advance(5000); assert.equal(h.controls.visible, true);
  h.controls.pointerUp({ pointerId: 1 });
  assert.equal(h.controls.consumeClick({ detail: 1 }), true, 'MouseEvent fallback also consumes the wake click');
});

test('explicit drag, held-seek and focus guards are independent and release starts a full delay', () => {
  const h = harness(); h.controls.setEnabled(true);
  h.controls.hold('drag'); h.controls.hold('held-seek'); h.controls.hold('editable');
  assert.equal(h.controls.hold('editable'), false);
  h.timers.advance(10000); assert.equal(h.controls.visible, true); assert.equal(h.timers.pending, 0);
  h.controls.release('drag'); h.controls.release('held-seek');
  assert.equal(h.controls.release('other'), false);
  h.timers.advance(10000); assert.equal(h.controls.visible, true); assert.equal(h.timers.pending, 0);
  h.controls.release('editable');
  h.timers.advance(2499); assert.equal(h.controls.visible, true);
  h.timers.advance(1); assert.equal(h.controls.visible, false);
});

test('the current modal or focus predicate blocks hiding and is retried without extra DOM events', () => {
  let blocked = false;
  const h = harness({ canHide: () => !blocked }); h.controls.setEnabled(true);
  h.timers.advance(2400); blocked = true;
  h.timers.advance(5100); assert.equal(h.controls.visible, true); assert.equal(h.timers.pending, 1);
  blocked = false;
  h.timers.advance(2499); assert.equal(h.controls.visible, true);
  h.timers.advance(1); assert.equal(h.controls.visible, false); assert.equal(h.timers.pending, 0);
});

test('disabling restores visibility and preserves guards across an orientation change', () => {
  const h = harness(); h.controls.setEnabled(true); h.timers.advance(2500);
  h.controls.setEnabled(false); assert.equal(h.controls.visible, true); assert.equal(h.timers.pending, 0);
  h.controls.hold('modal'); h.controls.setEnabled(true);
  h.timers.advance(10000); assert.equal(h.controls.visible, true); assert.equal(h.timers.pending, 0);
  h.controls.release('modal'); h.timers.advance(2500); assert.equal(h.controls.visible, false);
});

test('context reset clears holds and pointers but consumes a cancelled press instead of resurrecting it', () => {
  for (const hidden of [false, true]) {
    const h = harness(); h.controls.setEnabled(true);
    if (hidden) h.timers.advance(2500);
    h.controls.pointerDown({ pointerId: 4 }); h.controls.hold('drag');
    h.controls.setEnabled(false); h.controls.reset();
    assert.equal(h.controls.visible, true); assert.equal(h.timers.pending, 0);
    assert.equal(h.controls.pointerUp({ pointerId: 4 }), true);
    assert.equal(h.controls.consumeClick({ detail: 1, pointerId: 4 }), true);
    assert.equal(h.timers.pending, 0);
    h.controls.setEnabled(true); h.timers.advance(2500); assert.equal(h.controls.visible, false);
  }
});

test('already-queued callbacks cannot hide a new context, a disabled panel or a destroyed controller', () => {
  for (const action of ['reset', 'disable', 'destroy']) {
    const h = harness(); h.controls.setEnabled(true);
    const stale = h.timers.lastCallback;
    if (action === 'disable') h.controls.setEnabled(false);
    else h.controls[action]();
    stale(); assert.equal(h.controls.visible, true, action);
    assert.equal(h.timers.pending, action === 'reset' ? 1 : 0, action);
  }
});

test('destroy is idempotent, restores the panel and prevents timers or callbacks from returning', () => {
  const h = harness(); h.controls.setEnabled(true); h.timers.advance(2500);
  h.controls.destroy(); h.controls.destroy();
  h.controls.show(); h.controls.setEnabled(true); h.controls.setMode('watch');
  h.controls.hold('drag'); h.controls.release('drag'); h.controls.reset();
  h.controls.pointerDown(); h.controls.pointerUp();
  h.timers.advance(10000);
  assert.equal(h.controls.consumeClick(), false);
  assert.equal(h.controls.visible, true); assert.equal(h.controls.mode, 'select');
  assert.equal(h.timers.pending, 0); assert.deepEqual(h.visibility, [false, true]);
});

test('invalid idle timing cannot schedule an unbounded retry loop', () => {
  for (const delay of [0, -1, NaN, Infinity]) {
    assert.throws(() => createReplayControls({ delay }), TypeError);
  }
});
