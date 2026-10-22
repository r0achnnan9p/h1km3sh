import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMp4DownloadPipeline } from '../lib/mp4-download-pipeline.js';
import { getCacheFilePath } from '../lib/file-downloader.js';
import { trimFiles } from '../lib/mp4-file-trimmer.js';
import { concatenateToMp4 } from '../lib/mp4-file-concatenator.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const recording = (minute = 0) => ({
  channel: '101', size: 5,
  startTime: `2026-09-29T00:0${minute}:00Z`,
  endTime: `2026-09-29T00:0${minute + 1}:00Z`,
});
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.signals = [];
  proc.kill = signal => { proc.signals.push(signal); return true; };
  return proc;
}
function cachedFile(dir, minute = 0) {
  const recordingFile = recording(minute);
  const filePath = getCacheFilePath(dir, recordingFile, { ip: 'unused' });
  writeFileSync(filePath, 'cache');
  writeFileSync(filePath + '.done', '');
  return { filePath, recordingFile, skipped: true, resumed: false };
}
function autoSpawn(_command, args) {
  const child = fakeProcess();
  setImmediate(() => {
    writeFileSync(args.at(-1), 'output');
    child.stderr.emit('data', 'frame=3 time=00:01:02.50 bitrate=12kbits/s\r');
    child.stderr.emit('data', '[mp4] Starting second pass: moving the moov atom to the beginning of the file\n');
    child.emit('close', 0);
  });
  return child;
}

