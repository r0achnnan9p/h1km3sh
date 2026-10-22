import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTrimParams } from '../lib/mp4-file-trimmer.js';

describe('calculateTrimParams', () => {
  it('should return no trim when file is fully contained within user range', () => {
    // User range: 17:00 - 19:00, File range: 17:30 - 18:30
    const result = calculateTrimParams(
      '2026-05-07T17:00:00Z',
      '2026-05-07T19:00:00Z',
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 3600); // fileDuration = 1 hour = 3600s
    assert.equal(result.needsTrim, false);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, false);
  });

  it('should trim start when user start is after file start', () => {
    // User range: 18:00 - 19:00, File range: 17:30 - 18:30
    // ss = 18:00 - 17:30 = 30 minutes = 1800s
    // to = min(3600, 19:00 - 17:30) = min(3600, 5400) = 3600s
    const result = calculateTrimParams(
      '2026-05-07T18:00:00Z',
      '2026-05-07T19:00:00Z',
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z'
    );

    assert.equal(result.ss, 1800);
    assert.equal(result.to, 3600);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, true);
    assert.equal(result.trimmedEnd, false);
  });

  it('should trim end when user end is before file end', () => {
    // User range: 17:00 - 18:00, File range: 17:30 - 18:30
    // ss = max(0, 17:00 - 17:30) = 0
    // to = min(3600, 18:00 - 17:30) = min(3600, 1800) = 1800s
    const result = calculateTrimParams(
      '2026-05-07T17:00:00Z',
      '2026-05-07T18:00:00Z',
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 1800);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, true);
  });

  it('should trim both start and end when user range is inside file range', () => {
    // User range: 17:45 - 18:15, File range: 17:30 - 18:30
    // ss = 17:45 - 17:30 = 15 min = 900s
    // to = min(3600, 18:15 - 17:30) = min(3600, 2700) = 2700s
    const result = calculateTrimParams(
      '2026-05-07T17:45:00Z',
      '2026-05-07T18:15:00Z',
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z'
    );

    assert.equal(result.ss, 900);
    assert.equal(result.to, 2700);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, true);
    assert.equal(result.trimmedEnd, true);
  });

  it('should handle exact boundary match (user range equals file range)', () => {
    const result = calculateTrimParams(
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z',
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 3600);
    assert.equal(result.needsTrim, false);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, false);
  });

  it('should handle user start exactly at file start (no start trim)', () => {
    // User range: 17:30 - 18:00, File range: 17:30 - 18:30
    const result = calculateTrimParams(
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:00:00Z',
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 1800);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, true);
  });

  it('should handle user end exactly at file end (no end trim)', () => {
    // User range: 18:00 - 18:30, File range: 17:30 - 18:30
    const result = calculateTrimParams(
      '2026-05-07T18:00:00Z',
      '2026-05-07T18:30:00Z',
      '2026-05-07T17:30:00Z',
      '2026-05-07T18:30:00Z'
    );

    assert.equal(result.ss, 1800);
    assert.equal(result.to, 3600);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, true);
    assert.equal(result.trimmedEnd, false);
  });

  it('should handle short file durations (e.g., 17 minutes)', () => {
    // Typical Hikvision file: ~17 minutes
    // User range: 17:58 - 18:30, File range: 17:58:17 - 18:13:47
    // ss = max(0, 17:58:00 - 17:58:17) = 0 (user starts before file)
    // to = min(930, 18:30:00 - 17:58:17) = min(930, 1903) = 930
    const result = calculateTrimParams(
      '2026-05-07T17:58:00Z',
      '2026-05-07T18:30:00Z',
      '2026-05-07T17:58:17Z',
      '2026-05-07T18:13:47Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 930); // 15min 30s = 930s
    assert.equal(result.needsTrim, false);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, false);
  });

  it('should handle trim with seconds precision', () => {
    // User range: 18:00:30 - 18:10:00, File range: 17:58:17 - 18:13:47
    // ss = 18:00:30 - 17:58:17 = 133s
    // fileDuration = 18:13:47 - 17:58:17 = 930s
    // to = min(930, 18:10:00 - 17:58:17) = min(930, 703) = 703s
    const result = calculateTrimParams(
      '2026-05-07T18:00:30Z',
      '2026-05-07T18:10:00Z',
      '2026-05-07T17:58:17Z',
      '2026-05-07T18:13:47Z'
    );

    assert.equal(result.ss, 133);
    assert.equal(result.to, 703);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, true);
    assert.equal(result.trimmedEnd, true);
  });

  it('should handle user start before file start (ss = 0)', () => {
    // User range: 16:00 - 18:00, File range: 17:00 - 18:00
    // ss = max(0, 16:00 - 17:00) = max(0, -3600) = 0
    const result = calculateTrimParams(
      '2026-05-07T16:00:00Z',
      '2026-05-07T18:00:00Z',
      '2026-05-07T17:00:00Z',
      '2026-05-07T18:00:00Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 3600);
    assert.equal(result.needsTrim, false);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, false);
  });

  it('should handle user end after file end (to = fileDuration)', () => {
    // User range: 17:00 - 20:00, File range: 17:00 - 18:00
    // to = min(3600, 20:00 - 17:00) = min(3600, 10800) = 3600
    const result = calculateTrimParams(
      '2026-05-07T17:00:00Z',
      '2026-05-07T20:00:00Z',
      '2026-05-07T17:00:00Z',
      '2026-05-07T18:00:00Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 3600);
    assert.equal(result.needsTrim, false);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, false);
  });

  it('should handle very small trim at start (1 second)', () => {
    // User range: 17:00:01 - 18:00, File range: 17:00:00 - 18:00:00
    const result = calculateTrimParams(
      '2026-05-07T17:00:01Z',
      '2026-05-07T18:00:00Z',
      '2026-05-07T17:00:00Z',
      '2026-05-07T18:00:00Z'
    );

    assert.equal(result.ss, 1);
    assert.equal(result.to, 3600);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, true);
    assert.equal(result.trimmedEnd, false);
  });

  it('should handle very small trim at end (1 second)', () => {
    // User range: 17:00 - 17:59:59, File range: 17:00:00 - 18:00:00
    const result = calculateTrimParams(
      '2026-05-07T17:00:00Z',
      '2026-05-07T17:59:59Z',
      '2026-05-07T17:00:00Z',
      '2026-05-07T18:00:00Z'
    );

    assert.equal(result.ss, 0);
    assert.equal(result.to, 3599);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, false);
    assert.equal(result.trimmedEnd, true);
  });

  it('should handle multi-hour file durations', () => {
    // File spans 3 hours, user wants middle hour
    // User range: 19:00 - 20:00, File range: 18:00 - 21:00
    // ss = 19:00 - 18:00 = 3600s
    // fileDuration = 3h = 10800s
    // to = min(10800, 20:00 - 18:00) = min(10800, 7200) = 7200s
    const result = calculateTrimParams(
      '2026-05-07T19:00:00Z',
      '2026-05-07T20:00:00Z',
      '2026-05-07T18:00:00Z',
      '2026-05-07T21:00:00Z'
    );

    assert.equal(result.ss, 3600);
    assert.equal(result.to, 7200);
    assert.equal(result.needsTrim, true);
    assert.equal(result.trimmedStart, true);
    assert.equal(result.trimmedEnd, true);
  });
});
