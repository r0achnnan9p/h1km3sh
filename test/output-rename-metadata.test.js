import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameOutputFile } from '../lib/output-files.js';
import { captureOutputSource, createOutputAlias, listOutputLibrary, outputId, renameLibraryOutput } from '../lib/output-library.js';
import { createMediaJobStore } from '../lib/media-job-store.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function published(t) {
  const root = fixture(t), source = 'camera_0123456789abcdef/native.mp4', filename = '友好成片.mp4';
  fs.mkdirSync(path.dirname(path.join(root, source)));
  fs.writeFileSync(path.join(root, source), 'video');
  const sourceOutput = captureOutputSource(root, path.join(root, source));
  fs.copyFileSync(path.join(root, source), path.join(root, filename));
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.linkSync(path.join(root, filename), path.join(root, 'artifacts', 'immutable.mp4'));
  const file = { sourceIdentity: 'a'.repeat(64), filename, size: 5, camera: 'D2', start: '2026-09-29 20:10:00', end: '2026-09-29 20:30:00', mode: 'copy',
    artifactUrl: '/artifacts/videos/clips/12345678-1234-1234-1234-123456789abc.mp4',
    outputAlias: createOutputAlias(root, sourceOutput, filename) };
  const store = createMediaJobStore(path.join(root, 'jobs'));
  return { root, source, filename, file, store };
}

const clipId = '11111111-1111-1111-1111-111111111111';
const batchId = '22222222-2222-2222-2222-222222222222';

test('same-name rename is a true no-op, while a missing same-name source returns null', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'one.mp4'), 'video');
  const before = captureOutputSource(root, path.join(root, 'one.mp4'));
  assert.deepEqual(renameLibraryOutput(root, outputId('one.mp4'), 'one.mp4', {
    onRename() { assert.fail('no-op must not rewrite metadata'); },
  }), { filename: 'one.mp4', relativePath: 'one.mp4' });
  assert.deepEqual(captureOutputSource(root, path.join(root, 'one.mp4')), before);
  assert.equal(renameOutputFile(root, 'missing.mp4', 'missing.mp4'), null);
  assert.equal(renameLibraryOutput(root, outputId('missing.mp4'), 'missing.mp4'), null);
  for (const filename of ['bad\n.mp4', 'bad\0.mp4', 'bad\x7f.mp4']) {
    assert.throws(() => renameOutputFile(root, 'one.mp4', filename), /不合法/);
  }
});

test('a racing destination is never overwritten by legacy rename', t => {
  const root = fixture(t), src = path.join(root, 'one.mp4'), dst = path.join(root, 'two.mp4');
  fs.writeFileSync(src, 'original');
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (source, target) => {
    fs.writeFileSync(target, 'racing video');
    return link(source, target);
  });
  assert.throws(() => renameOutputFile(root, 'one.mp4', 'two.mp4'), { code: 'OUTPUT_EXISTS' });
  assert.equal(fs.readFileSync(src, 'utf8'), 'original');
  assert.equal(fs.readFileSync(dst, 'utf8'), 'racing video');
});

for (const removed of [false, true]) test(`ambiguous source unlink (${removed ? 'already removed' : 'still present'}) never deletes the new video path`, t => {
  const root = fixture(t), src = path.join(root, 'one.mp4'), dst = path.join(root, 'two.mp4');
  fs.writeFileSync(src, 'original');
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => {
    assert.equal(file, src, 'must never try deleting the destination as rollback');
    if (removed) unlink(file);
    throw Object.assign(new Error('ambiguous unlink error'), { code: 'EIO' });
  });
  assert.throws(() => renameOutputFile(root, 'one.mp4', 'two.mp4'), { code: 'OUTPUT_RENAME_PARTIAL' });
  assert.equal(fs.existsSync(src), !removed);
  assert.equal(fs.readFileSync(dst, 'utf8'), 'original');
});

