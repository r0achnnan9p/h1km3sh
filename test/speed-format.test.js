/**
 * Property-based test: speed formatting correctness.
 *
 * **Validates: Requirements 5.4**
 *
 * Design reference (design.md Property 4):
 * "For any 非负数值的速度（bytes/sec），格式化后的显示字符串应为 `X.Y MB/s` 格式，
 * 其中数值等于原始值除以 1048576 并保留一位小数。"
 *
 * The formatting logic lives inside the SSE onmessage handler in public/app.js:
 *   const speedMBs = (data.speed / (1024 * 1024)).toFixed(1);
 *   exportSpeedText.textContent = speedMBs + ' MB/s';
 *
 * We extract this as a pure function and verify the property holds for all
 * non-negative inputs using fast-check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

/**
 * Pure function extracted from public/app.js SSE onmessage handler.
 * Converts a speed in bytes/sec to a display string like "X.Y MB/s".
 *
 * @param {number} bytesPerSec - Non-negative speed in bytes per second
 * @returns {string} Formatted string, e.g. "1.5 MB/s"
 */
function formatSpeed(bytesPerSec) {
  const speedMBs = (bytesPerSec / (1024 * 1024)).toFixed(1);
  return speedMBs + ' MB/s';
}

describe('Property 4: speed formatting correctness', () => {
  // --- Boundary / example-based tests ---

  it('formats 0 bytes/sec as "0.0 MB/s"', () => {
    assert.equal(formatSpeed(0), '0.0 MB/s');
  });

  it('formats 1 byte/sec as "0.0 MB/s" (rounds down)', () => {
    assert.equal(formatSpeed(1), '0.0 MB/s');
  });

  it('formats 1048576 bytes/sec (1 MiB/s) as "1.0 MB/s"', () => {
    assert.equal(formatSpeed(1048576), '1.0 MB/s');
  });

  it('formats 5242880 bytes/sec (5 MiB/s) as "5.0 MB/s"', () => {
    assert.equal(formatSpeed(5242880), '5.0 MB/s');
  });

  it('formats 1572864 bytes/sec (1.5 MiB/s) as "1.5 MB/s"', () => {
    assert.equal(formatSpeed(1572864), '1.5 MB/s');
  });

  it('formats very large value (10 GiB/s = 10737418240) correctly', () => {
    assert.equal(formatSpeed(10737418240), '10240.0 MB/s');
  });

  // --- Property-based tests ---

  it('property: result always ends with " MB/s" for any non-negative integer', () => {
    fc.assert(
      fc.property(
        // Non-negative safe integers (0 to 2^53-1)
        fc.nat({ max: Number.MAX_SAFE_INTEGER }),
        (speed) => {
          const result = formatSpeed(speed);
          assert.ok(
            result.endsWith(' MB/s'),
            `Expected "${result}" to end with " MB/s" for speed=${speed}`
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: numeric part equals (speed / 1048576).toFixed(1) for any non-negative integer', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: Number.MAX_SAFE_INTEGER }),
        (speed) => {
          const result = formatSpeed(speed);
          const expected = (speed / 1048576).toFixed(1) + ' MB/s';
          assert.equal(
            result,
            expected,
            `formatSpeed(${speed}) = "${result}", expected "${expected}"`
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: result always ends with " MB/s" for any non-negative float', () => {
    fc.assert(
      fc.property(
        // Non-negative doubles (64-bit) including fractional values; exclude NaN/Infinity
        fc.double({ min: 0, max: 1e12, noNaN: true, noDefaultInfinity: true }),
        (speed) => {
          const result = formatSpeed(speed);
          assert.ok(
            result.endsWith(' MB/s'),
            `Expected "${result}" to end with " MB/s" for speed=${speed}`
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: numeric part equals (speed / 1048576).toFixed(1) for any non-negative float', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e12, noNaN: true, noDefaultInfinity: true }),
        (speed) => {
          const result = formatSpeed(speed);
          const expected = (speed / 1048576).toFixed(1) + ' MB/s';
          assert.equal(
            result,
            expected,
            `formatSpeed(${speed}) = "${result}", expected "${expected}"`
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: result format matches /^\\d+\\.\\d MB\\/s$/ for any non-negative integer', () => {
    const pattern = /^\d+\.\d MB\/s$/;
    fc.assert(
      fc.property(
        fc.nat({ max: Number.MAX_SAFE_INTEGER }),
        (speed) => {
          const result = formatSpeed(speed);
          assert.match(
            result,
            pattern,
            `"${result}" does not match expected pattern for speed=${speed}`
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
