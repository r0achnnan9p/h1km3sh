import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportQueue } from '../lib/export-queue.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const task = id => ({ taskId: id, requestKey: id, controller: new AbortController() });
function setup() {
  const states = [];
  const settled = [];
  const queue = createExportQueue({ onState(t, status, queuePosition) {
    Object.assign(t, { status, queuePosition, progress: status === 'queued' ? null : 0 });
    states.push([t.taskId, status, queuePosition]);
  }, onSettled(t, error) { settled.push([t.taskId, Boolean(error)]); } });
  return { queue, states, settled };
}

test('FIFO has one owner, honest waiting positions, and request lookup', async () => {
  const { queue } = setup(), gate = deferred(), order = [];
  const a = task('a'), b = task('b'), c = task('c');
  const pa = queue.submit(a, async () => { order.push('a'); await gate.promise; });
  const pb = queue.submit(b, async () => order.push('b'));
  const pc = queue.submit(c, async () => order.push('c'));
  assert.equal(queue.find('b'), b);
  assert.equal(b.status, 'queued'); assert.equal(b.progress, null);
  assert.equal(b.queuePosition, 1); assert.equal(c.queuePosition, 2);
  await flush(); assert.deepEqual(order, ['a']);
  gate.resolve(); await Promise.all([pa, pb, pc]);
  assert.deepEqual(order, ['a', 'b', 'c']); assert.equal(queue.runningTask, null);
  assert.equal(queue.find('a'), null);
});

test('cancelling a queued entry never executes it and recomputes positions', async () => {
  const { queue } = setup(), gate = deferred(), order = [];
  const pa = queue.submit(task('a'), () => gate.promise);
  const b = task('b'), c = task('c');
  const pb = queue.submit(b, () => order.push('b'));
  const pc = queue.submit(c, () => order.push('c'));
  assert.equal(queue.cancel('b'), true);
  await assert.rejects(pb, /取消/);
  assert.equal(c.queuePosition, 1);
  assert.equal(queue.find('b'), null);
  gate.resolve(); await Promise.all([pa, pc]);
  assert.deepEqual(order, ['c']);
});

test('running cancellation and terminal progress retain lease until cleanup settles', async () => {
  const { queue } = setup(), cleanup = deferred(), order = [];
  const a = task('a');
  const pa = queue.submit(a, async () => { order.push('a'); await cleanup.promise; throw new Error('aborted'); });
  const pb = queue.submit(task('b'), () => order.push('b'));
  await flush(); queue.cancel('a'); a.status = 'error';
  assert.equal(a.controller.signal.aborted, true);
  await flush(); assert.deepEqual(order, ['a']); assert.equal(queue.owns('a'), true);
  cleanup.resolve(); await assert.rejects(pa, /aborted/); await pb;
  assert.deepEqual(order, ['a', 'b']);
});

test('sync throws and async rejections advance the queue', async () => {
  const { queue, settled } = setup();
  const pa = queue.submit(task('a'), () => { throw new Error('sync'); });
  const pb = queue.submit(task('b'), async () => { throw new Error('async'); });
  const pc = queue.submit(task('c'), async () => 'complete');
  await assert.rejects(pa, /sync/); await assert.rejects(pb, /async/);
  assert.equal(await pc, 'complete');
  assert.deepEqual(settled, [['a', true], ['b', true], ['c', false]]);
});

test('nested camera stages and final cleanup keep a single outer lease', async () => {
  const { queue } = setup(), cleanup = deferred(), order = [];
  const pa = queue.submit(task('camera'), async () => {
    order.push('stage1'); await Promise.resolve();
    assert.equal(queue.owns('camera'), true); order.push('stage2');
    await cleanup.promise; order.push('cleanup');
  });
  const pb = queue.submit(task('legacy'), () => order.push('legacy'));
  await flush(); assert.deepEqual(order, ['stage1', 'stage2']);
  cleanup.resolve(); await Promise.all([pa, pb]);
  assert.deepEqual(order, ['stage1', 'stage2', 'cleanup', 'legacy']);
});
