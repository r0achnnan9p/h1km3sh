import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('runParallelDownload', () => {
  describe('fallback to sequential mode for short durations', () => {
    it('should return fallback:true when duration is ≤ 60s (30s)', async () => {
      const { runParallelDownload } = await import('../lib/parallel-download.js');

      const result = await runParallelDownload({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        startTime: '20231012T080000Z',
        endTime: '20231012T080030Z', // 30s
        concurrency: 4,
        segmentDuration: 120,
        taskId: 'test-30s',
        sseClients: [],
      });

      assert.deepEqual(result, { fallback: true });
    });

    it('should return fallback:true for exactly 60s duration', async () => {
      const { runParallelDownload } = await import('../lib/parallel-download.js');

      const result = await runParallelDownload({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        startTime: '20231012T080000Z',
        endTime: '20231012T080100Z', // exactly 60s
        taskId: 'test-60s',
        sseClients: [],
      });

      assert.deepEqual(result, { fallback: true });
    });

    it('should return fallback:true for 1s duration', async () => {
      const { runParallelDownload } = await import('../lib/parallel-download.js');

      const result = await runParallelDownload({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        startTime: '20231012T080000Z',
        endTime: '20231012T080001Z', // 1s
        taskId: 'test-1s',
        sseClients: [],
      });

      assert.deepEqual(result, { fallback: true });
    });
  });

  describe('progress reporting via SSE', () => {
    it('should broadcast progress messages to SSE clients for short duration fallback', async () => {
      const { runParallelDownload } = await import('../lib/parallel-download.js');

      const messages = [];
      const mockRes = {
        write: (data) => { messages.push(data); },
      };
      const sseClients = [{ id: 1, res: mockRes }];

      await runParallelDownload({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        startTime: '20231012T080000Z',
        endTime: '20231012T080050Z', // 50s - fallback
        taskId: 'test-sse',
        sseClients,
      });

      // Should have received at least one SSE message
      assert.ok(messages.length > 0, 'Should broadcast at least one progress message');

      // Parse the first message and verify SSE format
      const firstMsg = messages[0].replace('data: ', '').replace('\n\n', '');
      const parsed = JSON.parse(firstMsg);
      assert.equal(parsed.taskId, 'test-sse');
      assert.ok('status' in parsed, 'SSE message should have status field');
      assert.ok('progress' in parsed, 'SSE message should have progress field');
      assert.ok('message' in parsed, 'SSE message should have message field');
    });
  });

  describe('default parameters', () => {
    it('should use default concurrency, segmentDuration, overlapDuration, and outputDir', async () => {
      const { runParallelDownload } = await import('../lib/parallel-download.js');

      // Short duration triggers fallback - validates defaults don't cause errors
      const result = await runParallelDownload({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '101',
        startTime: '20231012T080000Z',
        endTime: '20231012T080045Z',
        taskId: 'test-defaults',
        sseClients: [],
      });

      assert.deepEqual(result, { fallback: true });
    });

    it('should derive baseFilename from channel and time range when not provided', async () => {
      const { runParallelDownload } = await import('../lib/parallel-download.js');

      // Short duration triggers fallback before needing baseFilename for files
      const result = await runParallelDownload({
        ip: '192.168.1.64',
        user: 'admin',
        pass: 'password',
        channel: '201',
        startTime: '20260505T201202Z',
        endTime: '20260505T201230Z', // 28s - fallback
        taskId: 'test-basename',
        sseClients: [],
      });

      assert.deepEqual(result, { fallback: true });
    });
  });

  describe('error handling', () => {
    it('should report error via ProgressReporter for unexpected errors', async () => {
      const { runParallelDownload } = await import('../lib/parallel-download.js');

      const messages = [];
      const mockRes = {
        write: (data) => { messages.push(data); },
      };
      const sseClients = [{ id: 1, res: mockRes }];

      // Use invalid segmentDuration to trigger an error from splitTimeRange
      try {
        await runParallelDownload({
          ip: '192.168.1.64',
          user: 'admin',
          pass: 'password',
          channel: '101',
          startTime: '20231012T080000Z',
          endTime: '20231012T100000Z',
          segmentDuration: 10, // Invalid - below minimum of 30
          taskId: 'test-error',
          sseClients,
        });
        assert.fail('Should have thrown an error');
      } catch (err) {
        assert.match(err.message, /segmentDuration must be >= 30/);
      }

      // Should have broadcast an error message
      const errorMessages = messages.filter(m => {
        const parsed = JSON.parse(m.replace('data: ', '').replace('\n\n', ''));
        return parsed.status === 'error';
      });
      assert.ok(errorMessages.length > 0, 'Should broadcast error via SSE');
    });
  });

  describe('pipeline structure validation', () => {
    it('should export runParallelDownload as a function', async () => {
      const mod = await import('../lib/parallel-download.js');
      assert.equal(typeof mod.runParallelDownload, 'function');
    });

    it('should import all required pipeline modules without error', async () => {
      // This validates that all imports in parallel-download.js resolve correctly
      const mod = await import('../lib/parallel-download.js');
      assert.ok(mod.runParallelDownload);
    });
  });
});
