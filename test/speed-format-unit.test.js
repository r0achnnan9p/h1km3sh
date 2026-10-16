/**
 * Unit tests for the formatSpeed() function.
 *
 * formatSpeed is extracted from the SSE handler in app.js (public/app.js).
 * It converts a raw bytes/sec value into a human-readable "X.Y MB/s" string.
 *
 * Formula: (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s'
 *
 * Validates: Requirements 5.4 / Design Property 4
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Inline definition — mirrors the one-liner used in public/app.js SSE handler.
function formatSpeed(bytesPerSec) {
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

const MB = 1024 * 1024; // 1 048 576 bytes

describe('formatSpeed()', () => {
  // ── Required cases ────────────────────────────────────────────────────────

  it('0 bytes/sec → "0.0 MB/s"', () => {
    assert.equal(formatSpeed(0), '0.0 MB/s');
  });

  it('1 048 576 bytes/sec (1 MiB/s) → "1.0 MB/s"', () => {
    assert.equal(formatSpeed(1048576), '1.0 MB/s');
  });

  it('5 242 880 bytes/sec (5 MiB/s) → "5.0 MB/s"', () => {
    assert.equal(formatSpeed(5242880), '5.0 MB/s');
  });

  // ── Fractional values ─────────────────────────────────────────────────────

  it('half a MiB/s (524 288 bytes/sec) → "0.5 MB/s"', () => {
    assert.equal(formatSpeed(MB / 2), '0.5 MB/s');
  });

  it('1.5 MiB/s (1 572 864 bytes/sec) → "1.5 MB/s"', () => {
    assert.equal(formatSpeed(1.5 * MB), '1.5 MB/s');
  });

  it('value that rounds to one decimal place: 2.25 MiB/s → "2.3 MB/s"', () => {
    // 2.25 * MB = 2 359 296; toFixed(1) rounds to "2.3"
    assert.equal(formatSpeed(2.25 * MB), '2.3 MB/s');
  });

  // ── Large values ──────────────────────────────────────────────────────────

  it('100 MiB/s (104 857 600 bytes/sec) → "100.0 MB/s"', () => {
    assert.equal(formatSpeed(100 * MB), '100.0 MB/s');
  });

  it('1 GiB/s (1 073 741 824 bytes/sec) → "1024.0 MB/s"', () => {
    assert.equal(formatSpeed(1024 * MB), '1024.0 MB/s');
  });

  // ── Sub-megabyte values ───────────────────────────────────────────────────

  it('1 byte/sec → "0.0 MB/s" (rounds down to zero at one decimal)', () => {
    // 1 / 1048576 ≈ 0.00000095; toFixed(1) → "0.0"
    assert.equal(formatSpeed(1), '0.0 MB/s');
  });

  it('52 428 bytes/sec (≈0.05 MiB/s) → "0.0 MB/s"', () => {
    // 52428 / 1048576 ≈ 0.05; toFixed(1) → "0.1" because 0.05 rounds up
    // Actual: 52428 / 1048576 = 0.04999... → "0.0"
    assert.equal(formatSpeed(52428), '0.0 MB/s');
  });

  it('output always ends with " MB/s" suffix', () => {
    [0, 1, MB, 10 * MB, 999999].forEach((v) => {
      assert.ok(
        formatSpeed(v).endsWith(' MB/s'),
        `formatSpeed(${v}) should end with " MB/s", got "${formatSpeed(v)}"`
      );
    });
  });
});
