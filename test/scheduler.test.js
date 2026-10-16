/**
 * 定时导出（lib/scheduler.js）。
 *
 * 全部用注入的假时钟和假 startExportTask，不碰真服务也不碰真录像机。
 * 重点是触发条件——多跑一趟就是几个 GB 和一次会话池争抢，少跑一趟就是当晚没录到。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDue, dueSchedules, createScheduler } from '../lib/scheduler.js';

const DEVICE = { id: 'b88a6eb6-967c-47bd-b75f-1e61c85d873b', httpPort: 8080, rtspPort: 8554, ip: '192.0.2.200', username: 'admin', password: 'pw' };

/** 本地时间构造，避免测试受运行机器时区影响。 */
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0);

function makeSchedule(overrides = {}) {
  return {
    id: 's1',
    name: '每晚常规',
    enabled: true,
    channel: null,
    startTime: '20:00',
    endTime: '22:30',
    runAt: '23:00',
    method: 'auto',
    retentionDays: 7,
    lastRun: null,
    ...overrides,
  };
}

describe('isDue', () => {
  it('到点且今天没跑过 → 跑', () => {
    assert.equal(isDue(makeSchedule(), at(2026, 8, 7, 23, 0)), true);
    assert.equal(isDue(makeSchedule(), at(2026, 8, 7, 23, 40)), true);
  });

  it('还没到点 → 不跑', () => {
    assert.equal(isDue(makeSchedule(), at(2026, 8, 7, 22, 59)), false);
    assert.equal(isDue(makeSchedule(), at(2026, 8, 7, 8, 0)), false);
  });

  it('今天已经跑过 → 不重复跑', () => {
    const schedule = makeSchedule({ lastRun: { date: '2026-08-07', status: 'started' } });
    assert.equal(isDue(schedule, at(2026, 8, 7, 23, 30)), false);
  });

  it('昨天跑过、今天又到点 → 跑', () => {
    const schedule = makeSchedule({ lastRun: { date: '2026-08-06', status: 'started' } });
    assert.equal(isDue(schedule, at(2026, 8, 7, 23, 5)), true);
  });

  it('当天失败过也不在同一天重试', () => {
    const schedule = makeSchedule({ lastRun: { date: '2026-08-07', status: 'failed' } });
    assert.equal(isDue(schedule, at(2026, 8, 7, 23, 59)), false);
  });

  it('停用的不跑', () => {
    assert.equal(isDue(makeSchedule({ enabled: false }), at(2026, 8, 7, 23, 30)), false);
  });

  it('runAt 写坏了就不跑，不去猜', () => {
    assert.equal(isDue(makeSchedule({ runAt: '晚上' }), at(2026, 8, 7, 23, 30)), false);
    assert.equal(isDue(makeSchedule({ runAt: '25:00' }), at(2026, 8, 7, 23, 30)), false);
  });

  it('关机三天后开机，只跑今天这趟，不补历史', () => {
    const schedule = makeSchedule({ lastRun: { date: '2026-08-04', status: 'started' } });
    // 早上开机：今天的 23:00 还没到，什么都不该发生
    assert.equal(isDue(schedule, at(2026, 8, 7, 9, 0)), false);
    // 晚上到点了才跑，而且只跑一次
    assert.equal(isDue(schedule, at(2026, 8, 7, 23, 1)), true);
  });
});

describe('dueSchedules', () => {
  it('只挑该跑的那些', () => {
    const schedules = [
      makeSchedule({ id: 'a' }),
      makeSchedule({ id: 'b', enabled: false }),
      makeSchedule({ id: 'c', runAt: '06:00' }),
      makeSchedule({ id: 'd', lastRun: { date: '2026-08-07' } }),
    ];
    const due = dueSchedules(schedules, at(2026, 8, 7, 23, 10)).map((s) => s.id);
    assert.deepEqual(due, ['a', 'c']);
  });
});

