import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressReporter, calculateDownloadProgress } from '../lib/progress-reporter.js';

describe('ProgressReporter', () => {
  let sseClients;
  let messages;

  beforeEach(() => {
    messages = [];
    sseClients = [
      {
        id: 1,
        res: {
          write(data) {
            messages.push(data);
          },
        },
      },
    ];
  });

  describe('constructor', () => {
    it('should store taskId and sseClients', () => {
      const reporter = new ProgressReporter('task-123', sseClients);
      assert.equal(reporter.taskId, 'task-123');
      assert.equal(reporter.sseClients, sseClients);
    });
  });

  describe('reportProgress', () => {
    it('should broadcast SSE message with correct format', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 50,
        segmentsCompleted: 2,
        segmentsTotal: 4,
        segmentsInProgress: [2, 3],
        message: '',
      });

      assert.equal(messages.length, 1);
      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.equal(parsed.taskId, 'task-1');
      assert.equal(parsed.status, 'downloading');
      assert.equal(typeof parsed.progress, 'number');
      assert.equal(typeof parsed.message, 'string');
    });

    it('should calculate download phase progress with 85% weight', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 100,
        segmentsCompleted: 4,
        segmentsTotal: 4,
        segmentsInProgress: [],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.equal(parsed.progress, 85);
    });

    it('should calculate trimming phase progress starting at 85%', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'trimming',
        overallPercent: 0,
        segmentsCompleted: 0,
        segmentsTotal: 4,
        segmentsInProgress: [],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      // segmenting(0) + downloading(85) + trimming partial(0) = 85
      assert.equal(parsed.progress, 85);
    });

    it('should calculate concatenating phase progress starting at 90%', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'concatenating',
        overallPercent: 0,
        segmentsCompleted: 4,
        segmentsTotal: 4,
        segmentsInProgress: [],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      // segmenting(0) + downloading(85) + trimming(5) = 90
      assert.equal(parsed.progress, 90);
    });

    it('should calculate remuxing phase progress starting at 93%', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'remuxing',
        overallPercent: 0,
        segmentsCompleted: 4,
        segmentsTotal: 4,
        segmentsInProgress: [],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      // segmenting(0) + downloading(85) + trimming(5) + concatenating(3) = 93
      assert.equal(parsed.progress, 93);
    });

    it('should reach 100% when remuxing is complete', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'remuxing',
        overallPercent: 100,
        segmentsCompleted: 4,
        segmentsTotal: 4,
        segmentsInProgress: [],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.equal(parsed.progress, 100);
    });

    it('should include phase label in message', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 30,
        segmentsCompleted: 1,
        segmentsTotal: 4,
        segmentsInProgress: [1, 2],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.ok(parsed.message.includes('下载中'));
    });

    it('should show segment completion status', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 50,
        segmentsCompleted: 2,
        segmentsTotal: 4,
        segmentsInProgress: [2, 3],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.ok(parsed.message.includes('2/4 完成'));
    });

    it('should show in-progress segment indices', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 50,
        segmentsCompleted: 1,
        segmentsTotal: 4,
        segmentsInProgress: [1, 2, 3],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.ok(parsed.message.includes('进行中: [1, 2, 3]'));
    });

    it('should show retry information', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 30,
        segmentsCompleted: 1,
        segmentsTotal: 4,
        segmentsInProgress: [1, 2],
        currentRetry: { segment: 2, attempt: 1 },
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.ok(parsed.message.includes('片段 2 重试第 1 次'));
    });

    it('should map trimming/concatenating/remuxing to converting status', () => {
      const reporter = new ProgressReporter('task-1', sseClients);

      ['trimming', 'concatenating', 'remuxing'].forEach((phase, i) => {
        reporter.reportProgress({
          phase,
          overallPercent: 50,
          segmentsCompleted: 4,
          segmentsTotal: 4,
          segmentsInProgress: [],
          message: '',
        });

        const parsed = JSON.parse(messages[i].replace('data: ', '').trim());
        assert.equal(parsed.status, 'converting');
      });
    });

    it('should broadcast to multiple SSE clients', () => {
      const messages2 = [];
      sseClients.push({
        id: 2,
        res: { write(data) { messages2.push(data); } },
      });

      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 10,
        segmentsCompleted: 0,
        segmentsTotal: 4,
        segmentsInProgress: [0, 1],
        message: '',
      });

      assert.equal(messages.length, 1);
      assert.equal(messages2.length, 1);
    });

    it('should clamp progress to 0-100 range', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportProgress({
        phase: 'downloading',
        overallPercent: 150,
        segmentsCompleted: 4,
        segmentsTotal: 4,
        segmentsInProgress: [],
        message: '',
      });

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.ok(parsed.progress <= 100);
      assert.ok(parsed.progress >= 0);
    });
  });

  describe('reportComplete', () => {
    it('should broadcast completed status with 100% progress', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportComplete('output.mp4');

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.equal(parsed.status, 'completed');
      assert.equal(parsed.progress, 100);
      assert.ok(parsed.message.includes('output.mp4'));
    });
  });

  describe('reportError', () => {
    it('should broadcast error status with 0% progress', () => {
      const reporter = new ProgressReporter('task-1', sseClients);
      reporter.reportError('Something went wrong');

      const parsed = JSON.parse(messages[0].replace('data: ', '').trim());
      assert.equal(parsed.status, 'error');
      assert.equal(parsed.progress, 0);
      assert.ok(parsed.message.includes('Something went wrong'));
    });
  });
});

