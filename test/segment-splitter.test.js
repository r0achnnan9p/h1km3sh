import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitTimeRange } from '../lib/segment-splitter.js';

describe('splitTimeRange', () => {
  describe('parameter validation', () => {
    it('should throw error when segmentDuration < 30', () => {
      assert.throws(
        () => splitTimeRange('20231012T080000Z', '20231012T100000Z', 29),
        /segmentDuration must be >= 30/
      );
    });

    it('should accept segmentDuration = 30', () => {
      const result = splitTimeRange('20231012T080000Z', '20231012T100000Z', 30);
      assert.ok(result.length > 0);
    });
  });

  describe('short duration (≤ 60s) - single segment, no overlap', () => {
    it('should return single segment for 60s range', () => {
      const result = splitTimeRange('20231012T080000Z', '20231012T080100Z');
      assert.equal(result.length, 1);
      assert.equal(result[0].index, 0);
      assert.equal(result[0].startTime, '20231012T080000Z');
      assert.equal(result[0].endTime, '20231012T080100Z');
      assert.equal(result[0].originalStart, '20231012T080000Z');
      assert.equal(result[0].originalEnd, '20231012T080100Z');
      assert.equal(result[0].isFirst, true);
      assert.equal(result[0].isLast, true);
      assert.equal(result[0].overlapBefore, 0);
      assert.equal(result[0].overlapAfter, 0);
    });

    it('should return single segment for 30s range', () => {
      const result = splitTimeRange('20231012T080000Z', '20231012T080030Z');
      assert.equal(result.length, 1);
      assert.equal(result[0].overlapBefore, 0);
      assert.equal(result[0].overlapAfter, 0);
    });
  });

  describe('splitting into multiple segments', () => {
    it('should split 240s range into 2 segments of 120s each', () => {
      // 4 minutes = 240s, default segmentDuration = 120s
      const result = splitTimeRange('20231012T080000Z', '20231012T080400Z');
      assert.equal(result.length, 2);

      // First segment
      assert.equal(result[0].index, 0);
      assert.equal(result[0].originalStart, '20231012T080000Z');
      assert.equal(result[0].originalEnd, '20231012T080200Z');
      assert.equal(result[0].startTime, '20231012T080000Z'); // no overlap before first
      assert.equal(result[0].endTime, '20231012T080203Z');   // +3s overlap after
      assert.equal(result[0].isFirst, true);
      assert.equal(result[0].isLast, false);
      assert.equal(result[0].overlapBefore, 0);
      assert.equal(result[0].overlapAfter, 3);

      // Second segment
      assert.equal(result[1].index, 1);
      assert.equal(result[1].originalStart, '20231012T080200Z');
      assert.equal(result[1].originalEnd, '20231012T080400Z');
      assert.equal(result[1].startTime, '20231012T080157Z'); // -3s overlap before
      assert.equal(result[1].endTime, '20231012T080400Z');   // no overlap after last
      assert.equal(result[1].isFirst, false);
      assert.equal(result[1].isLast, true);
      assert.equal(result[1].overlapBefore, 3);
      assert.equal(result[1].overlapAfter, 0);
    });

    it('should handle remainder in last segment', () => {
      // 5 minutes = 300s, segmentDuration = 120s → 2 full + 1 remainder (60s)
      const result = splitTimeRange('20231012T080000Z', '20231012T080500Z');
      assert.equal(result.length, 3);

      // Last segment covers remainder
      assert.equal(result[2].index, 2);
      assert.equal(result[2].originalStart, '20231012T080400Z');
      assert.equal(result[2].originalEnd, '20231012T080500Z');
      assert.equal(result[2].isLast, true);
      assert.equal(result[2].overlapAfter, 0);
      assert.equal(result[2].overlapBefore, 3);
    });

    it('should use custom segmentDuration', () => {
      // 120s range with 60s segments → 2 segments
      const result = splitTimeRange('20231012T080000Z', '20231012T080200Z', 60);
      assert.equal(result.length, 2);
      assert.equal(result[0].originalEnd, '20231012T080100Z');
      assert.equal(result[1].originalStart, '20231012T080100Z');
    });

    it('should use custom overlapDuration', () => {
      const result = splitTimeRange('20231012T080000Z', '20231012T080400Z', 120, 5);

      // First segment: no overlap before, 5s overlap after
      assert.equal(result[0].overlapBefore, 0);
      assert.equal(result[0].overlapAfter, 5);
      assert.equal(result[0].endTime, '20231012T080205Z');

      // Second segment: 5s overlap before, no overlap after
      assert.equal(result[1].overlapBefore, 5);
      assert.equal(result[1].overlapAfter, 0);
      assert.equal(result[1].startTime, '20231012T080155Z');
    });
  });

  describe('time format parsing and formatting', () => {
    it('should correctly parse and format Hikvision time', () => {
      const result = splitTimeRange('20231012T080000Z', '20231012T080030Z');
      assert.equal(result[0].startTime, '20231012T080000Z');
      assert.equal(result[0].endTime, '20231012T080030Z');
    });

    it('should handle midnight crossing', () => {
      // 23:59:00 to 00:01:00 next day = 120s
      const result = splitTimeRange('20231012T235900Z', '20231013T000100Z');
      assert.equal(result.length, 1); // 120s > 60s but exactly one segment of 120s
      assert.equal(result[0].originalStart, '20231012T235900Z');
      assert.equal(result[0].originalEnd, '20231013T000100Z');
    });

    it('should ensure all times are whole-second aligned', () => {
      const result = splitTimeRange('20231012T080000Z', '20231012T100000Z', 120, 3);
      for (const segment of result) {
        // Hikvision format only has second precision, so all should match pattern
        const pattern = /^\d{8}T\d{6}Z$/;
        assert.match(segment.startTime, pattern);
        assert.match(segment.endTime, pattern);
        assert.match(segment.originalStart, pattern);
        assert.match(segment.originalEnd, pattern);
      }
    });
  });

  describe('complete coverage', () => {
    it('should cover the full time range without gaps', () => {
      const result = splitTimeRange('20231012T080000Z', '20231012T081000Z', 120);
      // 10 minutes = 600s, 120s segments → 5 segments

      assert.equal(result.length, 5);

      // First segment original starts at input start
      assert.equal(result[0].originalStart, '20231012T080000Z');

      // Last segment original ends at input end
      assert.equal(result[4].originalEnd, '20231012T081000Z');

      // Each segment's originalEnd equals next segment's originalStart
      for (let i = 0; i < result.length - 1; i++) {
        assert.equal(result[i].originalEnd, result[i + 1].originalStart);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle exactly 61s (just above threshold)', () => {
      // 61s > 60s, so should split. With default 120s segment, it's 1 segment
      const result = splitTimeRange('20231012T080000Z', '20231012T080101Z');
      // 61s < 120s segmentDuration, so only 1 segment but treated as multi-segment logic
      // Actually: numFullSegments = 0, remainder = 61 > 0, totalSegments = 1
      assert.equal(result.length, 1);
      assert.equal(result[0].isFirst, true);
      assert.equal(result[0].isLast, true);
      // Single segment in multi-segment path: both first and last, so no overlap
      assert.equal(result[0].overlapBefore, 0);
      assert.equal(result[0].overlapAfter, 0);
    });

    it('should handle duration exactly equal to segmentDuration', () => {
      // 120s with 120s segments → 1 segment
      const result = splitTimeRange('20231012T080000Z', '20231012T080200Z');
      assert.equal(result.length, 1);
      assert.equal(result[0].isFirst, true);
      assert.equal(result[0].isLast, true);
    });
  });
});
