import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureOutputSource, createOutputAlias, deleteLibraryOutput, listOutputLibrary, outputId, renameLibraryOutput, resolveLibraryOutput } from '../lib/output-library.js';

test('成片库只列顶层和受管摄像头目录中的 MP4，并防止路径穿越', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-library-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'output-library-outside-'));
  try {
    const camera = path.join(root, 'camera_0123456789abcdef'); fs.mkdirSync(camera);
    fs.writeFileSync(path.join(root, 'main.mp4'), 'main'); fs.writeFileSync(path.join(camera, 'camera.mp4'), 'camera');
    fs.writeFileSync(path.join(root, 'cache.hikraw'), 'cache'); fs.mkdirSync(path.join(root, 'camera_not-managed'));
    fs.writeFileSync(path.join(root, 'camera_not-managed', 'ignored.mp4'), 'ignored');
    const files = listOutputLibrary(root);
    assert.deepEqual(files.map(file => file.filename).sort(), ['camera.mp4', 'main.mp4']);
    const nested = files.find(file => file.filename === 'camera.mp4');
    assert.equal(resolveLibraryOutput(root, nested.id).relativePath, path.join('camera_0123456789abcdef', 'camera.mp4'));
    for (const id of [outputId('../outside.mp4'), Buffer.from('camera_not-managed/ignored.mp4').toString('base64url'), '%%%']) assert.equal(resolveLibraryOutput(root, id), null);
    assert.equal(resolveLibraryOutput(root, outputId(path.join(camera, '..', 'outside.mp4'))), null);
    const linkedDir = path.join(root, 'camera_fedcba9876543210');
    fs.writeFileSync(path.join(outside, 'outside.mp4'), 'outside');
    try {
      fs.symlinkSync(outside, linkedDir, 'junction');
      assert.equal(resolveLibraryOutput(root, outputId(path.join('camera_fedcba9876543210', 'outside.mp4'))), null);
      assert.equal(listOutputLibrary(root).some(file => file.filename === 'outside.mp4'), false);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('成片改名不覆盖已有目标，删除只接受有效成片 ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-library-mutate-'));
  try {
    fs.writeFileSync(path.join(root, 'one.mp4'), 'one'); fs.writeFileSync(path.join(root, 'two.mp4'), 'two');
    const id = outputId('one.mp4');
    assert.throws(() => renameLibraryOutput(root, id, 'two.mp4'), error => error.code === 'OUTPUT_EXISTS');
    const renamed = renameLibraryOutput(root, id, 'three.mp4');
    assert.equal(renamed.filename, 'three.mp4');
    assert.equal(fs.readFileSync(path.join(root, 'three.mp4'), 'utf8'), 'one');
    assert.equal(deleteLibraryOutput(root, outputId('three.mp4')).size, 3);
    assert.equal(deleteLibraryOutput(root, outputId('../outside.mp4')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function withPublishedPair(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-library-alias-'));
  const relative = path.join('camera_0123456789abcdef', 'ch201_20260929T201019Z_to_20260929T223053Z.mp4');
  const filename = 'D2 2026-09-29 20-10-19至2026-09-29 22-30-53 1b0dfede.mp4';
  try {
    fs.mkdirSync(path.dirname(path.join(root, relative)));
    fs.writeFileSync(path.join(root, relative), 'first range');
    const source = captureOutputSource(root, path.join(root, relative));
    fs.copyFileSync(path.join(root, relative), path.join(root, filename));
    const alias = createOutputAlias(root, source, filename);
    assert.ok(alias);
    return run({ root, relative, filename, alias, source });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('只有验证过复制来源和当前文件身份的内部 MP4 才从列表隐藏，旧下载仍可用', () => {
  withPublishedPair(({ root, relative, filename, alias }) => {
    assert.equal(listOutputLibrary(root).length, 2, '历史相似文件没有证据时不能猜测');
    const listed = listOutputLibrary(root, { aliases: [alias] });
    assert.deepEqual(listed.map(file => file.filename), [filename]);
    assert.equal(resolveLibraryOutput(root, outputId(relative)).stats.size, 11);
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), 'first range');
  });
});

test('不同录像范围保持独立，按别名去重后再应用列表 limit', () => {
  withPublishedPair(({ root, filename, alias }) => {
    const other = path.join('camera_0123456789abcdef', 'ch201_20260929T201054Z_to_20260929T223012Z.mp4');
    const friendly = 'D2 2026-09-29 20-10-54至2026-09-29 22-30-12.mp4';
    fs.writeFileSync(path.join(root, other), 'other range');
    const source = captureOutputSource(root, path.join(root, other));
    fs.copyFileSync(path.join(root, other), path.join(root, friendly));
    const secondAlias = createOutputAlias(root, source, friendly);
    assert.ok(secondAlias);
    assert.deepEqual(listOutputLibrary(root, { aliases: [alias, secondAlias], limit: 2 }).map(file => file.filename).sort(), [filename, friendly].sort());
    // 同样大小、时间字段接近的无来源文件仍必须保留。
    fs.writeFileSync(path.join(root, 'another.mp4'), 'other range');
    assert.equal(listOutputLibrary(root, { aliases: [alias, secondAlias] }).length, 3);
  });
});

test('原始输出重导、替换或最终成品改动后过期别名不能隐藏文件', () => {
  for (const side of ['source', 'target']) withPublishedPair(({ root, alias }) => {
    const file = path.join(root, alias[side].relativePath);
    fs.writeFileSync(file, 'same length');
    fs.utimesSync(file, new Date(0), new Date(0));
    assert.equal(listOutputLibrary(root, { aliases: [alias] }).length, 2);
  });
  withPublishedPair(({ root, relative, alias, source }) => {
    const original = path.join(root, relative), replacement = path.join(root, 'replacement');
    fs.writeFileSync(replacement, 'first range');
    fs.utimesSync(replacement, new Date(source.identity.mtimeMs), new Date(source.identity.mtimeMs));
    fs.renameSync(replacement, original);
    assert.equal(listOutputLibrary(root, { aliases: [alias] }).length, 2, '相同大小和 mtime 的替换文件不是同一来源');
  });
});

test('缺少最终成品、上传中或导出中的内部文件不会被别名隐藏', () => {
  withPublishedPair(({ root, relative, filename, alias }) => {
    assert.equal(listOutputLibrary(root, { aliases: [alias], isBusy: file => file === relative }).length, 2);
    assert.equal(listOutputLibrary(root, { aliases: [alias], isBusy: file => file === filename }).length, 2);
    assert.equal(listOutputLibrary(root, { aliases: [alias], inProgress: new Set([path.basename(relative)]) }).length, 2);
    fs.unlinkSync(path.join(root, filename));
    assert.deepEqual(listOutputLibrary(root, { aliases: [alias] }).map(file => file.relativePath), [relative]);
  });
});

test('损坏、越界或历史无身份的来源元数据不会影响列举', () => {
  withPublishedPair(({ root, alias, source }) => {
    const bad = [null, {}, { source: { relativePath: source.relativePath }, target: alias.target },
      { ...alias, source: { ...source, relativePath: '../outside.mp4' } },
      { ...alias, target: { ...alias.target, identity: { ...alias.target.identity, ino: NaN } } }];
    assert.equal(listOutputLibrary(root, { aliases: bad }).length, 2);
    assert.equal(captureOutputSource(root, path.join(root, '..', 'outside.mp4')), null);
    assert.equal(createOutputAlias(root, source, '../outside.mp4'), null);
    assert.equal(createOutputAlias(root, null, alias.target.relativePath), null);
  });
});


test('控制台完整元数据支持超过 200 个成片，原限量调用不变', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-library-many-'));
  try {
    for (let i = 0; i < 225; i++) fs.writeFileSync(path.join(root, `clip-${String(i).padStart(3, '0')}.mp4`), 'mp4');
    assert.equal(listOutputLibrary(root).length, 100);
    assert.equal(listOutputLibrary(root, { limit: 999 }).length, 200);
    const all = listOutputLibrary(root, { limit: null });
    assert.equal(all.length, 225); assert.equal(new Set(all.map(file => file.id)).size, 225);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
