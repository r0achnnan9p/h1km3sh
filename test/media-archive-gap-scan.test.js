import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaArchive } from '../lib/media-archive.js';
import { createVideoResolver } from '../lib/video-resolver.js';
import { wallTime } from '../lib/camera-time.js';

const start = '2026-09-24 20:00:00', end = '2026-09-24 20:03:00';
const camera = { archivePath: 'd1' };
const names = {
  future: '2026-09-24_20-03-00.mp4',
  recent: '2026-09-24_20-02-00.mp4',
  middle: '2026-09-24_20-01-00.mp4',
  boundary: '2026-09-24_19-59-00.mp4',
  early: '2026-09-24_19-58-00.mp4',
  unrelated: '2026-09-24_19-00-00.mp4',
};

function fixture(t, entries = [
  [names.future, 60], [names.recent, 60], [names.middle, 30],
  [names.boundary, 90], [names.early, 360], [names.unrelated, 30],
]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-archive-gap-scan-'));
  const directory = path.join(root, camera.archivePath);
  fs.mkdirSync(directory);
  const durations = new Map(entries), probes = [], probeOptions = [], mediaRuns = [];
  for (const [name] of entries) fs.writeFileSync(path.join(directory, name), 'fixture');
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('media-archive-gap-scan-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const archive = createMediaArchive({ root, run: async (_binary, args, options) => {
    if (args.includes('-show_entries')) {
      const name = path.basename(args.at(-1));
      probes.push(name);
      probeOptions.push(options);
      const duration = durations.get(name);
      if (duration instanceof Error) throw duration;
      return { stdout: JSON.stringify({ format: { duration } }) };
    }
    mediaRuns.push(args);
    fs.writeFileSync(args.at(-1), 'fixture output');
    return { stdout: '' };
  } });
  return { archive, root, probes, probeOptions, mediaRuns };
}

test('接受缺口时探测窗口内全部分片，并在首个跨过起点的前置分片后停止', async (t) => {
  const { archive, probes, probeOptions } = fixture(t);
  const signal = new AbortController().signal;
  const found = await archive.hasRecording(camera, start, end, { signal, acceptGaps: true });
  assert.deepEqual(probes, [names.recent, names.middle, names.boundary]);
  assert.ok(probeOptions.every(options => options.signal === signal));
  assert.ok(probeOptions.every(options => options.timeoutMs >= 15_000 && options.timeoutMs <= 20_000));
  assert.equal(found.exists, false);
  assert.deepEqual(found.files, []);
  assert.deepEqual(found.availableSlices.map(slice => [path.basename(slice.file), slice.offset, slice.duration]), [
    [names.boundary, 60, 30], [names.middle, 0, 30], [names.recent, 0, 60],
  ]);
  assert.equal(found.coverage.hasGaps, true);
  assert.equal(found.coverage.availableSeconds, 120);
  assert.equal(found.coverage.missingSeconds, 60);
  assert.deepEqual(found.coverage.missingIntervals.map(gap => [gap.startMs, gap.endMs]), [
    [wallTime('2026-09-24 20:00:30'), wallTime('2026-09-24 20:01:00')],
    [wallTime('2026-09-24 20:01:30'), wallTime('2026-09-24 20:02:00')],
  ]);
});

test('接受缺口时起始时间恰好等于请求起点的分片也能作为停止边界', async (t) => {
  const atStart = '2026-09-24_20-00-00.mp4';
  const { archive, probes } = fixture(t, [
    [names.recent, 60], [atStart, 30], [names.early, 360],
  ]);
  const found = await archive.hasRecording(camera, start, end, { acceptGaps: true });
  assert.deepEqual(probes, [names.recent, atStart]);
  assert.equal(path.basename(found.availableSlices[0].file), atStart);
  assert.equal(found.availableSlices[0].duration, 30);
  assert.equal(found.coverage.missingSeconds, 90);
});

