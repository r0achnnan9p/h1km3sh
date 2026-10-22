import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameManagedOutputFile } from '../lib/managed-output-rename.js';
import { createOutputRenameJournal } from '../lib/output-rename-journal.js';
import { listOutputLibrary, outputId } from '../lib/output-library.js';
import { listOutputFiles } from '../lib/output-files.js';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'old.mp4'); fs.writeFileSync(old, 'original video bytes');
  const journal = createOutputRenameJournal(root, path.join(root, 'journal.json'));
  const rename = (name, options = {}) => renameManagedOutputFile(root, outputId('old.mp4'), name, { journal, onRename() {}, ...options });
  return { root, old, journal, rename };
}
test('Chinese, embedded spaces and omitted extension produce one usable output', t => {
  const f = fixture(t), name = '天行者 vs 金茂悦  2026-09-30';
  const result = f.rename(name);
  assert.equal(result.filename, name + '.mp4');
  assert.equal(fs.readFileSync(path.join(f.root, result.filename), 'utf8'), 'original video bytes');
  assert.deepEqual(listOutputLibrary(f.root).map(file => file.filename), [result.filename]);
  assert.equal(f.journal.isBusy(result.relativePath), false);
});
for (const code of ['EXDEV', 'EPERM', 'ENOSPC', 'EOPNOTSUPP']) test(`${code} before link preserves original and unlocks intent; never copies gigabytes`, t => {
  const f = fixture(t);
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error(code), { code }); });
  t.mock.method(fs, 'copyFileSync', () => assert.fail('must not copy or create a partial MP4'));
  assert.throws(() => f.rename('new'), { code });
  assert.equal(f.journal.isBusy('old.mp4'), false); assert.equal(f.journal.isBusy('new.mp4'), false);
  assert.equal(fs.existsSync(path.join(f.root, 'new.mp4')), false);
  assert.equal(fs.readFileSync(f.old, 'utf8'), 'original video bytes');
});
for (const removed of [false, true]) test(`transient unlink error (${removed}) reconciles immediately`, t => {
  const f = fixture(t), unlink = fs.unlinkSync; let first = true;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === f.old && first) { first = false; if (removed) unlink(file); throw Object.assign(new Error('I/O'), { code: 'EIO' }); }
    return unlink(file);
  });
  assert.equal(f.rename('new').filename, 'new.mp4');
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'new.mp4'), 'utf8'), 'original video bytes');
  assert.equal(f.journal.isBusy('new.mp4'), false);
});
test('transient metadata failure retries without another filesystem rename', t => {
  const f = fixture(t); let attempts = 0;
  assert.equal(f.rename('new', { onRename(change) { attempts++; if (attempts === 1) throw new Error('temporary'); assert.equal(change.target.relativePath, 'new.mp4'); } }).filename, 'new.mp4');
  assert.equal(attempts, 2); assert.equal(f.journal.isBusy('new.mp4'), false);
});
test('persistent unlink failure preserves both links and later recovers exactly once', t => {
  const f = fixture(t), unlink = fs.unlinkSync; let blocked = true, calls = 0;
  t.mock.method(fs, 'unlinkSync', file => { if (file === f.old && blocked) throw new Error('storage read only'); return unlink(file); });
  assert.throws(() => f.rename('new'), { code: 'OUTPUT_RENAME_PENDING' });
  assert.equal(f.journal.isBusy('old.mp4'), true); assert.equal(f.journal.isBusy('new.mp4'), true);
  assert.equal(fs.readFileSync(f.old, 'utf8'), 'original video bytes');
  assert.equal(fs.readFileSync(path.join(f.root, 'new.mp4'), 'utf8'), 'original video bytes');
  blocked = false;
  assert.deepEqual(f.journal.recover(() => { calls++; }), []);
  assert.deepEqual(f.journal.recover(() => { calls++; }), []); assert.equal(calls, 1);
  assert.deepEqual(listOutputLibrary(f.root).map(file => file.filename), ['new.mp4']);
});
for (const busy of ['old.mp4', 'new.mp4']) test(`queued or active upload/export on ${busy} blocks before mutation`, t => {
  const f = fixture(t);
  assert.throws(() => f.rename('new', { isBusy: name => name === busy }), { code: 'OUTPUT_BUSY' });
  assert.equal(fs.existsSync(f.old), true); assert.equal(fs.existsSync(path.join(f.root, 'new.mp4')), false);
  assert.equal(f.journal.isBusy('old.mp4'), false);
});
test('both catalogs exclude zero-byte placeholders, directories, and symlinks', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'empty.mp4'), ''); fs.mkdirSync(path.join(f.root, 'directory.mp4'));
  fs.symlinkSync(f.old, path.join(f.root, 'link.mp4'));
  for (const list of [listOutputFiles, listOutputLibrary]) assert.deepEqual(list(f.root).map(file => file.filename), ['old.mp4']);
});
test('explicit path recovery cancels untouched errors and guards both queue references', t => {
  const f = fixture(t);
  const source = { relativePath: 'old.mp4', identity: Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, fs.statSync(f.old)[key]])) };
  f.journal.begin(source, 'new.mp4');
  assert.equal(f.journal.recoverPath('old.mp4', () => {}, { isBusy: name => name === 'new.mp4' }).length, 1);
  assert.equal(f.journal.isBusy('old.mp4'), true);
  assert.deepEqual(f.journal.recoverPath('old.mp4', () => assert.fail('untouched rename should be cancelled')), []);
  assert.equal(f.journal.isBusy('old.mp4'), false); assert.equal(fs.existsSync(f.old), true);
});
test('link that succeeds before reporting I/O error is reconciled without duplicate entries', t => {
  const f = fixture(t), link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (source, target) => { link(source, target); throw Object.assign(new Error('late I/O'), { code: 'EIO' }); });
  assert.equal(f.rename('new').filename, 'new.mp4');
  assert.deepEqual(listOutputLibrary(f.root).map(file => file.filename), ['new.mp4']);
});
test('a conflicting existing video never gets overwritten or held by a failed rename', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'new.mp4'), 'other video');
  assert.throws(() => f.rename('new'), { code: 'OUTPUT_EXISTS' });
  assert.equal(fs.readFileSync(f.old, 'utf8'), 'original video bytes');
  assert.equal(fs.readFileSync(path.join(f.root, 'new.mp4'), 'utf8'), 'other video');
  assert.equal(f.journal.isBusy('old.mp4'), false); assert.equal(f.journal.isBusy('new.mp4'), false);
});
test('metadata failure retains recoverable state while bytes and fresh download reference stay valid', t => {
  const f = fixture(t);
  assert.throws(() => f.rename('new', { onRename() { throw new Error('metadata unavailable'); } }), { code: 'OUTPUT_RENAME_PENDING' });
  const [file] = listOutputLibrary(f.root);
  assert.equal(file.filename, 'new.mp4'); assert.equal(file.streamUrl, `/console/api/outputs/${outputId('new.mp4')}/stream`);
  assert.equal(fs.readFileSync(path.join(f.root, file.filename), 'utf8'), 'original video bytes');
  assert.deepEqual(f.journal.recoverPath('new.mp4', () => {}), []); assert.equal(f.journal.isBusy('new.mp4'), false);
});
for (const stage of ['begin', 'finish-once', 'finish-persistent']) test(`journal ${stage} write failure preserves bytes and supports reconciliation`, t => {
  const f = fixture(t), rename = fs.renameSync; let calls = 0, fail = true;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path.join(f.root, 'journal.json')) {
      calls++;
      if (fail && ((stage === 'begin' && calls === 1) || (stage === 'finish-once' && calls === 2)
        || (stage === 'finish-persistent' && calls >= 2))) throw Object.assign(new Error('journal disk unavailable'), { code: 'EIO' });
    }
    return rename(source, target);
  });
  if (stage === 'finish-once') assert.equal(f.rename('new').filename, 'new.mp4');
  else assert.throws(() => f.rename('new'));
  const remaining = fs.existsSync(f.old) ? f.old : path.join(f.root, 'new.mp4');
  assert.equal(fs.readFileSync(remaining, 'utf8'), 'original video bytes');
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')), false);
  fail = false;
  assert.deepEqual(f.journal.recoverPath(path.basename(remaining), () => {}), []);
  assert.equal(f.journal.isBusy(path.basename(remaining)), false);
});
test('replaced source inode during failed unlink is never deleted by automatic recovery', t => {
  const f = fixture(t), unlink = fs.unlinkSync; let changed = false;
  t.mock.method(fs, 'unlinkSync', file => {
    if (file === f.old && !changed) { changed = true; unlink(file); fs.writeFileSync(file, 'replacement'); throw new Error('source replaced'); }
    return unlink(file);
  });
  assert.throws(() => f.rename('new'), { code: 'OUTPUT_RENAME_PENDING' });
  assert.equal(fs.readFileSync(f.old, 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(path.join(f.root, 'new.mp4'), 'utf8'), 'original video bytes');
  assert.equal(f.journal.recoverPath('old.mp4', () => {}).length, 1);
  assert.equal(fs.readFileSync(f.old, 'utf8'), 'replacement');
});
test('nested camera output respects exact relative-path export and upload reservations', t => {
  const f = fixture(t), relative = 'camera_0123456789abcdef/old.mp4';
  fs.mkdirSync(path.dirname(path.join(f.root, relative))); fs.renameSync(f.old, path.join(f.root, relative));
  assert.equal(listOutputLibrary(f.root, { inProgress: new Set([relative]) })[0].busy, true);
  assert.throws(() => renameManagedOutputFile(f.root, outputId(relative), 'new', {
    journal: f.journal, isBusy: name => name === relative,
  }), { code: 'OUTPUT_BUSY' });
  assert.equal(fs.readFileSync(path.join(f.root, relative), 'utf8'), 'original video bytes');
});
