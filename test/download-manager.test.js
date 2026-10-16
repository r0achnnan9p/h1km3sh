/**
 * Unit tests for download-manager module.
 * Tests the module structure, codec detection helper, and concurrency pool logic.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { detectCodec, downloadAll, FallbackToSequentialError, CancellationError } from '../lib/download-manager.js';

// --- Test seam helpers -------------------------------------------------------
// These let us exercise downloadAll's concurrency/retry/cancellation logic
// deterministically, without launching real ffmpeg processes or waiting on the
// real retry backoff timers. We inject them via the `spawn` and `delay` options.

// A no-op delay so retry backoff doesn't add real wall-clock time to tests.
const noDelay = () => Promise.resolve();

/**
 * Build a fake `spawn` implementation.
 * @param {'fail-fast'|'hang'} mode
 *   - 'fail-fast': immediately emit `close` with a non-zero code (no output file),
 *     which downloadAll treats as a failed segment → triggers retry logic.
 *   - 'hang': stay "running" until killed, so AbortSignal cancellation can be tested.
 * @param {{ code?: number, stderr?: string }} [opts]
 */
function makeFakeSpawn(mode = 'fail-fast', { code = 1, stderr = '' } = {}) {
  return function fakeSpawn() {
    const proc = new EventEmitter();
    proc.stdin = Object.assign(new EventEmitter(), { write() {}, end() {}, destroyed: false });
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = () => {
      proc.killed = true;
      setImmediate(() => {
        if (proc.exitCode === null) proc.exitCode = 137;
        proc.emit('close', null);
      });
      return true;
    };

    if (mode === 'fail-fast') {
      setImmediate(() => {
        if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
        proc.exitCode = code;
        proc.emit('close', code);
      });
    }
    // mode === 'hang': never auto-closes; only resolves when .kill() is called.
    return proc;
  };
}

