import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanCompletedDvrCache, listDvrCache } from '../lib/cache-cleaner.js';

test('只清理带 .done 的顶层和摄像头目录缓存，断点分片会保留', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-cleaner-'));
  try {
    const camera = path.join(root, 'camera_0123456789abcdef'); fs.mkdirSync(camera);
    const complete = path.join(root, 'complete.hikraw'), partial = path.join(root, 'partial.hikraw'), nested = path.join(camera, 'nested.hikraw');
    for (const file of [complete, partial, nested]) fs.writeFileSync(file, '12345');
    fs.writeFileSync(complete + '.done', ''); fs.writeFileSync(nested + '.done', '');
    assert.equal(listDvrCache(root).length, 3);
    const result = cleanCompletedDvrCache(root);
    assert.deepEqual(result, { deletedCount: 2, deletedSize: 10, skippedBusy: false });
    assert.equal(fs.existsSync(complete), false); assert.equal(fs.existsSync(complete + '.done'), false);
    assert.equal(fs.existsSync(nested), false); assert.equal(fs.existsSync(partial), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('有导出任务运行时安全拒绝整库清理', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-cleaner-busy-'));
  try {
    const file = path.join(root, 'done.hikraw'); fs.writeFileSync(file, 'x'); fs.writeFileSync(file + '.done', '');
    assert.deepEqual(cleanCompletedDvrCache(root, { busy: true }), { deletedCount: 0, deletedSize: 0, skippedBusy: true });
    assert.equal(fs.existsSync(file), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