describe('createScheduler', () => {
  let dir;
  let started;
  let recorded;
  let logs;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hik-sched-'));
    started = [];
    recorded = [];
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(overrides = {}) {
    const schedules = overrides.schedules || [makeSchedule()];
    return createScheduler({
      downloadsDir: dir,
      getDevice: () => DEVICE,
      readSession: () => null,
      now: () => overrides.now || at(2026, 8, 7, 23, 5),
      log: (msg) => logs.push(msg),
      listSchedules: () => schedules,
      saveRun: (id, run) => { recorded.push({ id, ...run }); },
      startExportTask: overrides.startExportTask
        || ((options) => { started.push(options); return { ok: true, taskId: 't1', filename: 'out.mp4', method: options.method }; }),
      ...overrides.deps,
    });
  }

  it('到点时用当天日期拼出时间范围', () => {
    build().tick();

    assert.equal(started.length, 1);
    assert.equal(started[0].startTime, '20260807T200000Z');
    assert.equal(started[0].endTime, '20260807T223000Z');
  });

  it('2.5 小时按 auto 解析成 mp4download', () => {
    build().tick();
    assert.equal(started[0].method, 'mp4download');
  });

  it('显式指定的方式不被覆盖', () => {
    build({ schedules: [makeSchedule({ method: 'rtspclip' })] }).tick();
    assert.equal(started[0].method, 'rtspclip');
  });

  it('带上激活设备的凭据', () => {
    build().tick();
    assert.equal(started[0].ip, DEVICE.ip);
    assert.equal(started[0].user, DEVICE.username);
    assert.equal(started[0].pass, DEVICE.password);
  });

  it('通道优先用计划里配的', () => {
    build({ schedules: [makeSchedule({ channel: '201' })] }).tick();
    assert.equal(started[0].channel, '201');
  });

  it('没配就跟随界面上次选的通道', () => {
    const scheduler = createScheduler({
      downloadsDir: dir,
      getDevice: () => DEVICE,
      readSession: () => ({ channel: '301' }),
      now: () => at(2026, 8, 7, 23, 5),
      log: () => {},
      listSchedules: () => [makeSchedule()],
      saveRun: () => {},
      startExportTask: (o) => { started.push(o); return { ok: true, taskId: 't', filename: 'f' }; },
    });
    scheduler.tick();
    assert.equal(started[0].channel, '301');
  });

  it('都没有就退到 101', () => {
    build().tick();
    assert.equal(started[0].channel, '101');
    assert.equal(started[0].deviceId, DEVICE.id);
    assert.equal(started[0].httpPort, 8080);
    assert.equal(started[0].rtspPort, 8554);
  });

  it('成功后记 started，带上 taskId', () => {
    build().tick();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].status, 'started');
    assert.equal(recorded[0].date, '2026-08-07');
    assert.equal(recorded[0].taskId, 't1');
  });

  it('被单飞守卫拒了也要记一笔，免得同一天反复重试', () => {
    build({
      startExportTask: () => ({ ok: false, status: 409, error: '已有导出任务进行中（45%）' }),
    }).tick();

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].status, 'failed');
    assert.match(recorded[0].message, /已有导出任务/);
  });

  it('没有激活设备时跳过并记录', () => {
    const scheduler = createScheduler({
      downloadsDir: dir,
      getDevice: () => null,
      now: () => at(2026, 8, 7, 23, 5),
      log: (m) => logs.push(m),
      listSchedules: () => [makeSchedule()],
      saveRun: (id, run) => recorded.push({ id, ...run }),
      startExportTask: (o) => { started.push(o); return { ok: true }; },
    });
    scheduler.tick();

    assert.equal(started.length, 0);
    assert.equal(recorded[0].status, 'failed');
    assert.match(recorded[0].message, /没有激活的设备/);
  });

  it('时间配置写坏时跳过，不去猜', () => {
    build({ schedules: [makeSchedule({ startTime: '晚八点' })] }).tick();
    assert.equal(started.length, 0);
    assert.equal(recorded[0].status, 'failed');
  });

  it('没到点什么都不做', () => {
    build({ now: at(2026, 8, 7, 20, 0) }).tick();
    assert.equal(started.length, 0);
    assert.equal(recorded.length, 0);
  });

  it('start() 把上次进程遗留的 started 恢复成 failed（服务重启）', () => {
    const leftover = makeSchedule({
      lastRun: { date: '2026-08-07', status: 'started', taskId: 't9', filename: 'out.mp4', method: 'mp4download', at: '2026-08-07T23:10:00.000Z' },
    });
    const scheduler = build({
      schedules: [leftover],
      now: at(2026, 8, 8, 9, 0), // 第二天上午重启
    });
    scheduler.start();
    scheduler.stop();

    const recovery = recorded.find((r) => r.status === 'failed');
    assert.ok(recovery, '应写入一条 failed 记录');
    assert.equal(recovery.id, 's1');
    assert.equal(recovery.date, '2026-08-07', 'date 必须保留触发日，避免重启当天被当作没跑过');
    assert.equal(recovery.taskId, 't9');
    assert.equal(recovery.filename, 'out.mp4');
    assert.match(recovery.message, /服务重启/);
    assert.ok(logs.some((m) => m.includes('中断')), '应有日志说明');
  });

  it('start() 不碰已完成/失败的记录', () => {
    const done = makeSchedule({ lastRun: { date: '2026-08-07', status: 'completed' } });
    const failed = makeSchedule({ id: 's2', lastRun: { date: '2026-08-07', status: 'failed' } });
    const scheduler = build({ schedules: [done, failed], now: at(2026, 8, 8, 9, 0) });
    scheduler.start();
    scheduler.stop();

    assert.equal(recorded.length, 0, 'completed/failed 不该被改写');
  });

  it('导出前先清理过期文件，给接下来几个 GB 腾地方', () => {
    const old = path.join(dir, 'old.mp4');
    fs.writeFileSync(old, 'x');
    const past = new Date(at(2026, 8, 7, 23, 5).getTime() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);

    build().tick();

    assert.equal(fs.existsSync(old), false, '过期文件应该在导出前被清掉');
    assert.equal(started.length, 1);
  });

  it('一条计划炸了不影响另一条', () => {
    const scheduler = build({
      schedules: [makeSchedule({ id: 'a' }), makeSchedule({ id: 'b' })],
      startExportTask: (o) => {
        started.push(o);
        if (started.length === 1) throw new Error('第一条炸了');
        return { ok: true, taskId: 't2', filename: 'f' };
      },
    });
    scheduler.tick();

    assert.equal(started.length, 2);
    assert.ok(logs.some((l) => /第一条炸了/.test(l)));
  });

  it('start() 立刻 tick 一次，补上当天已到点没跑的那趟', () => {
    const scheduler = build();
    scheduler.start();
    scheduler.stop();
    assert.equal(started.length, 1);
  });

  it('stop() 之后不再触发', () => {
    const scheduler = build();
    scheduler.start();
    scheduler.stop();
    const count = started.length;
    scheduler.tick.call(null); // 手动 tick 仍可用，但定时器已停
    assert.ok(started.length >= count);
  });

  it('读计划失败时安静跳过这一轮', () => {
    const scheduler = createScheduler({
      downloadsDir: dir,
      getDevice: () => DEVICE,
      now: () => at(2026, 8, 7, 23, 5),
      log: (m) => logs.push(m),
      listSchedules: () => { throw new Error('文件坏了'); },
      saveRun: () => {},
      startExportTask: (o) => { started.push(o); return { ok: true }; },
    });
    scheduler.tick();

    assert.equal(started.length, 0);
    assert.ok(logs.some((l) => /文件坏了/.test(l)));
  });
});
