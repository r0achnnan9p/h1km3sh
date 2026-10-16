/**
 * lib/schedule-store.js —— 定时计划持久化测试
 *
 * 与 device-store / session-store 同样的隔离方式：先设 HIKVISION_DATA_DIR 再动态
 * import()，因为模块加载时就地解析数据目录常量。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('lib/schedule-store.js', () => {
  let tmpDir;
  let store;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-store-test-'));
    process.env.HIKVISION_DATA_DIR = tmpDir;
    store = await import('../lib/schedule-store.js');
  });

  after(() => {
    delete process.env.HIKVISION_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(store.getScheduleFilePath(), { force: true });
  });

  describe('首次运行的默认计划', () => {
    it('自动写入一条每天 23:00 拉 20:00–22:30 的计划', () => {
      const schedules = store.getSchedules();
      assert.equal(schedules.length, 1);
      assert.equal(schedules[0].startTime, '20:00');
      assert.equal(schedules[0].endTime, '22:30');
      assert.equal(schedules[0].runAt, '23:00');
      assert.equal(schedules[0].enabled, true);
    });

    it('保留天数默认 7 天', () => {
      assert.equal(store.getSchedules()[0].retentionDays, 7);
      assert.equal(store.DEFAULT_RETENTION_DAYS, 7);
    });

    it('导出方式默认 auto，交给时长决定', () => {
      assert.equal(store.getSchedules()[0].method, 'auto');
    });

    it('通道留空，运行时跟随界面选择', () => {
      assert.equal(store.getSchedules()[0].channel, null);
    });

    it('runAt 之后首次创建时标记当天已跑过，避免立刻触发 2.5 小时导出', () => {
      const seeded = store.defaultSchedule('2026-08-07', new Date(2026, 7, 7, 23, 30));
      assert.equal(seeded.lastRun.date, '2026-08-07');
      assert.equal(seeded.lastRun.status, 'seeded');
    });

    it('runAt 之前首次创建则留空，今晚照常跑', () => {
      // 下午装好的话没理由白白跳过一整晚
      assert.equal(store.defaultSchedule('2026-08-07', new Date(2026, 7, 7, 16, 40)).lastRun, null);
      assert.equal(store.defaultSchedule('2026-08-07', new Date(2026, 7, 7, 22, 59)).lastRun, null);
    });

    it('刚好卡在 runAt 那一分钟算「已过」', () => {
      const seeded = store.defaultSchedule('2026-08-07', new Date(2026, 7, 7, 23, 0));
      assert.equal(seeded.lastRun?.status, 'seeded');
    });
  });

  describe('CRUD', () => {
    it('新增的计划有独立 id 且 lastRun 为空', () => {
      const before = store.getSchedules().length;
      const created = store.addSchedule({ name: '周末加场', startTime: '14:00', endTime: '16:00' });

      assert.equal(store.getSchedules().length, before + 1);
      assert.equal(created.name, '周末加场');
      assert.equal(created.startTime, '14:00');
      assert.equal(created.lastRun, null);
      assert.ok(created.id);
    });

    it('新增时未指定的字段用默认值补齐', () => {
      const created = store.addSchedule({ name: '临时' });
      assert.equal(created.runAt, '23:00');
      assert.equal(created.retentionDays, 7);
    });

    it('更新只认白名单字段', () => {
      const created = store.addSchedule({ name: '原名' });
      const updated = store.updateSchedule(created.id, {
        name: '新名',
        enabled: false,
        id: 'hacked',
        lastRun: { date: 'bogus' },
      });

      assert.equal(updated.name, '新名');
      assert.equal(updated.enabled, false);
      assert.equal(updated.id, created.id, 'id 不能被改');
      assert.notEqual(updated.lastRun?.date, 'bogus', 'lastRun 不能通过 update 改');
    });

    it('更新不存在的 id 返回 null', () => {
      assert.equal(store.updateSchedule('nope', { name: 'x' }), null);
    });

    it('删除', () => {
      const created = store.addSchedule({ name: '待删' });
      assert.equal(store.deleteSchedule(created.id), true);
      assert.equal(store.getScheduleById(created.id), null);
      assert.equal(store.deleteSchedule(created.id), false);
    });
  });

  describe('recordRun', () => {
    it('写入运行结果并带上时间戳', () => {
      const [schedule] = store.getSchedules();
      store.recordRun(schedule.id, { date: '2026-08-08', status: 'started', taskId: 't1' });

      const after = store.getScheduleById(schedule.id);
      assert.equal(after.lastRun.date, '2026-08-08');
      assert.equal(after.lastRun.status, 'started');
      assert.equal(after.lastRun.taskId, 't1');
      assert.ok(after.lastRun.at, '应该带 at 时间戳');
    });

    it('失败也要记 —— scheduler 靠它避免同一天反复重试', () => {
      const [schedule] = store.getSchedules();
      store.recordRun(schedule.id, { date: '2026-08-08', status: 'failed', message: '设备离线' });

      const after = store.getScheduleById(schedule.id);
      assert.equal(after.lastRun.status, 'failed');
      assert.equal(after.lastRun.date, '2026-08-08');
    });

    it('不存在的 id 返回 null', () => {
      assert.equal(store.recordRun('nope', { date: '2026-08-08' }), null);
    });
  });

  describe('健壮性', () => {
    it('文件被写坏时按「没有计划」处理，宁可不跑也不拿半个配置去导出', () => {
      fs.writeFileSync(store.getScheduleFilePath(), '{ 这不是 json');
      assert.deepEqual(store.getSchedules(), []);
    });

    it('schedules 字段类型不对时也返回空数组', () => {
      fs.writeFileSync(store.getScheduleFilePath(), JSON.stringify({ schedules: 'oops' }));
      assert.deepEqual(store.getSchedules(), []);
    });

    it('写入是原子的，不留 .tmp 文件', () => {
      store.addSchedule({ name: '原子性' });
      const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    });
  });
});
