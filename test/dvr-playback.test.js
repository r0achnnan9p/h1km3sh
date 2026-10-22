import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dvrDateRange, normalizeDvrSegments } from '../lib/dvr-playback.js';

test('DVR 查询用上海墙上时间，返回区间映射到播放器时间轴', () => {
  assert.deepEqual(dvrDateRange('2026-09-27'), {
    start: '2026-09-27T00:00:00.000Z', end: '2026-09-28T00:00:00.000Z',
    startMs: Date.parse('2026-09-26T16:00:00Z'), endMs: Date.parse('2026-09-27T16:00:00Z'),
  });
  assert.throws(() => dvrDateRange('2026-02-30'), /日期不存在/);
  assert.throws(() => dvrDateRange('2026/09/27'), /日期格式/);
});

test('DVR 录像段裁剪到当天、排序并忽略无效结果', () => {
  const segments = normalizeDvrSegments([
    { startTime: '2026-09-27T13:10:00+08:00', endTime: '2026-09-27T13:20:00+08:00' },
    { startTime: '2026-09-26T23:55:00+08:00', endTime: '2026-09-27T00:05:00+08:00' },
    { startTime: '2026-09-27T23:55:00+08:00', endTime: '2026-09-28T00:05:00+08:00' },
    { startTime: '2026-09-27T08:00:00Z', endTime: '2026-09-27T08:10:00Z' },
    { startTime: 'bad', endTime: '2026-09-27T01:00:00Z' },
    { startTime: '2026-09-27T02:00:00Z', endTime: '2026-09-27T01:00:00Z' },
  ], '2026-09-27');
  assert.deepEqual(segments, [
    { start: '2026-09-26T16:00:00.000Z', duration: 300 },
    { start: '2026-09-27T00:00:00.000Z', duration: 600 },
    { start: '2026-09-27T05:10:00.000Z', duration: 600 },
    { start: '2026-09-27T15:55:00.000Z', duration: 300 },
  ]);
});