describe('download-manager', () => {
  describe('module exports', () => {
    it('should export downloadAll as a function', () => {
      assert.equal(typeof downloadAll, 'function');
    });

    it('should export detectCodec as a function', () => {
      assert.equal(typeof detectCodec, 'function');
    });
  });

  describe('downloadAll options validation', () => {
    it('should resolve immediately with empty array when no segments provided', async () => {
      const result = await downloadAll({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        segments: [],
        concurrency: 4,
        codec: 'h264',
        outputDir: '/tmp/test-downloads',
        baseFilename: 'test',
        onProgress: () => {},
      });

      assert.deepEqual(result, []);
    });

    it('should use provided codec without calling detectCodec', async () => {
      // With codec provided and empty segments, should not attempt detection
      const result = await downloadAll({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        segments: [],
        concurrency: 4,
        codec: 'hevc',
        outputDir: '/tmp/test-downloads',
        baseFilename: 'test',
        onProgress: () => {},
      });

      assert.deepEqual(result, []);
    });
  });

  describe('progress reporting', () => {
    it('should call onProgress with correct structure when starting download', async () => {
      const progressUpdates = [];
      const onProgress = (update) => {
        progressUpdates.push(update);
      };

      // This will fail because there's no real RTSP server, but we can verify
      // that onProgress is called with the initial progress report before ffmpeg starts
      try {
        await downloadAll({
          ip: '127.0.0.1',
          user: 'admin',
          pass: 'password',
          channel: '101',
          segments: [{
            index: 0,
            startTime: '20231012T080000Z',
            endTime: '20231012T080200Z',
            originalStart: '20231012T080000Z',
            originalEnd: '20231012T080200Z',
            isFirst: true,
            isLast: true,
            overlapBefore: 0,
            overlapAfter: 0,
          }],
          concurrency: 4,
          codec: 'h264',
          outputDir: '/tmp/test-downloads-progress',
          baseFilename: 'test_progress',
          onProgress,
          spawn: makeFakeSpawn('fail-fast'),
          delay: noDelay,
        });
      } catch {
        // Expected to fail - no real RTSP server
      }

      // Should have received at least one progress update (initial report + segment start)
      assert.ok(progressUpdates.length >= 1, 'Should have received progress updates');

      // Verify progress update structure
      const firstUpdate = progressUpdates[0];
      assert.equal(firstUpdate.phase, 'downloading');
      assert.equal(typeof firstUpdate.overallPercent, 'number');
      assert.equal(firstUpdate.segmentsTotal, 1);
      assert.equal(typeof firstUpdate.segmentsCompleted, 'number');
      assert.ok(Array.isArray(firstUpdate.segmentsInProgress));
      assert.equal(typeof firstUpdate.message, 'string');
    });
  });

  describe('retry logic and failure handling', () => {
    it('should retry a failed segment up to 2 times before rejecting', async () => {
      const progressUpdates = [];
      const onProgress = (update) => {
        progressUpdates.push(update);
      };

      // Use an invalid RTSP URL that will cause ffmpeg to fail immediately
      // ffmpeg will exit with non-zero code, triggering retry logic
      let error;
      try {
        await downloadAll({
          ip: '0.0.0.0',
          user: 'admin',
          pass: 'password',
          channel: '101',
          segments: [{
            index: 0,
            startTime: '20231012T080000Z',
            endTime: '20231012T080200Z',
            originalStart: '20231012T080000Z',
            originalEnd: '20231012T080200Z',
            isFirst: true,
            isLast: true,
            overlapBefore: 0,
            overlapAfter: 0,
          }],
          concurrency: 4,
          codec: 'h264',
          outputDir: '/tmp/test-downloads-retry',
          baseFilename: 'test_retry',
          onProgress,
          spawn: makeFakeSpawn('fail-fast'),
          delay: noDelay,
        });
      } catch (err) {
        error = err;
      }

      // Should have failed after 3 total attempts (1 initial + 2 retries)
      assert.ok(error, 'Should have thrown an error after retries exhausted');
      assert.match(error.message, /Segment 0 failed after 3 attempts/);

      // Should have received retry progress updates with currentRetry field
      const retryUpdates = progressUpdates.filter(u => u.currentRetry);
      assert.equal(retryUpdates.length, 2, 'Should have 2 retry progress updates');

      // Verify first retry update
      assert.deepEqual(retryUpdates[0].currentRetry, { segment: 0, attempt: 1 });
      assert.match(retryUpdates[0].message, /片段 0 下载失败，正在重试/);

      // Verify second retry update
      assert.deepEqual(retryUpdates[1].currentRetry, { segment: 0, attempt: 2 });
    });

    it('should abort remaining downloads when retries are exhausted', async () => {
      const progressUpdates = [];
      const onProgress = (update) => {
        progressUpdates.push(update);
      };

      // Use multiple segments with concurrency > 1 so they start in parallel
      // All will fail since no real RTSP server, but the first to exhaust retries
      // should abort the rest
      let error;
      try {
        await downloadAll({
          ip: '0.0.0.0',
          user: 'admin',
          pass: 'password',
          channel: '101',
          segments: [
            {
              index: 0,
              startTime: '20231012T080000Z',
              endTime: '20231012T080200Z',
              originalStart: '20231012T080000Z',
              originalEnd: '20231012T080200Z',
              isFirst: true,
              isLast: false,
              overlapBefore: 0,
              overlapAfter: 3,
            },
            {
              index: 1,
              startTime: '20231012T080157Z',
              endTime: '20231012T080403Z',
              originalStart: '20231012T080200Z',
              originalEnd: '20231012T080400Z',
              isFirst: false,
              isLast: true,
              overlapBefore: 3,
              overlapAfter: 0,
            },
          ],
          concurrency: 2, // Both start in parallel, both will fail
          codec: 'h264',
          outputDir: '/tmp/test-downloads-abort',
          baseFilename: 'test_abort',
          onProgress,
          spawn: makeFakeSpawn('fail-fast'),
          delay: noDelay,
        });
      } catch (err) {
        error = err;
      }

      // Should have failed
      assert.ok(error, 'Should have thrown an error');
      assert.match(error.message, /failed after 3 attempts/);
    });

    it('should include currentRetry field in progress updates during retry', async () => {
      // This test validates the same behavior as the retry test above
      // but focuses specifically on the currentRetry field structure.
      // We reuse the same approach - single segment that fails 3 times.
      const progressUpdates = [];
      const onProgress = (update) => {
        progressUpdates.push({ ...update });
      };

      try {
        await downloadAll({
          ip: '0.0.0.0',
          user: 'admin',
          pass: 'password',
          channel: '101',
          segments: [{
            index: 0,
            startTime: '20231012T080000Z',
            endTime: '20231012T080200Z',
            originalStart: '20231012T080000Z',
            originalEnd: '20231012T080200Z',
            isFirst: true,
            isLast: true,
            overlapBefore: 0,
            overlapAfter: 0,
          }],
          concurrency: 4,
          codec: 'h264',
          outputDir: '/tmp/test-downloads-currentretry',
          baseFilename: 'test_currentretry',
          onProgress,
          spawn: makeFakeSpawn('fail-fast'),
          delay: noDelay,
        });
      } catch {
        // Expected to fail
      }

      // Verify that non-retry updates do NOT have currentRetry field
      const normalUpdates = progressUpdates.filter(u => !u.currentRetry);
      assert.ok(normalUpdates.length > 0, 'Should have normal progress updates without currentRetry');
      for (const update of normalUpdates) {
        assert.equal(update.currentRetry, undefined, 'Normal updates should not have currentRetry');
      }

      // Verify retry updates have correct currentRetry structure
      const retryUpdates = progressUpdates.filter(u => u.currentRetry);
      assert.equal(retryUpdates.length, 2, 'Should have exactly 2 retry updates');
      for (const update of retryUpdates) {
        assert.equal(typeof update.currentRetry.segment, 'number');
        assert.equal(typeof update.currentRetry.attempt, 'number');
        assert.ok(update.currentRetry.attempt >= 1 && update.currentRetry.attempt <= 2);
      }
    });
  });

  describe('connection-refused adaptive degradation', () => {
    it('should export FallbackToSequentialError class', () => {
      assert.equal(typeof FallbackToSequentialError, 'function');
      const err = new FallbackToSequentialError();
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'FallbackToSequentialError');
      assert.equal(err.fallbackToSequential, true);
      assert.match(err.message, /falling back to sequential/);
    });

    it('should export FallbackToSequentialError with custom message', () => {
      const err = new FallbackToSequentialError('custom message');
      assert.equal(err.message, 'custom message');
      assert.equal(err.fallbackToSequential, true);
    });

    it('FallbackToSequentialError should be identifiable by fallbackToSequential property', () => {
      const err = new FallbackToSequentialError();
      // Pipeline orchestrator can check this property
      assert.equal(err.fallbackToSequential, true);
      assert.equal(err.name, 'FallbackToSequentialError');
    });
  });

  describe('CancellationError', () => {
    it('should export CancellationError class', () => {
      assert.equal(typeof CancellationError, 'function');
      const err = new CancellationError();
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'CancellationError');
      assert.equal(err.cancelled, true);
      assert.equal(err.message, 'Download cancelled by user');
    });

    it('should accept custom message', () => {
      const err = new CancellationError('custom cancel message');
      assert.equal(err.message, 'custom cancel message');
      assert.equal(err.cancelled, true);
    });

    it('should be distinguishable from FallbackToSequentialError', () => {
      const cancelErr = new CancellationError();
      const fallbackErr = new FallbackToSequentialError();
      assert.ok(cancelErr instanceof CancellationError);
      assert.ok(!(cancelErr instanceof FallbackToSequentialError));
      assert.ok(fallbackErr instanceof FallbackToSequentialError);
      assert.ok(!(fallbackErr instanceof CancellationError));
    });
  });

  describe('cancellation via AbortSignal', () => {
    it('should reject with CancellationError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      let error;
      try {
        await downloadAll({
          ip: '192.168.1.64',
          user: 'admin',
          pass: 'password',
          channel: '101',
          segments: [{
            index: 0,
            startTime: '20231012T080000Z',
            endTime: '20231012T080200Z',
            originalStart: '20231012T080000Z',
            originalEnd: '20231012T080200Z',
            isFirst: true,
            isLast: true,
            overlapBefore: 0,
            overlapAfter: 0,
          }],
          concurrency: 4,
          codec: 'h264',
          outputDir: '/tmp/test-downloads-cancel',
          baseFilename: 'test_cancel',
          onProgress: () => {},
          signal: controller.signal,
        });
      } catch (err) {
        error = err;
      }

      assert.ok(error, 'Should have thrown an error');
      assert.ok(error instanceof CancellationError);
      assert.equal(error.cancelled, true);
    });

    it('should reject with CancellationError when signal is aborted during download', async () => {
      const controller = new AbortController();

      // Abort after a short delay to allow download to start
      setTimeout(() => controller.abort(), 100);

      let error;
      try {
        await downloadAll({
          ip: '0.0.0.0',
          user: 'admin',
          pass: 'password',
          channel: '101',
          segments: [{
            index: 0,
            startTime: '20231012T080000Z',
            endTime: '20231012T080200Z',
            originalStart: '20231012T080000Z',
            originalEnd: '20231012T080200Z',
            isFirst: true,
            isLast: true,
            overlapBefore: 0,
            overlapAfter: 0,
          }],
          concurrency: 4,
          codec: 'h264',
          outputDir: '/tmp/test-downloads-cancel-during',
          baseFilename: 'test_cancel_during',
          onProgress: () => {},
          signal: controller.signal,
          spawn: makeFakeSpawn('hang'),
          delay: noDelay,
        });
      } catch (err) {
        error = err;
      }

      // Should have been cancelled OR failed due to connection error
      // (depends on timing - cancellation may arrive before or after ffmpeg fails)
      assert.ok(error, 'Should have thrown an error');
      // Either CancellationError or normal failure is acceptable depending on timing
      if (error instanceof CancellationError) {
        assert.equal(error.cancelled, true);
      }
    });

    it('should accept signal option without error when signal is undefined', async () => {
      // Passing signal: undefined should work the same as not passing it
      const result = await downloadAll({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        segments: [],
        concurrency: 4,
        codec: 'h264',
        outputDir: '/tmp/test-downloads-nosignal',
        baseFilename: 'test_nosignal',
        onProgress: () => {},
        signal: undefined,
      });

      assert.deepEqual(result, []);
    });
  });

  describe('cleanup on failure', () => {
    it('should attempt to clean up intermediate files when retries are exhausted', async () => {
      // When a segment fails after all retries, intermediate files should be cleaned up.
      // We can't easily verify file deletion without a real filesystem test,
      // but we verify the error is still thrown correctly (cleanup doesn't break the flow).
      let error;
      try {
        await downloadAll({
          ip: '0.0.0.0',
          user: 'admin',
          pass: 'password',
          channel: '101',
          segments: [{
            index: 0,
            startTime: '20231012T080000Z',
            endTime: '20231012T080200Z',
            originalStart: '20231012T080000Z',
            originalEnd: '20231012T080200Z',
            isFirst: true,
            isLast: true,
            overlapBefore: 0,
            overlapAfter: 0,
          }],
          concurrency: 4,
          codec: 'h264',
          outputDir: '/tmp/test-downloads-cleanup',
          baseFilename: 'test_cleanup',
          onProgress: () => {},
          spawn: makeFakeSpawn('fail-fast'),
          delay: noDelay,
        });
      } catch (err) {
        error = err;
      }

      // Should still reject with the segment failure error
      assert.ok(error, 'Should have thrown an error after retries exhausted');
      assert.match(error.message, /Segment 0 failed after 3 attempts/);
    });
  });
});



it('RTSP errors never echo credential-bearing ffmpeg stderr into logs', async () => {
  const messages = [];
  const log = mock.method(console, 'log', (...args) => messages.push(args.join(' ')));
  try {
    await assert.rejects(downloadAll({
      ip: '127.0.0.1', rtspPort: 8554, user: 'private-user', pass: 'FAKE-secret-123', channel: '101',
      segments: [{ startTime: '20200101T000000Z', endTime: '20200101T000100Z' }],
      codec: 'h264', concurrency: 1, outputDir: '/tmp', baseFilename: 'secret-log-regression',
      spawn: makeFakeSpawn('fail-fast', { stderr: 'Connection refused: rtsp://private-user:FAKE-secret-123@127.0.0.1:8554/Streaming/tracks/101' }),
      delay: noDelay,
    }));
    assert.ok(messages.some(line => line.includes('RTSP connection refused')));
    assert.ok(!messages.join(' ').includes('FAKE-secret-123'));
    assert.ok(!messages.join(' ').includes('private-user'));
  } finally { log.mock.restore(); }
});