test('friendly rename updates persisted and live jobs, keeps provenance hidden, and preserves UUID URLs', t => {
  const { root, source, file, store } = published(t);
  const clip = { taskId: clipId, kind: 'clip', status: 'completed', ...file };
  const batch = { taskId: batchId, kind: 'batch', status: 'downloading', files: [structuredClone(file)], controller: { live: true } };
  store.save(clip); store.save(batch);
  const publishedFile = batch.files[0];
  const history = path.join(root, 'jobs', 'upload-history.json');
  fs.writeFileSync(history, JSON.stringify({ filename: file.filename, status: 'completed', remoteName: file.filename }));
  const historical = fs.readFileSync(history, 'utf8');
  const result = renameLibraryOutput(root, outputId(file.filename), '改名录像.mp4', {
    onRename: change => store.renameOutput(change, [clip, batch]),
  });
  const reopened = createMediaJobStore(path.join(root, 'jobs'));
  for (const updated of [clip, batch.files[0], reopened.read(clipId), reopened.read(batchId).files[0]]) {
    assert.equal(updated.filename, result.filename);
    assert.equal(updated.artifactUrl, file.artifactUrl);
    assert.equal(updated.outputAlias.target.relativePath, result.relativePath);
    assert.equal(updated.outputAlias.source.relativePath, source);
    assert.deepEqual(updated.outputAlias.target, captureOutputSource(root, path.join(root, result.filename)));
  }
  assert.deepEqual(batch.controller, { live: true });
  assert.equal(publishedFile.filename, result.filename, 'the running batch callback must not write its old filename back');
  assert.deepEqual(listOutputLibrary(root, { aliases: reopened.outputAliases() }).map(item => item.filename), [result.filename]);
  assert.equal(reopened.findByRange(file, root).filename, result.filename);
  assert.equal(reopened.findFile({ ...file, filename: result.filename }, root).filename, result.filename);
  assert.equal(reopened.findByRange(file, root, file.filename), null);
  assert.equal(fs.readFileSync(history, 'utf8'), historical);
  assert.equal(fs.readFileSync(path.join(root, source), 'utf8'), 'video');
  assert.equal(fs.readFileSync(path.join(root, 'artifacts', 'immutable.mp4'), 'utf8'), 'video');
  // A subsequent active-batch save must not resurrect the old name/provenance.
  store.save(batch);
  assert.equal(reopened.read(batchId).files[0].filename, result.filename);
});

test('range reuse metadata without provenance follows a filename rename without inventing an alias', t => {
  const { root, file, store } = published(t);
  const { outputAlias, ...historical } = file;
  store.save({ taskId: clipId, kind: 'clip', status: 'completed', ...historical });
  renameLibraryOutput(root, outputId(file.filename), 'new.mp4', { onRename: change => store.renameOutput(change) });
  const result = store.findByRange(file, root);
  assert.equal(result.filename, 'new.mp4');
  assert.equal(result.artifactUrl, file.artifactUrl);
  assert.equal(result.outputAlias, undefined);
});

test('renaming a native source follows only its alias, not another file with its basename', t => {
  const { root, source, file, store } = published(t);
  store.save({ taskId: clipId, kind: 'clip', status: 'completed', ...file });
  store.save({ taskId: batchId, kind: 'clip', status: 'completed', ...file, filename: 'native.mp4', outputAlias: undefined });
  fs.writeFileSync(path.join(root, 'native.mp4'), 'other');
  const result = renameLibraryOutput(root, outputId(source), 'source-new.mp4', { onRename: change => store.renameOutput(change) });
  const updated = store.read(clipId);
  assert.equal(updated.filename, file.filename);
  assert.equal(updated.outputAlias.source.relativePath, result.relativePath);
  assert.equal(store.read(batchId).filename, 'native.mp4');
  assert.deepEqual(listOutputLibrary(root, { aliases: store.outputAliases() }).map(item => item.filename).sort(), [file.filename, 'native.mp4'].sort());
});

test('renaming a replaced target never repairs stale provenance or hides the native original', t => {
  const { root, source, file, store } = published(t);
  store.save({ taskId: clipId, kind: 'clip', status: 'completed', ...file });
  fs.writeFileSync(path.join(root, file.filename), 'other');
  fs.utimesSync(path.join(root, file.filename), new Date(0), new Date(0));
  renameLibraryOutput(root, outputId(file.filename), 'new.mp4', { onRename: change => store.renameOutput(change) });
  assert.deepEqual(store.read(clipId).outputAlias, file.outputAlias);
  assert.deepEqual(listOutputLibrary(root, { aliases: store.outputAliases() }).map(item => item.relativePath).sort(), [source, 'new.mp4'].sort());
});

test('metadata persistence failure reports a partial result without rolling back or deleting video', t => {
  const { root, file, store } = published(t);
  const clip = { taskId: clipId, kind: 'clip', status: 'completed', ...file };
  store.save(clip);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (filename, ...args) => {
    if (filename === path.join(root, 'jobs', `${clipId}.json.tmp`)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return open(filename, ...args);
  });
  assert.throws(() => renameLibraryOutput(root, outputId(file.filename), 'new.mp4', {
    onRename: change => store.renameOutput(change, [clip]),
  }), error => error.code === 'OUTPUT_METADATA_FAILED' && error.renamed.filename === 'new.mp4');
  assert.equal(fs.existsSync(path.join(root, file.filename)), false);
  assert.equal(fs.readFileSync(path.join(root, 'new.mp4'), 'utf8'), 'video');
  assert.equal(clip.filename, 'new.mp4');
  assert.equal(store.read(clipId).filename, file.filename, 'an unwritten record must not be represented as persisted');
});
