import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrecisionTimeline } from '../public/precision-timeline.js';

function fixture({ span = 86_400_000, time = 43_200_000, start = 0, end = 86_399_000, width = 360, clientWidth = width } = {}) {
  const listeners = new Map(), events = [], commits = [], captures = new Set();
  let context = 'camera-a/day-a';
  const element = {
    clientWidth,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    getBoundingClientRect: () => ({ left: 10, width }),
    setPointerCapture(id) { captures.add(id); },
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture(id) { captures.delete(id); listeners.get('lostpointercapture')?.({ pointerId: id }); },
  };
  const api = createPrecisionTimeline({
    element, getTime: () => time, getBounds: () => ({ start, end }), getSpan: () => span, getContext: () => context,
    onStart: () => events.push({ type: 'start' }),
    onMove(data) { time = data.time; events.push({ type: 'move', ...data }); },
    onCommit(value) { commits.push(value); },
    onCancel(data) { if (data.restore) time = data.time; events.push({ type: 'cancel', ...data }); },
  });
  const emit = (name, data = {}) => {
    const event = { pointerId: 1, button: 0, isPrimary: true, clientX: 10 + width / 2, clientY: 400,
      prevented: false, preventDefault() { this.prevented = true; }, ...data };
    listeners.get(name)?.(event); return event;
  };
  return { api, emit, events, commits, captures, listeners, time: () => time,
    setSpan: value => span = value, setContext: value => context = value, setTime: value => time = value };
}

const settle = () => Promise.resolve();

test('全天点按按00–24的绝对位置定位，1px抖动和松手坐标不会改写候选', async () => {
  const h = fixture(); h.emit('pointerdown', { clientX: 100 });
  h.emit('pointermove', { clientX: 101 }); assert.equal(h.events.length, 0);
  h.emit('pointerup', { clientX: 300 }); await settle();
  assert.deepEqual(h.commits, [21_600_000]); assert.equal(h.time(), 21_600_000);
  assert.equal(h.events.filter(event => event.type === 'start').length, 1);
  assert.equal(h.captures.size, 0);
});

test('全天横拖实时粗选，整秒提交最后预览一次且不读取松手位置', async () => {
  const h = fixture(); h.emit('pointerdown', { clientX: 100 });
  h.emit('pointermove', { clientX: 190 }); assert.equal(h.time(), 43_200_000);
  h.emit('pointermove', { clientX: 201.25 }); const shown = h.time();
  assert.equal(shown % 1000, 0); assert.equal(h.commits.length, 0);
  h.emit('pointerup', { clientX: 360 }); await settle();
  h.emit('lostpointercapture'); h.emit('pointerup'); await settle();
  assert.deepEqual(h.commits, [shown]);
});

test('三个局部档均以按下前时间为中心相对移动，按住右拖时间向前而比例不变', async () => {
  for (const span of [3_600_000, 300_000, 30_000]) {
    const h = fixture({ span }); h.emit('pointerdown', { clientX: 70 });
    assert.equal(h.events.length, 0);
    h.emit('pointermove', { clientX: 106 });
    assert.equal(h.time(), 43_200_000 - span / 10, `${span}ms`);
    assert.equal(h.events.at(-1).span, span); assert.equal(h.commits.length, 0);
    h.emit('pointerup', { clientX: 300 }); await settle();
    assert.deepEqual(h.commits, [43_200_000 - span / 10]);
  }
});

test('局部尺在左右边缘抬手重抓可续调，按下位置不会跳走', async () => {
  const h = fixture({ span: 30_000 });
  for (const [index, x] of [350, 22, 300].entries()) {
    h.emit('pointerdown', { clientX: x }); assert.equal(h.time(), 43_200_000 + index * 1000);
    h.emit('pointermove', { clientX: x - 12 }); h.emit('pointerup'); await settle();
    assert.equal(h.time(), 43_200_000 + (index + 1) * 1000);
  }
  assert.deepEqual(h.commits, [43_201_000, 43_202_000, 43_203_000]);
});

test('慢拖保留总位移精度，不把每次不足1秒的增量丢失', async () => {
  const h = fixture({ span: 30_000 }); h.emit('pointerdown');
  for (let clientX = 191; clientX <= 214; clientX++) h.emit('pointermove', { clientX });
  assert.equal(h.time(), 43_198_000);
  assert.ok(h.events.filter(event => event.type === 'move').every(event => event.time % 1000 === 0));
  h.emit('pointerup'); await settle(); assert.deepEqual(h.commits, [43_198_000]);
});

