import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCoverageGap, countCoverageGaps, listCoverageGaps } from '../public/playback-coverage.js';

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
