import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMediaJobStore } from '../lib/media-job-store.js';
import { cameraRecoveryRequest, createExportRecoveryStore } from '../lib/export-recovery.js';

test('gap consent and strict archive source survive durable recovery without credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-recovery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = cameraRecoveryRequest('clip', { camera: 'D1', start: '2026-01-01 00:00', end: '2026-01-01 00:01', acceptGaps: true },
    { id: 'D1', channel: '101', deviceId: 'd1', archivePath: 'D1' }, { id: 'd1', ip: '192.0.2.1', password: 'private' }, false, 'gap.mp4', true);
  const store = createExportRecoveryStore(root), taskId = crypto.randomUUID();
  const coverage = { hasGaps: true, missingSeconds: 3, availableSeconds: 57, requestedSeconds: 60, missingIntervals: [{ startMs: 10, endMs: 13 }] };
  store.admit({ taskId, queuedAt: 1, status: 'queued', coverage, acceptGaps: true }, request);
  const record = createExportRecoveryStore(root).load()[0];
  assert.equal(record.request.forceArchive, true); assert.equal(record.request.args.acceptGaps, true);
  assert.deepEqual(record.task.coverage, coverage); assert.equal(JSON.stringify(record).includes('private'), false);
});

test('gapped completed files require explicit consent and cannot satisfy a changed gap set or different source', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-provenance-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMediaJobStore(path.join(root, 'jobs')), filename = 'gap.mp4'; fs.writeFileSync(path.join(root, filename), 'video');
  const range = { sourceIdentity: 'a'.repeat(64), camera: 'D1', start: '2026-01-01 00:00', end: '2026-01-01 00:01', mode: 'copy' };
  const coverage = { hasGaps: true, missingSeconds: 3, availableSeconds: 57, requestedSeconds: 60, missingIntervals: [{ startMs: 10, endMs: 13 }] };
  const task = { ...range, taskId: crypto.randomUUID(), status: 'completed', kind: 'clip', source: 'mediamtx', filename, size: 5,
    artifactUrl: '/artifacts/videos/clips/result.mp4', coverage, acceptGaps: true };
  store.save(task);
  assert.deepEqual(store.read(task.taskId).coverage, coverage);
  assert.equal(store.findByRange(range, root), null);
  assert.equal(store.findByRange({ ...range, acceptGaps: true, requiredSource: 'hikvision' }, root), null);
  assert.equal(store.findByRange({ ...range, acceptGaps: true, requiredSource: 'mediamtx', expectedCoverage: { hasGaps: false } }, root), null);
  assert.equal(store.findByRange({ ...range, acceptGaps: true, expectedCoverage: { ...coverage, missingIntervals: [{ startMs: 20, endMs: 23 }] } }, root), null);
  assert.equal(store.findByRange({ ...range, acceptGaps: true, requiredSource: 'mediamtx', expectedCoverage: coverage }, root).filename, filename);
});
