import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordingCoverage, createMediaArchive, runMedia } from '../lib/media-archive.js';
import { prepareConsoleExport } from '../lib/console-export.js';
import { createVideoResolver } from '../lib/video-resolver.js';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';

const start = '2026-01-01 00:00:00', end = '2026-01-01 00:00:10';
const base = Date.UTC(2026, 0, 1);
const partial = recordingCoverage([
  { startMs: base + 1000, endMs: base + 3000 },
  { startMs: base + 5000, endMs: base + 9000 },
], base, base + 10000).coverage;

test('coverage preserves leading, internal, trailing and sub-second gaps; overlap is counted once', () => {
  const { slices, coverage } = recordingCoverage([
    { startMs: 4000, endMs: 9000 }, { startMs: 1000, endMs: 3000 },
    { startMs: 2000, endMs: 4000 }, { startMs: 9000.25, endMs: 10000 },
    { startMs: NaN, endMs: 7000 },
  ], 0, 11000);
  assert.deepEqual(coverage.missingIntervals.map(x => [x.startMs, x.endMs]), [[0, 1000], [9000, 9000.25], [10000, 11000]]);
  assert.equal(coverage.missingSeconds, 2.00025);
  assert.equal(coverage.availableSeconds, 8.99975);
  assert.ok(Math.abs(slices.reduce((s, x) => s + x.duration, 0) - coverage.availableSeconds) < 1e-9);
  assert.equal(recordingCoverage([], 0, 100).coverage.hasFootage, false);
});

test('explicit MediaMTX gaps require consent, never call DVR, and preserve consent in identity/metadata', async () => {
  let calls = 0, cutOptions;
  const dependencies = {
    resolveCamera: () => ({ camera: { id: 'D2' }, device: { id: 'dvr', ip: '192.0.2.1' } }),
    startHikvision: () => { calls++; throw new Error('must not call DVR'); },
    archive: {
      hasRecording: async () => ({ exists: false, coverage: partial }),
      cutClip: async (_camera, _start, _end, options) => { cutOptions = options; options.onCoverage(partial); return 'result.mp4'; },
    },
  };
  const args = { camera: 'D2', source: 'mediamtx', start, end };
  const blocked = prepareConsoleExport(args, dependencies);
  await assert.rejects(blocked.plan({}), error => error.code === 'MEDIAMTX_GAPS' && error.coverage.missingSeconds === 4);
  const accepted = prepareConsoleExport({ ...args, acceptGaps: true }, dependencies);
  const result = await accepted.execute({});
  assert.equal(cutOptions.acceptGaps, true);
  assert.equal(result.acceptGaps, true);
  assert.deepEqual(result.coverage, partial);
  assert.notEqual(blocked.requestKey, accepted.requestKey);
  assert.equal(calls, 0);
  for (const acceptGaps of ['true', 1, null]) assert.throws(() => prepareConsoleExport({ ...args, acceptGaps }, dependencies), /布尔/);
});

test('empty MediaMTX and incompatible supplied source plan reject even with consent', async () => {
  const resolver = createVideoResolver({ archive: { hasRecording: async () => ({ exists: false,
    coverage: recordingCoverage([], base, base + 10000).coverage }) }, startHikvision: () => assert.fail('DVR must not run') });
  await assert.rejects(resolver.planClip({ camera: {}, start, end, forceArchive: true, acceptGaps: true }), { code: 'MEDIAMTX_EMPTY' });
  await assert.rejects(resolver.resolveClip({ camera: {}, start, end, forceArchive: true, acceptGaps: true,
    plan: { source: 'hikvision' } }), /不能切换/);
});

test('real MediaMTX copy exports remaining footage after explicit consent and rejects corrupt/empty sources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-export-'));
  const previous = process.env.HIKVISION_ARTIFACT_DIR;
  process.env.HIKVISION_ARTIFACT_DIR = path.join(root, 'artifacts');
  try {
    const dir = path.join(root, 'd2'); fs.mkdirSync(dir);
    for (const name of ['2026-01-01_00-00-01.mp4', '2026-01-01_00-00-05.mp4']) {
      await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10',
        '-t', '2', '-c:v', 'libx264', '-g', '10', '-bf', '0', path.join(dir, name)]);
    }
    fs.writeFileSync(path.join(dir, '2026-01-01_00-00-08.mp4'), 'unusable recording');
    const archive = createMediaArchive({ root }), camera = { archivePath: 'd2' };
    const coverage = await archive.inspectCoverage(camera, start, end);
    assert.equal(coverage.missingSeconds, 6);
    assert.equal(coverage.availableSeconds, 4);
    const outputFile = path.join(root, 'accepted.mp4');
    await assert.rejects(archive.cutClip(camera, start, end, { outputFile, mode: 'copy' }), { code: 'MEDIAMTX_GAPS' });
    assert.equal(fs.existsSync(outputFile), false);
    let deliveredCoverage;
    await archive.cutClip(camera, start, end, { outputFile, mode: 'copy', acceptGaps: true, onCoverage: x => { deliveredCoverage = x; } });
    assert.deepEqual(deliveredCoverage, coverage);
    const { stdout } = await runMedia(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outputFile]);
    assert.ok(Math.abs(Number(JSON.parse(stdout).format.duration) - 4) < 0.2, stdout);
    await assert.rejects(archive.cutClip(camera, '2026-01-01 00:00:08', end, { acceptGaps: true }), { code: 'MEDIAMTX_EMPTY' });
    assert.deepEqual(fs.readdirSync(path.join(root, 'artifacts', '.work')), []);
  } finally {
    if (previous === undefined) delete process.env.HIKVISION_ARTIFACT_DIR; else process.env.HIKVISION_ARTIFACT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scan does not report false gaps when an older overlapping recording covers the window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-scan-'));
  try {
    const dir = path.join(root, 'd2'); fs.mkdirSync(dir);
    for (const name of ['2025-12-31_23-59-59.mp4', '2026-01-01_00-00-00.mp4', '2026-01-01_00-00-05.mp4']) fs.writeFileSync(path.join(dir, name), 'fixture');
    const archive = createMediaArchive({ root, run: async (_binary, args) => ({ stdout: JSON.stringify({ format: {
      duration: args.at(-1).endsWith('23-59-59.mp4') ? 20 : 1,
    } }) }) });
    const coverage = await archive.inspectCoverage({ archivePath: 'd2' }, start, end);
    assert.equal(coverage.complete, true);
    assert.equal(coverage.missingSeconds, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('execution rechecks archive coverage instead of trusting a complete preflight plan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-stale-'));
  try {
    const archive = createMediaArchive({ root });
    const job = prepareConsoleExport({ camera: 'D2', source: 'mediamtx', start, end }, {
      resolveCamera: () => ({ camera: { id: 'D2', archivePath: 'd2' }, device: { id: 'dvr', ip: '192.0.2.1' } }), archive,
      startHikvision: () => assert.fail('DVR must not run'),
    });
    await assert.rejects(job.execute({ plan: { source: 'mediamtx', strategy: 'local-cut', coverage: { complete: true } } }), { code: 'MEDIAMTX_EMPTY' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
