/**
 * lib/session-store.js —— 界面会话状态持久化测试
 *
 * 与 device-store 同样的隔离方式：先设 HIKVISION_DATA_DIR 再动态 import()，
 * 因为模块在加载时就地解析数据目录常量，静态 import 会赶在环境变量生效之前执行。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('lib/session-store.js', () => {
  let tmpDir;
  let store;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
    process.env.HIKVISION_DATA_DIR = tmpDir;
    store = await import('../lib/session-store.js');
  });

  after(() => {
    delete process.env.HIKVISION_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(store.getSessionFilePath(), { force: true });
  });

  it('首次读取返回全 null 的默认会话', () => {
    assert.deepEqual(store.getSession(), {
      date: null, startTime: null, endTime: null, channel: null, exportMethod: null,
    });
  });

  it('保存后能读回同样的值', () => {
    store.saveSession({ date: '2026-07-24', startTime: '20:11:42', endTime: '22:25:42' });
    const s = store.getSession();
    assert.equal(s.date, '2026-07-24');
    assert.equal(s.startTime, '20:11:42');
    assert.equal(s.endTime, '22:25:42');
  });

  it('合并式更新：未传的字段保持原值', () => {
    store.saveSession({ date: '2026-07-24', channel: '201' });
    store.saveSession({ date: '2026-07-25' });
    const s = store.getSession();
    assert.equal(s.date, '2026-07-25');
    assert.equal(s.channel, '201', '未传的 channel 不应被清空');
  });

  it('显式传 null 可以清空字段', () => {
    store.saveSession({ channel: '201' });
    store.saveSession({ channel: null });
    assert.equal(store.getSession().channel, null);
  });

  it('白名单外的字段不落盘', () => {
    store.saveSession({ date: '2026-07-24', evil: 'x', password: 'y' });
    const raw = JSON.parse(fs.readFileSync(store.getSessionFilePath(), 'utf-8'));
    assert.equal(raw.date, '2026-07-24');
    assert.ok(!('evil' in raw), '未知字段不应写入');
    assert.ok(!('password' in raw), '未知字段不应写入');
  });

  it('非字符串值统一转成字符串', () => {
    store.saveSession({ channel: 201 });
    assert.strictEqual(store.getSession().channel, '201');
  });

  it('文件损坏时退回默认值而不是抛异常', () => {
    fs.writeFileSync(store.getSessionFilePath(), '{ 这不是 JSON', 'utf-8');
    assert.deepEqual(store.getSession(), {
      date: null, startTime: null, endTime: null, channel: null, exportMethod: null,
    });
  });

  it('写入走临时文件+重命名，不留下 .tmp 残留', () => {
    store.saveSession({ date: '2026-07-24' });
    const leftovers = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});
