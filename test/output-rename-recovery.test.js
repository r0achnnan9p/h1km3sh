import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOutputRenameJournal } from '../lib/output-rename-journal.js';
import { createMediaJobStore } from '../lib/media-job-store.js';
import { createExportRecoveryStore } from '../lib/export-recovery.js';
import { captureOutputSource, outputId, renameLibraryOutput } from '../lib/output-library.js';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-recovery-')), downloads = path.join(dir, 'downloads'); fs.mkdirSync(downloads);
  const journalFile = path.join(dir, 'renames.json'), old = path.join(downloads, 'old.mp4'), target = path.join(downloads, 'new.mp4');
  fs.writeFileSync(old, 'video');
  const source = captureOutputSource(downloads, old), task = { taskId: crypto.randomUUID(), queuedAt: 1, status: 'completed', filename: 'old.mp4', size: 5 };
  const media = createMediaJobStore(path.join(dir, 'media')), exports = createExportRecoveryStore(path.join(dir, 'queue'));
  media.save(task); exports.admit(task, { type: 'legacy' });
  const callback = change => { media.renameOutput(change); exports.renameOutput(change); };
  const journal = createOutputRenameJournal(downloads, journalFile); journal.begin(source, 'new.mp4');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, downloads, old, target, source, task, media, exports, callback, journalFile, journal };
}
for (const point of ['before-link', 'after-link', 'after-unlink', 'after-metadata']) {
  test(`rename crash recovery at ${point} preserves the video and reconciles both indices`, t => {
    const f = fixture(t);
    if (point !== 'before-link') fs.linkSync(f.old, f.target);
    if (['after-unlink', 'after-metadata'].includes(point)) fs.unlinkSync(f.old);
    if (point === 'after-metadata') f.callback({ source: f.source, target: captureOutputSource(f.downloads, f.target) });
    const fresh = createOutputRenameJournal(f.downloads, f.journalFile);
    assert.deepEqual(fresh.recover(f.callback), []);
    assert.equal(fs.existsSync(f.old), false); assert.equal(fs.readFileSync(f.target, 'utf8'), 'video');
    assert.equal(f.media.read(f.task.taskId).filename, 'new.mp4');
    assert.equal(createExportRecoveryStore(path.join(f.dir, 'queue')).load()[0].task.filename, 'new.mp4');
    assert.deepEqual(fresh.recover(f.callback), []); assert.equal(fresh.isBusy('new.mp4'), false);
  });
}
test('rename recovery never removes unrelated replaced source/target and keeps pending intent visible', t => {
  const f = fixture(t); fs.writeFileSync(f.target, 'other');
  const fresh = createOutputRenameJournal(f.downloads, f.journalFile);
  assert.equal(fresh.recover(f.callback).length, 1); assert.equal(fresh.isBusy('old.mp4'), true);
  assert.equal(fs.readFileSync(f.old, 'utf8'), 'video'); assert.equal(fs.readFileSync(f.target, 'utf8'), 'other');
  assert.equal(f.media.read(f.task.taskId).filename, 'old.mp4');
});
test('metadata failure after filesystem rename retains intent for the next restart', t => {
  const f = fixture(t);
  assert.throws(() => renameLibraryOutput(f.downloads, outputId('old.mp4'), 'new.mp4', { onRename() { throw new Error('disk unavailable'); } }), /文件已改名/);
  assert.deepEqual(createOutputRenameJournal(f.downloads, f.journalFile).recover(f.callback), []);
  assert.equal(f.media.read(f.task.taskId).filename, 'new.mp4'); assert.equal(fs.readFileSync(f.target, 'utf8'), 'video');
});