test('局部点按没有seek或暂停，纵向滑动不触发旧精度手势', async () => {
  for (const span of [86_400_000, 30_000]) {
    for (const moveBeforeRelease of [false, true]) {
      const h = fixture({ span }); h.emit('pointerdown', { clientX: 100 });
      if (moveBeforeRelease) h.emit('pointermove', { clientX: 102, clientY: 100 });
      h.emit('pointerup', { clientX: 102, clientY: 100 }); await settle();
      assert.equal(h.events.length, 0); assert.equal(h.commits.length, 0);
    }
  }
  const h = fixture({ span: 30_000 }); h.emit('pointerdown', { clientX: 350 });
  h.emit('pointermove', { clientX: 351 }); h.emit('pointerup', { clientX: 351 }); await settle();
  assert.equal(h.events.length, 0); assert.equal(h.commits.length, 0);
});

test('缩放后的布局坐标仍按可见宽度映射，并相应缩放手势死区', async () => {
  const h = fixture({ span: 30_000, width: 180, clientWidth: 360 });
  h.emit('pointerdown'); h.emit('pointermove', { clientX: 106 }); h.emit('pointerup'); await settle();
  assert.deepEqual(h.commits, [43_199_000]);
});

test('局部的前日和未来留白不能作为起点，拖至边界只停在本日有效整秒', async () => {
  for (const config of [{ time: 2000, x: 20, move: 310, expected: 0 }, { time: 10_000, end: 10_000, x: 350, move: 70, expected: 10_000 }]) {
    const h = fixture({ span: 30_000, ...config });
    h.emit('pointerdown', { clientX: config.x }); h.emit('pointermove'); h.emit('pointerup'); await settle();
    assert.equal(h.events.length, 0); assert.equal(h.commits.length, 0);
    h.emit('pointerdown'); h.emit('pointermove', { clientX: config.move }); h.emit('pointerup'); await settle();
    assert.deepEqual(h.commits, [config.expected]);
  }
});

test('全天末端为23:59:59，今日未来粗选夹到最新有效秒，不进入下一天', async () => {
  for (const end of [86_399_999, 10_500]) {
    const h = fixture({ end }); h.emit('pointerdown', { clientX: 370 }); h.emit('pointerup'); await settle();
    assert.deepEqual(h.commits, [Math.floor(end / 1000) * 1000]);
  }
});

test('非主指针、鼠标右键和无录像/零宽轨道不能创建提交', async () => {
  for (const options of [{ pointerId: 2, isPrimary: false }, { button: 2 }]) {
    const h = fixture(); h.emit('pointerdown', options); h.emit('pointerup', options); await settle();
    assert.equal(h.events.length, 0); assert.equal(h.commits.length, 0);
  }
  for (const options of [{ time: NaN }, { width: 0 }]) {
    const h = fixture(options); h.emit('pointerdown'); h.emit('pointermove', { clientX: 100 }); h.emit('pointerup'); await settle();
    assert.equal(h.events.length, 0); assert.equal(h.commits.length, 0);
  }
});

test('第二根手指不能移动、结束或取消主指针，指针丢失后恢复且不提交', async () => {
  const h = fixture({ span: 30_000 }); h.emit('pointerdown'); h.emit('pointermove', { clientX: 202 });
  h.emit('pointerdown', { pointerId: 2 }); h.emit('pointermove', { pointerId: 2, clientX: 350 });
  h.emit('pointerup', { pointerId: 2 }); h.emit('pointercancel', { pointerId: 2 });
  assert.equal(h.time(), 43_199_000); assert.equal(h.commits.length, 0);
  h.emit('lostpointercapture'); assert.equal(h.time(), 43_200_000); assert.equal(h.events.at(-1).restore, true);
  h.emit('pointerup'); await settle(); assert.equal(h.commits.length, 0);
});

test('活动手势和待提交微任务遇到上下文或档位改变都不能播放旧时间', async () => {
  for (const released of [false, true]) {
    for (const change of [h => h.setContext('camera-b/day-b'), h => h.setSpan(300_000)]) {
      const h = fixture({ span: 30_000 }); h.emit('pointerdown'); h.emit('pointermove', { clientX: 202 });
      if (released) h.emit('pointerup'); change(h); h.emit('pointerup'); await settle();
      assert.equal(h.commits.length, 0); assert.equal(h.events.at(-1).restore, false);
    }
  }
});

test('释放后cancel或destroy阻止旧提交并回退，destroy解除全部事件', async () => {
  for (const method of ['cancel', 'destroy']) {
    const h = fixture(); h.emit('pointerdown', { clientX: 100 }); h.emit('pointerup'); h.api[method](); await settle();
    assert.equal(h.commits.length, 0); assert.equal(h.time(), 43_200_000); assert.equal(h.events.at(-1).restore, true);
    if (method === 'destroy') assert.equal(h.listeners.size, 0);
  }
});
