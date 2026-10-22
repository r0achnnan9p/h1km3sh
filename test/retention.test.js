/**
 * downloads/ 的保留策略（lib/retention.js）。
 *
 * 一晚接近 18 GB，这个模块要是把该留的删了或该删的留了，代价都不小：
 * 前者丢录像，后者写满盘。所以边界和文件类型都要钉死。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPrunable, findExpired, pruneDirectory } from '../lib/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-07T23:00:00Z');

describe('isPrunable', () => {
  it('认成品、分片缓存和完成标记', () => {
    assert.equal(isPrunable('ch101_20260807T200000Z_to_20260807T223000Z.mp4'), true);
    assert.equal(isPrunable('ch101_20260807T200000Z_20260807T202412Z.hikraw'), true);
    assert.equal(isPrunable('ch101_20260807T200000Z_20260807T202412Z.hikraw.done'), true);
  });

  it('也认导出中断留下的裸流中间文件', () => {
    // 服务重启/崩溃时 rtspclip 的分段文件会留在原地，正常完成时才会自己删
    assert.equal(isPrunable('ch101_20260807T090000Z_to_20260807T090100Z_seg0.h264'), true);
    assert.equal(isPrunable('ch101_20260807T090000Z_to_20260807T090100Z_seg0.aac'), true);
    assert.equal(isPrunable('ch101_20260807T090000Z_to_20260807T090100Z.hevc'), true);
  });

  it('大小写不敏感', () => {
    assert.equal(isPrunable('CLIP.MP4'), true);
  });

  it('不碰别的东西', () => {
    // 预览临时文件、配置、日志都不归这里管
    assert.equal(isPrunable('preview_body_abc.xml'), false);
    assert.equal(isPrunable('devices.json'), false);
    assert.equal(isPrunable('service.log'), false);
    assert.equal(isPrunable('notes.mp4.txt'), false);
  });
});

describe('findExpired', () => {
  const entries = [
    { name: 'old.mp4', mtimeMs: NOW - 8 * DAY_MS },
    { name: 'fresh.mp4', mtimeMs: NOW - 1 * DAY_MS },
    { name: 'old.hikraw', mtimeMs: NOW - 10 * DAY_MS },
    { name: 'old.hikraw.done', mtimeMs: NOW - 10 * DAY_MS },
    { name: 'old-but-not-ours.xml', mtimeMs: NOW - 30 * DAY_MS },
  ];

  it('7 天保留期挑出超期的', () => {
    const expired = findExpired(entries, { nowMs: NOW, retentionDays: 7 });
    assert.deepEqual(expired.sort(), ['old.hikraw', 'old.hikraw.done', 'old.mp4']);
  });

  it('不是我们产出的文件再老也不动', () => {
    const expired = findExpired(entries, { nowMs: NOW, retentionDays: 7 });
    assert.ok(!expired.includes('old-but-not-ours.xml'));
  });

  it('刚好卡在保留期边界上的留着', () => {
    const boundary = [
      { name: 'exactly7.mp4', mtimeMs: NOW - 7 * DAY_MS },
      { name: 'justover.mp4', mtimeMs: NOW - 7 * DAY_MS - 1000 },
    ];
    const expired = findExpired(boundary, { nowMs: NOW, retentionDays: 7 });
    assert.deepEqual(expired, ['justover.mp4']);
  });

  it('保留天数为 0 或非法时一个都不删（宁可不清也别误删）', () => {
    assert.deepEqual(findExpired(entries, { nowMs: NOW, retentionDays: 0 }), []);
    assert.deepEqual(findExpired(entries, { nowMs: NOW, retentionDays: -1 }), []);
    assert.deepEqual(findExpired(entries, { nowMs: NOW, retentionDays: undefined }), []);
  });
});

describe('pruneDirectory', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hik-retention-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name, ageDays, size = 1024) {
    const target = path.join(dir, name);
    fs.writeFileSync(target, Buffer.alloc(size));
    const time = new Date(NOW - ageDays * DAY_MS);
    fs.utimesSync(target, time, time);
  }

  it('删掉过期文件，留下新的和不相干的', () => {
    write('old.mp4', 9);
    write('old.hikraw', 9);
    write('fresh.mp4', 2);
    write('keep.json', 90);

    const result = pruneDirectory(dir, { retentionDays: 7, nowMs: NOW });

    assert.deepEqual(result.deleted.sort(), ['old.hikraw', 'old.mp4']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['fresh.mp4', 'keep.json']);
  });

  it('统计释放的字节数', () => {
    write('a.mp4', 9, 2048);
    write('b.mp4', 9, 1024);

    const result = pruneDirectory(dir, { retentionDays: 7, nowMs: NOW });
    assert.equal(result.freedBytes, 3072);
  });

  it('目录不存在时安静返回，不抛错', () => {
    const result = pruneDirectory(path.join(dir, 'nope'), { retentionDays: 7, nowMs: NOW });
    assert.deepEqual(result.deleted, []);
  });

  it('没有过期文件时不写日志', () => {
    write('fresh.mp4', 1);
    const lines = [];
    pruneDirectory(dir, { retentionDays: 7, nowMs: NOW, log: (m) => lines.push(m) });
    assert.equal(lines.length, 0);
  });

  it('清理时写一行汇总', () => {
    write('old.mp4', 9);
    const lines = [];
    pruneDirectory(dir, { retentionDays: 7, nowMs: NOW, log: (m) => lines.push(m) });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /清理了 1 个/);
  });

  it('保留天数非法时整趟跳过', () => {
    write('old.mp4', 99);
    const result = pruneDirectory(dir, { retentionDays: 0, nowMs: NOW });
    assert.deepEqual(result.deleted, []);
    assert.equal(fs.existsSync(path.join(dir, 'old.mp4')), true);
  });
});