test('结束于起点或更早的短分片不能阻止继续寻找更早的跨界长分片', async (t) => {
  const crossing = '2026-09-24_19-57-00.mp4';
  const { archive, probes } = fixture(t, [
    [names.recent, 60], [names.boundary, 60], [names.early, 30],
    [crossing, 210], [names.unrelated, 30],
  ]);
  const found = await archive.hasRecording(camera, start, end, { acceptGaps: true });
  assert.deepEqual(probes, [names.recent, names.boundary, names.early, crossing]);
  assert.deepEqual(found.availableSlices.map(slice => [path.basename(slice.file), slice.duration]), [
    [crossing, 30], [names.recent, 60],
  ]);
  assert.equal(found.coverage.missingSeconds, 90);
});

test('无效时长与探测失败不能充当接受缺口扫描的停止边界', async (t) => {
  const atStart = '2026-09-24_20-00-00.mp4';
  const { archive, probes } = fixture(t, [
    [names.recent, 60], [atStart, 0], [names.boundary, new Error('未写完的分片')],
    [names.early, 150], [names.unrelated, 30],
  ]);
  const found = await archive.hasRecording(camera, start, end, { acceptGaps: true });
  assert.deepEqual(probes, [names.recent, atStart, names.boundary, names.early]);
  assert.deepEqual(found.availableSlices.map(slice => path.basename(slice.file)), [names.early, names.recent]);
});

for (const [label, options] of [['默认严格模式', {}], ['显式严格模式', { acceptGaps: false }]]) {
  test(`${label}继续探测能填补窗口内缺口的早期长分片`, async (t) => {
    const { archive, probes } = fixture(t);
    const found = await archive.hasRecording(camera, start, end, options);
    assert.deepEqual(probes, [names.recent, names.middle, names.boundary, names.early]);
    assert.equal(found.exists, true);
    assert.equal(found.coverage.complete, true);
    assert.equal(found.coverage.missingSeconds, 0);
    assert.deepEqual(found.slices.map(slice => [path.basename(slice.file), slice.offset, slice.duration]), [
      [names.early, 120, 180],
    ]);
  });
}

test('cutClip 将 acceptGaps 传入扫描并按保留缺口后的全部可用切片导出', async (t) => {
  const { archive, root, probes, mediaRuns } = fixture(t);
  const previous = process.env.HIKVISION_ARTIFACT_DIR;
  process.env.HIKVISION_ARTIFACT_DIR = path.join(root, 'artifacts');
  t.after(() => {
    if (previous === undefined) delete process.env.HIKVISION_ARTIFACT_DIR;
    else process.env.HIKVISION_ARTIFACT_DIR = previous;
  });
  const outputFile = path.join(root, 'accepted.mp4');
  let deliveredCoverage;
  const output = await archive.cutClip(camera, start, end, {
    outputFile, mode: 'copy', acceptGaps: true, onCoverage: coverage => { deliveredCoverage = coverage; },
  });
  assert.equal(output, outputFile);
  assert.ok(fs.existsSync(outputFile));
  assert.deepEqual(probes, [names.recent, names.middle, names.boundary]);
  assert.equal(deliveredCoverage.hasGaps, true);
  assert.equal(deliveredCoverage.missingSeconds, 60);
  assert.equal(mediaRuns.length, 4);
  assert.deepEqual(mediaRuns.slice(0, 3).map(args => [
    path.basename(args[args.indexOf('-i') + 1]), args[args.indexOf('-ss') + 1], args[args.indexOf('-t') + 1],
  ]), [[names.boundary, '60', '30'], [names.middle, '0', '30'], [names.recent, '0', '60']]);
  assert.ok(mediaRuns.at(-1).includes('concat'));
});

test('强制 MediaMTX 的 planClip 将 acceptGaps 传入真实归档扫描', async (t) => {
  const { archive, probes } = fixture(t);
  const resolver = createVideoResolver({ archive });
  const plan = await resolver.planClip({ camera, start, end, forceArchive: true, acceptGaps: true });
  assert.deepEqual(probes, [names.recent, names.middle, names.boundary]);
  assert.equal(plan.source, 'mediamtx');
  assert.equal(plan.acceptGaps, true);
  assert.equal(plan.coverage.hasGaps, true);
  assert.equal(plan.coverage.missingSeconds, 60);
});
