import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareConsoleExport } from '../lib/console-export.js';
import { createMediaArchive } from '../lib/media-archive.js';

const startMs = Date.UTC(2026, 0, 1, 10), endMs = startMs + 60_000;
const selection = { source: 'mediamtx', camera: 'camera-a', start: '2026-01-01 10:00:00', end: '2026-01-01 10:01:00' };
const segments = [
  { startMs: startMs + 1_000, endMs: startMs + 10_000 },
  { startMs: startMs + 20_000, endMs: startMs + 50_000 },
];

function dependencies(overrides = {}) {
  return {
    resolveCamera: () => ({ camera: { id: 'camera-a', archivePath: 'archive-a' }, device: null }),
    archive: { hasRecording: () => assert.fail('HTTP preflight must not probe the full archive') },
    startHikvision: () => assert.fail('an explicit MediaMTX export must not use a recorder'),
    playback: { listRange: async () => segments },
    ...overrides,
  };
}

test('console preflight reports each server catalog gap without probing files or trusting client coverage', async () => {
  let lookupCount = 0, called;
  const controller = new AbortController();
  const job = prepareConsoleExport({ ...selection, coverage: { complete: true, missingIntervals: [] } }, dependencies({
    resolveCamera: () => { lookupCount++; return { camera: { id: 'camera-a', archivePath: 'archive-a' }, device: null }; },
    playback: { listRange: async (...args) => { called = args; return segments; } },
  }));
  assert.equal(lookupCount, 1);
  await assert.rejects(job.preflight({ signal: controller.signal }), error => {
    assert.equal(error.code, 'MEDIAMTX_GAPS');
    assert.deepEqual(error.coverage.missingIntervals.map(gap => [gap.startMs, gap.endMs]), [
      [startMs, startMs + 1_000], [startMs + 10_000, startMs + 20_000], [startMs + 50_000, endMs],
    ]);
    assert.equal(error.coverage.missingSeconds, 21);
    assert.equal(error.coverage.availableSeconds, 39);
    return true;
  });
  assert.deepEqual(called, ['archive-a', selection.start, selection.end, { signal: controller.signal }]);
  assert.equal(lookupCount, 1, 'use the captured server mapping, not a second possibly changed lookup');
});

test('accepted preflight retains the selected range and explicit source without changing queue identity', async () => {
  const accepted = prepareConsoleExport({ ...selection, acceptGaps: true }, dependencies());
  const plan = await accepted.preflight();
  assert.equal(plan.source, 'mediamtx'); assert.equal(plan.strategy, 'local-cut');
  assert.equal(plan.acceptGaps, true); assert.equal(plan.coverage.missingSeconds, 21);
  assert.equal(accepted.start, selection.start); assert.equal(accepted.end, selection.end);
  assert.equal(accepted.requestKey, prepareConsoleExport({ ...selection, acceptGaps: true }, dependencies()).requestKey);
  assert.notEqual(accepted.requestKey, prepareConsoleExport(selection, dependencies()).requestKey);
  assert.notEqual(accepted.requestKey, prepareConsoleExport({ ...selection, end: '2026-01-01 10:02:00', acceptGaps: true }, dependencies()).requestKey);
});

test('empty server catalog cannot be exported even after accepting gaps', async () => {
  for (const acceptGaps of [false, true]) {
    const job = prepareConsoleExport({ ...selection, acceptGaps }, dependencies({ playback: { listRange: async () => [] } }));
    await assert.rejects(job.preflight(), error => error.code === 'MEDIAMTX_EMPTY' && error.coverage.availableSeconds === 0);
  }
});

test('a cancelled preflight cannot supply an admission plan after the catalog returns', async () => {
  let resolve;
  const controller = new AbortController();
  const job = prepareConsoleExport(selection, dependencies({ playback: { listRange: () => new Promise(done => { resolve = done; }) } }));
  const pending = job.preflight({ signal: controller.signal });
  controller.abort(); resolve([{ startMs, endMs }]);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('execution verifies actual files once after fast preflight and publishes no output when coverage changed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-preflight-files-'));
  try {
    const dir = path.join(root, 'archive-a'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '2026-01-01_10-00-00.mp4'), 'synthetic-recording');
    let probes = 0;
    const archive = createMediaArchive({ root, run: async () => { probes++; return { stdout: JSON.stringify({ format: { duration: 20 } }) }; } });
    const job = prepareConsoleExport(selection, dependencies({ archive, playback: { listRange: async () => [{ startMs, endMs }] } }));
    const plan = await job.preflight();
    assert.equal(probes, 0, 'fast preflight must not issue a file probe');
    const outputFile = path.join(root, 'must-not-publish.mp4'), progress = [];
    await assert.rejects(job.execute({ plan, outputFile, onProgress: (...args) => progress.push(args) }), { code: 'MEDIAMTX_GAPS' });
    assert.equal(probes, 1, 'execution uses its supplied source plan and only then validates files');
    assert.match(progress[0][1], /核验所选时段的录像文件/);
    assert.equal(progress[0][0], null, 'file discovery must not invent a progress percentage');
    assert.equal(fs.existsSync(outputFile), false);
    fs.unlinkSync(path.join(dir, '2026-01-01_10-00-00.mp4'));
    const accepted = prepareConsoleExport({ ...selection, acceptGaps: true }, dependencies({ archive }));
    await assert.rejects(accepted.execute({ plan: await accepted.preflight(), outputFile }), { code: 'MEDIAMTX_EMPTY' });
    assert.equal(fs.existsSync(outputFile), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