it('all-cache export reports cache, file preparation, concat and finalization without an overall percentage', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'mp4-stage-cache-'));
  try {
    const cached = [cachedFile(outputDir, 0), cachedFile(outputDir, 1)];
    const events = [];
    const output = await runMp4DownloadPipeline({
      ip: 'unused', user: 'unused', pass: 'unused', channel: '101',
      startTime: '20260929T000000Z', endTime: '20260929T000200Z',
      taskId: 'cache-progress', outputDir,
      sseClients: [{ res: { write: data => events.push(JSON.parse(data.slice(6))) } }],
      search: async () => cached.map(item => item.recordingFile),
      trim: options => trimFiles({ ...options, probeDuration: async () => 60, spawn: autoSpawn }),
      concatenate: options => concatenateToMp4({ ...options, spawn: autoSpawn }),
    });
    assert.ok(existsSync(output));
    const running = events.filter(event => event.status !== 'completed');
    assert.ok(running.every(event => event.progress === null));
    assert.ok(running.every(event => event.stage));
    assert.deepEqual([...new Set(running.map(event => event.stage))],
      ['searching', 'cache', 'trimming', 'remuxing', 'concatenating', 'finalizing']);
    assert.ok(!running.some(event => event.stage === 'downloading'));
    const cacheEvents = running.filter(event => event.stage === 'cache');
    assert.ok(cacheEvents.every(event => event.stagePercent === null && event.speed === null));
    assert.match(cacheEvents.at(-1).message, /全部 2 个缓存文件/);
    const fileProgress = running.filter(event => event.progressUnit === 'files');
    assert.deepEqual([...new Set(fileProgress.map(event => event.stagePercent))], [0, 50, 100]);
    assert.ok(running.some(event => event.stage === 'concatenating' && event.processedSeconds === 62.5));
    assert.ok(running.filter(event => event.stage === 'finalizing').every(event => event.stagePercent === null));
    assert.equal(events.at(-1).status, 'completed');
    assert.equal(events.at(-1).progress, 100);
    assert.ok(cached.every(item => existsSync(item.filePath) && existsSync(item.filePath + '.done')));
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

it('DVR-estimated download percentages never become measured stage percentages', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'mp4-stage-download-'));
  const events = [];
  try {
    await runMp4DownloadPipeline({
      ip: 'unused', user: 'unused', pass: 'unused', channel: '101',
      startTime: '20260929T000000Z', endTime: '20260929T000100Z',
      taskId: 'download-progress', outputDir,
      sseClients: [{ res: { write: data => events.push(JSON.parse(data.slice(6))) } }],
      search: async () => [recording()],
      download: async ({ onProgress }) => {
        for (const overallPercent of [20, 100, 170]) {
          onProgress({ currentFile: 1, skippedFiles: 0, overallPercent,
            bytesReceived: overallPercent, bytesTotal: 100, message: '下载中...' });
        }
        return [{ skipped: false }];
      },
      trim: async () => [],
      concatenate: async ({ outputPath }) => outputPath,
    });
    const downloads = events.filter(event => event.stage === 'downloading');
    assert.ok(downloads.length >= 3);
    assert.ok(downloads.every(event => event.stagePercent === null && event.progress === null));
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

it('file preparation reports probe/start immediately and counts only closed successful files', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'mp4-stage-trim-'));
  const updates = [];
  const children = [];
  let finishProbe;
  try {
    const downloadResults = [cachedFile(outputDir)];
    const work = trimFiles({
      downloadResults, outputDir,
      userStartTime: '2026-09-29T00:00:05Z', userEndTime: '2026-09-29T00:00:50Z',
      onProgress: update => updates.push(update),
      probeDuration: () => new Promise(resolve => { finishProbe = resolve; }),
      spawn: () => { const child = fakeProcess(); children.push(child); return child; },
    });
    assert.match(updates[0].message, /探测文件 1\/1/);
    assert.equal(updates[0].segmentsCompleted, 0);
    assert.equal(children.length, 0);
    finishProbe(60);
    await tick();
    assert.match(updates.at(-1).message, /裁剪文件 1\/1/);
    assert.ok(updates.every(update => update.stagePercent === 0));
    children[0].emit('close', 1); // Existing no-audio fallback must not count this as completed.
    await tick();
    assert.equal(children.length, 2);
    assert.ok(updates.every(update => update.stagePercent === 0));
    children[1].emit('close', 0);
    await work;
    assert.equal(updates.at(-1).segmentsCompleted, 1);
    assert.equal(updates.at(-1).stagePercent, 100);
    assert.equal(updates.at(-1).progressUnit, 'files');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

it('ffmpeg split stderr reports timestamps and a sticky unknown-duration faststart stage', async () => {
  const updates = [];
  const child = fakeProcess();
  const work = concatenateToMp4({
    trimResults: [{ filePath: '/unused/input.mp4', isTemporary: false }], outputPath: '/unused/output.mp4',
    spawn: () => child, onProgress: update => updates.push(update),
  });
  assert.equal(updates[0].stage, 'remuxing');
  child.stderr.emit('data', 'frame=1 time=00:01:');
  assert.equal(updates.length, 1, 'partial timestamps are not measurements');
  child.stderr.emit('data', '02.50 bitrate=0\rtime=N/A speed=N/A\rtime=-00:00:01.00\n');
  assert.equal(updates.at(-1).processedSeconds, 62.5);
  child.stderr.emit('data', '[mp4] Starting second pass: moving the mo');
  child.stderr.emit('data', 'ov atom to the beginning of the file\n');
  assert.equal(updates.at(-1).stage, 'finalizing');
  child.stderr.emit('data', 'frame=2 time=01:02:03.25 bitrate=0\n');
  assert.equal(updates.at(-1).processedSeconds, 3723.25);
  assert.equal(updates.at(-1).stage, 'finalizing');
  assert.ok(updates.every(update => update.stagePercent === null && !('overallPercent' in update)));
  child.emit('close', 0);
  await work;
});

for (const operation of ['trim', 'concat']) {
  it(`${operation} cancellation waits for process close and never reports a completed file`, async () => {
    const outputDir = mkdtempSync(join(tmpdir(), `mp4-${operation}-abort-`));
    const controller = new AbortController();
    const child = fakeProcess();
    const updates = [];
    let settled = false;
    let spawnCount = 0;
    try {
      const cached = cachedFile(outputDir);
      const options = {
        outputDir, signal: controller.signal,
        spawn: () => { spawnCount++; return child; },
        onProgress: update => updates.push(update),
      };
      const promise = operation === 'trim'
        ? trimFiles({ ...options, downloadResults: [cached], probeDuration: async () => 60,
          userStartTime: cached.recordingFile.startTime, userEndTime: cached.recordingFile.endTime })
        : concatenateToMp4({ ...options, trimResults: [{ ...cached, isTemporary: false }], outputPath: join(outputDir, 'result.mp4') });
      const result = promise.then(() => { settled = true; }, error => { settled = true; return error; });
      await tick();
      controller.abort();
      await tick();
      assert.deepEqual(child.signals, ['SIGTERM']);
      assert.equal(settled, false);
      child.emit('close', null);
      assert.match((await result).message, /Download aborted/);
      assert.equal(spawnCount, 1, 'cancellation must not launch the audio fallback');
      assert.ok(updates.every(update => update.stagePercent !== 100));
      assert.ok(existsSync(cached.filePath));
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
}

it('ffmpeg diagnostics remain bounded and retain the last error', async () => {
  const child = fakeProcess();
  const work = concatenateToMp4({
    trimResults: [{ filePath: '/unused/input.mp4', isTemporary: false }],
    outputPath: '/unused/output.mp4', spawn: () => child,
  });
  child.stderr.emit('data', 'x'.repeat(100_000));
  child.stderr.emit('data', '\nlast diagnostic: output disk full\n');
  child.emit('close', 1);
  await assert.rejects(work, error => error.message.length < 600 && /output disk full/.test(error.message));
});
