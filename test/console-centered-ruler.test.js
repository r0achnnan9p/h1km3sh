import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script = fs.readFileSync(new URL('../public/console.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = script.indexOf('\n}', start) + 2;
  return script.slice(start, end);
}
class Node {
  children = []; style = {}; dataset = {}; attrs = {}; hidden = false; classes = new Set();
  classList = { toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name),
    remove: name => this.classes.delete(name), contains: name => this.classes.has(name) };
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
}
function fixture({ span = 86400, time = 43_200_000, now = 172_800_000 } = {}) {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const state = { date: 'day-a', timelineSpanSeconds: span, timelineStartMs: span === 86400 ? 0 : time - span * 500,
    cursorMs: time, previewMode: 'replay', segments: [], inMs: null, outMs: null };
  const c = vm.createContext({ state, $, Date: { now: () => now, parse: Date.parse }, Math,
    document: { createElement: () => new Node(), querySelectorAll: () => [] }, dateStart: () => 0, daySeconds: ms => ms / 1000,
    wallTime: ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19), syncPlaybackStatus() {} });
  for (const name of ['timelineWindow', 'timelineLimit', 'clampTimelineCenter', 'timelinePercent', 'renderOverview', 'updateCursor']) vm.runInContext(functionSource(name), c);
  // segmentBounds is intentionally a single-line helper, unlike the functions above.
  c.segmentBounds = segment => { const start = Date.parse(segment.start); return { start, end: start + segment.duration * 1000 }; };
  c.renderTimeline = () => { c.renderOverview(); c.updateCursor(); };
  const segment = (start, duration) => ({ start: new Date(start).toISOString(), duration });
  return { state, $, c, segment, setNow: value => now = value };
}
const bands = (h, className) => h.$('overview-segments').children.filter(node => node.className === className);
const labels = h => h.$('overview-ruler').children.flatMap(tick => tick.children.map(label => label.textContent));
const near = (actual, expected) => assert.ok(Math.abs(parseFloat(actual) - expected) < 1e-9, `${actual} ~= ${expected}`);

test('全天始终显示所选日期00–24，播放游标移动和今日未来不改变尺的边界', () => {
  const h = fixture({ time: 22 * 3_600_000 }); h.c.renderOverview();
  assert.deepEqual(labels(h), ['00:00', '08:00', '16:00', '24:00']);
  for (const time of [0, 18 * 3_600_000, 86_399_000]) {
    h.state.cursorMs = time; h.c.updateCursor();
    assert.equal(h.c.timelineWindow().start, 0); assert.equal(h.c.timelineWindow().end, 86_400_000);
    near(h.$('overview-cursor').style.left, time / 86_400_000 * 100);
  }
  h.setNow(10 * 3_600_000); h.c.renderOverview();
  assert.deepEqual(labels(h), ['00:00', '08:00', '16:00', '24:00']);
  const outside = bands(h, 'overview-outside'); assert.equal(outside.length, 1);
  near(outside[0].style.left, 10 / 24 * 100); near(outside[0].style.width, 14 / 24 * 100);
  assert.equal(h.$('timeline-overview').attrs['aria-valuemax'], '36000');
});

test('短录像和多处真实缺口按精确比例绘制，不用最小宽度吞掉缺口', () => {
  const h = fixture(); h.state.segments = [h.segment(0, 2), h.segment(7000, 3), h.segment(20_000, 5)];
  h.c.renderOverview();
  const recordings = bands(h, 'overview-segment'), gaps = bands(h, 'overview-gap');
  assert.equal(recordings.length, 3); assert.equal(gaps.length, 2);
  near(recordings[0].style.width, 2 / 86400 * 100); near(recordings[1].style.left, 7 / 86400 * 100);
  near(gaps[0].style.left, 2 / 86400 * 100); near(gaps[0].style.width, 5 / 86400 * 100);
  near(gaps[1].style.left, 10 / 86400 * 100); near(gaps[1].style.width, 10 / 86400 * 100);
  assert.equal(h.$('timeline-overview').attrs['aria-disabled'], 'false');
});

test('重叠录像不误报缺口，跨窗口区段裁剪到可见部分', () => {
  const h = fixture({ span: 30, time: 30_000 });
  h.state.segments = [h.segment(5000, 20), h.segment(20_000, 15), h.segment(40_000, 20)]; h.c.renderOverview();
  const recordings = bands(h, 'overview-segment'), gaps = bands(h, 'overview-gap');
  assert.equal(gaps.length, 1); near(gaps[0].style.left, 20 / 30 * 100); near(gaps[0].style.width, 5 / 30 * 100);
  near(recordings[0].style.left, 0); near(recordings[0].style.width, 10 / 30 * 100);
  near(recordings.at(-1).style.left, 25 / 30 * 100); near(recordings.at(-1).style.width, 5 / 30 * 100);
});

test('局部尺午夜和今日上限均保持中心，留暗部分无下一日或未来刻度', () => {
  const midnight = fixture({ span: 30, time: 0 }); midnight.c.renderOverview();
  assert.equal(midnight.c.timelineWindow().start, -15_000); near(midnight.$('overview-cursor').style.left, 50);
  const left = bands(midnight, 'overview-outside'); assert.equal(left.length, 1);
  near(left[0].style.left, 0); near(left[0].style.width, 50);
  assert.deepEqual(labels(midnight), ['00:00:00', '00:00:10']);
  const latest = fixture({ span: 30, time: 36_000_000, now: 36_000_000 }); latest.c.renderOverview();
  near(latest.$('overview-cursor').style.left, 50);
  const right = bands(latest, 'overview-outside'); assert.equal(right.length, 1);
  near(right[0].style.left, 50); near(right[0].style.width, 50);
  assert.deepEqual(labels(latest), ['09:59:50', '10:00:00']);
});

test('30秒每格1秒，其他档位稀疏标注且所有刻度限制在本日', () => {
  for (const [span, tickCount] of [[30, 31], [300, 31], [3600, 61]]) {
    const h = fixture({ span }); h.c.renderOverview();
    assert.equal(h.$('overview-ruler').children.length, tickCount);
    near(h.$('overview-cursor').style.left, 50); assert.equal(h.$('timeline-overview').dataset.relative, 'true');
    assert.ok(labels(h).length >= 2); assert.ok(labels(h).length <= 4);
  }
});

test('导出出点24:00保留，选区随局部尺裁剪且不会修改标记', () => {
  const h = fixture({ span: 30, time: 86_390_000 }); h.state.inMs = 86_380_000; h.state.outMs = 86_400_000;
  h.c.renderOverview();
  const selected = h.$('overview-selection'); assert.equal(selected.hidden, false);
  near(selected.style.left, 5 / 30 * 100); near(selected.style.width, 20 / 30 * 100);
  assert.deepEqual([h.state.inMs, h.state.outMs], [86_380_000, 86_400_000]);
  vm.runInContext(script.slice(script.indexOf('function boundaryLabel('), script.indexOf('function updateBoundaryControls(')), h.c);
  assert.equal(h.c.boundaryLabel(h.state.outMs), '24:00:00');
});
