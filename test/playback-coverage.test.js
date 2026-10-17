import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCoverageGap, countCoverageGaps, listCoverageGaps, formatCoverageGap } from '../public/playback-coverage.js';

test('本地录像连续覆盖时没有缺口', () => {
  assert.equal(findCoverageGap([
    { startMs: 0, endMs: 10 }, { startMs: 10, endMs: 30 }, { startMs: 25, endMs: 40 },
  ], 5, 35), null);
});

test('跨录像段时返回第一个真实缺口，供界面说明 DVR 回退', () => {
  assert.deepEqual(findCoverageGap([
    { start: '2026-09-29T12:00:00.000Z', duration: 600 },
    { start: '2026-09-29T12:10:02.000Z', duration: 600 },
  ], Date.parse('2026-09-29T12:05:00.000Z'), Date.parse('2026-09-29T12:15:00.000Z')),
  { start: Date.parse('2026-09-29T12:10:00.000Z'), end: Date.parse('2026-09-29T12:10:02.000Z') });
});

test('区间开头或结尾没有本地录像时也报告缺口', () => {
  const segments = [{ startMs: 10, endMs: 20 }];
  assert.deepEqual(findCoverageGap(segments, 0, 15), { start: 0, end: 10 });
  assert.deepEqual(findCoverageGap(segments, 15, 25), { start: 20, end: 25 });
  assert.equal(findCoverageGap(segments, 20, 20), null);
});

test('gap count merges overlapping/adjacent spans and counts leading, internal and trailing gaps once', () => {
  const segments = [{startMs:60,endMs:80},{startMs:10,endMs:20},{startMs:18,endMs:40},{startMs:20,endMs:30},{startMs:NaN,endMs:100}];
  assert.equal(countCoverageGaps(segments,0,100),3);
  assert.equal(countCoverageGaps(segments,10,80),1);
  assert.equal(countCoverageGaps([...segments,{startMs:40,endMs:60}],10,80),0);
  assert.deepEqual(findCoverageGap(segments,0,100),{start:0,end:10});
});
test('gap count excludes invalid ranges, bounds outside selection and handles empty coverage', () => {
  assert.equal(countCoverageGaps([],0,100),1);
  assert.equal(countCoverageGaps([],100,100),0); assert.equal(countCoverageGaps([],NaN,100),0);
  assert.equal(countCoverageGaps([{startMs:-100,endMs:200}],0,100),0);
  assert.equal(countCoverageGaps([{startMs:0,endMs:0},{startMs:60,endMs:20},{startMs:150,endMs:200}],0,100),1);
});


test('gap list exposes every clipped interval in order instead of a combined duration', () => {
  const segments = [{ startMs: 5000, endMs: 9000 }, { startMs: 2000, endMs: 4000 },
    { startMs: 3000, endMs: 4500 }, { startMs: 4500, endMs: 5000 },
    { startMs: 12000, endMs: 14000 }, { startMs: 10000, endMs: 9999 }];
  assert.deepEqual(listCoverageGaps(segments, 0, 15000), [
    { start: 0, end: 2000 }, { start: 9000, end: 12000 }, { start: 14000, end: 15000 },
  ]);
  assert.deepEqual(listCoverageGaps(segments, 3000, 13000), [{ start: 9000, end: 12000 }]);
  assert.deepEqual(listCoverageGaps([], 2, 1), []);
  assert.deepEqual(listCoverageGaps([], NaN, 1), []);
  assert.deepEqual(listCoverageGaps([], 0, 1), [{ start: 0, end: 1 }]);
});

test('gap presentation uses recording clock time and retains millisecond duration for cached gaps', () => {
  const start = Date.parse('2026-01-15T11:02:10.250Z');
  assert.deepEqual(formatCoverageGap({ start, end: start + 1875 }), {
    rangeText: '19:02:10 → 19:02:12', durationText: '1.875秒',
  });
});

test('server gap strings remain authoritative while numeric wall-axis bounds preserve exact duration', () => {
  // Server coverage bounds use a wall-clock axis, unlike the browser timeline's UTC instants.
  const startMs = Date.parse('2026-01-15T19:02:10.250Z');
  assert.deepEqual(formatCoverageGap({ start: '2026-01-15 19:02:10', end: '2026-01-15 19:02:12',
    startMs, endMs: startMs + 1875, durationSeconds: 1.875 }), {
    rangeText: '19:02:10 → 19:02:12', durationText: '1.875秒',
  });
  assert.deepEqual(formatCoverageGap({ start: '2026-01-15 19:02:10', end: '2026-01-15 19:02:12',
    startMs, endMs: startMs + 1875 }), {
    rangeText: '19:02:10 → 19:02:12', durationText: '1.875秒',
  });
  assert.deepEqual(formatCoverageGap({ start: '2026-01-15 19:02:10', end: '2026-01-15 19:02:12' }), {
    rangeText: '19:02:10 → 19:02:12', durationText: '2秒',
  });
});

test('gap duration stays readable from milliseconds through hours without floating point tails', () => {
  const start = Date.parse('2026-01-15T00:00:00+08:00');
  for (const [milliseconds, expected] of [[1, '0.001秒'], [1000, '1秒'], [12500, '12.5秒'],
    [60000, '1分00秒'], [62000, '1分02秒'], [62025, '1分02.025秒'],
    [3599999, '59分59.999秒'], [3600000, '1小时00分00秒'], [3662050, '1小时01分02.05秒']]) {
    assert.equal(formatCoverageGap({ start, end: start + milliseconds }).durationText, expected);
  }
  const interval = { start: '2026-01-15 00:00:00', end: '2026-01-15 00:01:00' };
  assert.equal(formatCoverageGap({ ...interval, durationSeconds: 59.999999999 }).durationText, '1分00秒');
  assert.equal(formatCoverageGap({ ...interval, durationSeconds: 0.0001 }).durationText, '小于0.001秒');
});

test('midnight gap labels show the next day without repeating a calendar date', () => {
  const start = Date.parse('2026-12-31T23:59:50+08:00'), end = start + 30000;
  const expected = { rangeText: '23:59:50 → 次日 00:00:20', durationText: '30秒' };
  assert.deepEqual(formatCoverageGap({ start, end }), expected);
  assert.deepEqual(formatCoverageGap({ start: '2026-12-31 23:59:50', end: '2027-01-01 00:00:20' }), expected);
  assert.deepEqual(formatCoverageGap({ start, end: end + 86400000 }), {
    rangeText: '23:59:50 → 2天后 00:00:20', durationText: '24小时00分30秒',
  });
});

test('clock-only gap presentation handles zoned timestamps and unavailable fields without claiming zero loss', () => {
  assert.deepEqual(formatCoverageGap({ start: '2026-01-15T11:02:10Z', end: '2026-01-15T19:02:12+08:00' }), {
    rangeText: '19:02:10 → 19:02:12', durationText: '2秒',
  });
  for (const interval of [null, {}, { start: NaN, end: Infinity }]) {
    assert.deepEqual(formatCoverageGap(interval), { rangeText: '--:--:-- → --:--:--', durationText: '时长待核实' });
  }
  assert.equal(formatCoverageGap({ start: '2026-01-15 19:02:12', end: '2026-01-15 19:02:10' }).durationText, '时长待核实');
});
