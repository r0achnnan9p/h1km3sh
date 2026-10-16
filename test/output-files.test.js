/**
 * lib/output-files.js —— 成品 MP4 的枚举/删除/重命名测试。
 *
 * 覆盖「用户使用角度」的关键约束：
 *   - 只碰 .mp4（downloads/ 里的 .hikraw 分片缓存是中间产物，绝不能删/改名）
 *   - 文件名来自 URL 参数（express 已 decode），路径穿越必须被拒
 *   - 重命名不覆盖已有文件
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir;
let mod;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'output-files-test-'));
  mod = await import('../lib/output-files.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

function touch(filename, mtimeMs = Date.now()) {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, 'x');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

describe('isOutputFilename', () => {
  it('接受 .mp4 结尾、无路径分隔符的名字', () => {
    assert.equal(mod.isOutputFilename('ch101_20260807T200000Z_to_20260807T223000Z.mp4'), true);
    assert.equal(mod.isOutputFilename('灵气闪耀 2026-08-12.mp4'), true);
    assert.equal(mod.isOutputFilename('a.MP4'), true); // 大小写不敏感
  });

  it('拒绝非 mp4 后缀', () => {
    assert.equal(mod.isOutputFilename('ch101_20260807T200000Z_to_20260807T223000Z.hikraw'), false);
    assert.equal(mod.isOutputFilename('a.hikraw.done'), false);
    assert.equal(mod.isOutputFilename('a.mp4.txt'), false);
    assert.equal(mod.isOutputFilename(''), false);
  });

  it('拒绝路径穿越', () => {
    assert.equal(mod.isOutputFilename('../etc/passwd.mp4'), false);
    assert.equal(mod.isOutputFilename('..\\..\\evil.mp4'), false);
    assert.equal(mod.isOutputFilename('sub/dir/a.mp4'), false);
    assert.equal(mod.isOutputFilename('a.mp4/../b.mp4'), false);
    assert.equal(mod.isOutputFilename('/etc/passwd.mp4'), false);
  });
});

describe('compactToIso', () => {
  it('紧凑时间转 ISO', () => {
    assert.equal(mod.compactToIso('20260807T193000Z'), '2026-08-07T19:30:00Z');
    assert.equal(mod.compactToIso('20260807T000000Z'), '2026-08-07T00:00:00Z');
  });

  it('非法输入返回空串', () => {
    assert.equal(mod.compactToIso(''), '');
    assert.equal(mod.compactToIso('20260807193000'), '');
    assert.equal(mod.compactToIso(undefined), '');
  });
});

describe('listOutputFiles', () => {
  it('只列 .mp4，新的在前，忽略 .hikraw 缓存', () => {
    touch('a.mp4', 1000);
    touch('b.mp4', 3000);
    touch('c.hikraw', 999999); // 中间产物必须被过滤

    const files = mod.listOutputFiles(tmpDir);
    assert.deepEqual(files.map((f) => f.filename), ['b.mp4', 'a.mp4']);
    assert.ok(files.every((f) => !f.filename.endsWith('.hikraw')));
  });

  it('能解析自动命名文件的通道与起止时间', () => {
    touch('ch201_20260807T200000Z_to_20260807T223000Z.mp4');
    const [f] = mod.listOutputFiles(tmpDir);
    assert.equal(f.channel, '201');
    assert.equal(f.startTime, '2026-08-07T20:00:00Z');
    assert.equal(f.endTime, '2026-08-07T22:30:00Z');
    assert.ok(f.url.includes('ch201_20260807T200000Z_to_20260807T223000Z.mp4'));
  });

  it('用户重命名过的中文名解析不出通道/时间，字段留空但不报错', () => {
    touch('天行者vs龙城联 2026-08-07.mp4');
    const [f] = mod.listOutputFiles(tmpDir);
    assert.equal(f.channel, '');
    assert.equal(f.startTime, '');
    assert.equal(f.endTime, '');
    assert.ok(f.url.includes(encodeURIComponent('天行者vs龙城联 2026-08-07.mp4')));
  });

  it('limit 生效', () => {
    touch('a.mp4', 1000);
    touch('b.mp4', 2000);
    touch('c.mp4', 3000);
    assert.equal(mod.listOutputFiles(tmpDir, { limit: 2 }).length, 2);
  });
});

describe('deleteOutputFile', () => {
  it('删除存在的文件返回 true 且文件消失', () => {
    touch('a.mp4');
    assert.equal(mod.deleteOutputFile(tmpDir, 'a.mp4'), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'a.mp4')), false);
  });

  it('文件不存在返回 false', () => {
    assert.equal(mod.deleteOutputFile(tmpDir, 'ghost.mp4'), false);
  });

  it('拒绝非 mp4 / 路径穿越', () => {
    touch('a.hikraw');
    assert.throws(() => mod.deleteOutputFile(tmpDir, 'a.hikraw'));
    assert.throws(() => mod.deleteOutputFile(tmpDir, '../a.mp4'));
    assert.throws(() => mod.deleteOutputFile(tmpDir, 'sub/a.mp4'));
    assert.equal(fs.existsSync(path.join(tmpDir, 'a.hikraw')), true); // 没被误删
  });
});

describe('renameOutputFile', () => {
  it('重命名成功返回新文件名，旧名消失新名出现', () => {
    touch('ch101_20260807T200000Z_to_20260807T223000Z.mp4');
    const result = mod.renameOutputFile(tmpDir, 'ch101_20260807T200000Z_to_20260807T223000Z.mp4', '尤文vs国米 2026-08-07.mp4');
    assert.equal(result, '尤文vs国米 2026-08-07.mp4');
    assert.equal(fs.existsSync(path.join(tmpDir, 'ch101_20260807T200000Z_to_20260807T223000Z.mp4')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, '尤文vs国米 2026-08-07.mp4')), true);
  });

  it('同名（只改大小写/没改）直接返回', () => {
    touch('a.mp4');
    assert.equal(mod.renameOutputFile(tmpDir, 'a.mp4', 'a.mp4'), 'a.mp4');
    assert.equal(mod.renameOutputFile(tmpDir, 'a.mp4', 'A.mp4'), 'A.mp4');
  });

  it('源不存在返回 null', () => {
    assert.equal(mod.renameOutputFile(tmpDir, 'ghost.mp4', 'b.mp4'), null);
  });

  it('目标已存在抛 OUTPUT_EXISTS 且不动源文件', () => {
    touch('a.mp4');
    touch('b.mp4');
    assert.throws(
      () => mod.renameOutputFile(tmpDir, 'a.mp4', 'b.mp4'),
      (err) => err.code === 'OUTPUT_EXISTS' && /已存在/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(tmpDir, 'a.mp4')), true);
  });

  it('新名非法（非 mp4 / 路径穿越）抛错', () => {
    touch('a.mp4');
    assert.throws(() => mod.renameOutputFile(tmpDir, 'a.mp4', 'b.hikraw'), /不合法/);
    assert.throws(() => mod.renameOutputFile(tmpDir, 'a.mp4', '../b.mp4'), /不合法/);
    assert.throws(() => mod.renameOutputFile(tmpDir, 'a.mp4', 'sub/b.mp4'), /不合法/);
  });
});