describe('calculateDownloadProgress', () => {
  it('should return 0 for empty array', () => {
    assert.equal(calculateDownloadProgress([]), 0);
  });

  it('should return 0 for null/undefined input', () => {
    assert.equal(calculateDownloadProgress(null), 0);
    assert.equal(calculateDownloadProgress(undefined), 0);
  });

  it('should return 0 when total estimated is 0', () => {
    assert.equal(calculateDownloadProgress([{ received: 0, estimated: 0 }]), 0);
  });

  it('should calculate correct percentage from byte totals', () => {
    const segments = [
      { received: 500, estimated: 1000 },
      { received: 250, estimated: 1000 },
    ];
    // total received: 750, total estimated: 2000 => 37.5%
    assert.equal(calculateDownloadProgress(segments), 37.5);
  });

  it('should return 100 when all bytes received', () => {
    const segments = [
      { received: 1000, estimated: 1000 },
      { received: 2000, estimated: 2000 },
    ];
    assert.equal(calculateDownloadProgress(segments), 100);
  });

  it('should clamp to 100 if received exceeds estimated', () => {
    const segments = [
      { received: 1500, estimated: 1000 },
    ];
    assert.equal(calculateDownloadProgress(segments), 100);
  });
});


describe('evidence-based pipeline stages', () => {
  it('passes stage-local evidence without applying legacy weight twice', () => {
    let payload;
    const reporter = new ProgressReporter('stage-task', [{ res: { write(data) { payload = JSON.parse(data.slice(6)); } } }]);
    reporter.reportProgress({ phase: 'trimming', stage: 'trimming', stagePercent: 50, progressUnit: 'files', overallPercent: 87, message: '已完成 1/2 个文件' });
    assert.equal(payload.progress, null);
    assert.equal(payload.stagePercent, 50);
    assert.equal(payload.progressUnit, 'files');
    assert.equal(payload.status, 'converting');
    assert.equal(payload.stage, 'trimming');
    assert.ok(payload.progressUpdatedAt > 0);
    reporter.reportProgress({ phase: 'concatenating', stage: 'finalizing', stagePercent: null, message: '正在优化 MP4 索引' });
    assert.equal(payload.progress, null);
    assert.equal(payload.stagePercent, null);
    reporter.reportComplete('output.mp4');
    assert.equal(payload.status, 'completed');
    assert.equal(payload.progress, 100);
    assert.equal(payload.stage, undefined);
  });
});

it('passes real current-file bytes separately from estimated totals and clears invalid evidence', () => {
  let payload;const reporter=new ProgressReporter('bytes',[{res:{write(data){payload=JSON.parse(data.slice(6));}}}]);
  reporter.reportProgress({phase:'downloading',stage:'downloading',transferredBytes:123456,transferScope:'file',bytesTotal:999999});
  assert.equal(payload.transferredBytes,123456);assert.equal(payload.transferScope,'file');assert.equal(payload.totalBytes,undefined);assert.equal(payload.stagePercent,null);
  reporter.reportProgress({phase:'downloading',stage:'cache',transferredBytes:-1,transferScope:'other'});assert.equal(payload.transferredBytes,null);assert.equal(payload.transferScope,null);
});
