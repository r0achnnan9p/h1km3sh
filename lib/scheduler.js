/**
 * 常规时段的定时导出，跑在常驻服务进程里。
 *
 * 为什么不挂到 MCP 上：MCP 是被动协议，要有 AI 客户端在 23:00 那一刻活着并主动
 * 调用才会执行。每天雷打不动的需求交给不确定的执行者是错配。MCP 只管临时调整
 * 时段那一半（见 lib/mcp-server.js）。
 *
 * 触发条件很保守，只跑「今天的那一趟」：
 *   - 计划启用
 *   - 本地时间已过 runAt
 *   - 今天还没跑过（lastRun.date != 今天）
 *
 * **不补跑历史**。box 关机三天再开，只会跑今天这趟，不会一口气补三个 2.5 小时的
 * 导出——那既抢会话池又写满磁盘。当天 23:00 没开机、23:40 才开机的情况会补上，
 * 因为那仍然是「今天的那一趟」。
 */

import {
  localDateStr,
  localSecondsOfDay,
  parseClock,
  toCompact,
  durationSeconds,
} from './hik-time.js';
import { getSchedules, recordRun, DEFAULT_RETENTION_DAYS } from './schedule-store.js';
import { pruneDirectory } from './retention.js';
import { resolveExportMethod } from './export-method.js';

const TICK_INTERVAL_MS = 60 * 1000;

/** 通道兜底：1 号通道主码流，海康的通用编号。 */
const FALLBACK_CHANNEL = '101';

/**
 * 这条计划现在该不该跑。纯函数，方便用假时钟直接测。
 *
 * @param {object} schedule
 * @param {Date} now
 */
export function isDue(schedule, now) {
  if (!schedule?.enabled) return false;

  let runAtSeconds;
  try {
    runAtSeconds = parseClock(schedule.runAt);
  } catch {
    return false; // runAt 写坏了就不跑，别猜
  }

  if (localSecondsOfDay(now) < runAtSeconds) return false;
  return schedule.lastRun?.date !== localDateStr(now);
}

/** 当前所有该跑的计划。 */
export function dueSchedules(schedules, now) {
  return schedules.filter((schedule) => isDue(schedule, now));
}

/**
 * @param {object} deps
 * @param {(options:object) => object} deps.startExportTask server.js 的导出入口（进程内直调，不绕 HTTP）
 * @param {string} deps.downloadsDir 清理目标目录
 * @param {() => object|null} [deps.readSession] 取界面上次选的通道
 * @param {() => Date} [deps.now]
 * @param {(msg:string) => void} [deps.log]
 * @param {() => object|null} [deps.getDevice] 取激活设备
 */
export function createScheduler(deps) {
  const {
    startExportTask,
    downloadsDir,
    getDevice,
    readSession = () => null,
    now = () => new Date(),
    log = (msg) => console.log(`  [scheduler] ${msg}`),
    listSchedules = getSchedules,
    saveRun = recordRun,
    isTaskRecovering = () => false,
  } = deps;

  let timer = null;

  function resolveChannel(schedule) {
    if (schedule.channel) return String(schedule.channel);
    const session = readSession();
    if (session?.channel) return String(session.channel);
    return FALLBACK_CHANNEL;
  }

  /** 跑一条计划。无论成败都写 lastRun，避免同一天里反复重试。 */
  function runSchedule(schedule, currentTime) {
    const today = localDateStr(currentTime);
    const label = schedule.name || schedule.id;

    // 先清理再导出：这时候磁盘占用最低，给接下来的几个 GB 腾地方
    const retentionDays = Number.isFinite(schedule.retentionDays)
      ? schedule.retentionDays
      : DEFAULT_RETENTION_DAYS;
    pruneDirectory(downloadsDir, { retentionDays, log });

    const device = getDevice();
    if (!device) {
      log(`「${label}」跳过：还没有配置录像机`);
      saveRun(schedule.id, { date: today, status: 'failed', message: '没有激活的设备' });
      return;
    }

    let startTime;
    let endTime;
    try {
      startTime = toCompact(today, schedule.startTime);
      endTime = toCompact(today, schedule.endTime);
    } catch (err) {
      log(`「${label}」跳过：时间配置有问题 — ${err.message}`);
      saveRun(schedule.id, { date: today, status: 'failed', message: err.message });
      return;
    }

    // startExportTask 的缺省是 rtspclip（为了不改 Web UI 的既有行为），
    // 所以「按时长自动选」必须在这里解析成具体值再传下去
    let method;
    try {
      const seconds = durationSeconds(startTime, endTime);
      ({ method } = resolveExportMethod(schedule.method, seconds));
    } catch (err) {
      log(`「${label}」跳过：${err.message}`);
      saveRun(schedule.id, { date: today, status: 'failed', message: err.message });
      return;
    }

    const channel = resolveChannel(schedule);
    const result = startExportTask({
      ip: device.ip, httpPort: device.httpPort, rtspPort: device.rtspPort, deviceId: device.id,
      user: device.username,
      pass: device.password,
      channel,
      startTime,
      endTime,
      method,
    });

    if (!result.ok) {
      log(`「${label}」启动失败：${result.error}`);
      saveRun(schedule.id, { date: today, status: 'failed', message: result.error });
      return;
    }

    log(`「${label}」已启动：通道 ${channel}，${schedule.startTime}–${schedule.endTime}，任务 ${result.taskId}`);
    saveRun(schedule.id, {
      date: today,
      status: 'started',
      taskId: result.taskId,
      filename: result.filename,
      method: result.method,
    });
  }

  function tick() {
    const currentTime = now();
    let schedules;
    try {
      schedules = listSchedules();
    } catch (err) {
      log(`读取计划失败：${err.message}`);
      return;
    }

    for (const schedule of dueSchedules(schedules, currentTime)) {
      try {
        runSchedule(schedule, currentTime);
      } catch (err) {
        log(`「${schedule.name || schedule.id}」执行出错：${err.message}`);
      }
    }
  }

  /**
   * 服务启动时把上次进程遗留的 started 记录改成 failed。
   *
   * 正常跑完的任务一定发出过终态广播（server.js 的 hook 按 taskId 回写
   * lastRun），能留在文件里的 started 只可能是导出中途服务崩溃/被杀。
   * 不处理的话 UI 会永远显示「进行中」，且用户无从判断昨晚到底跑完没有
   * ——这正是 lastRun 回写功能要解决的问题。
   *
   * date 必须保留原值（触发那天）：scheduler 靠 lastRun.date 判断「今天
   * 跑没跑过」，改掉它会导致重启当天又补跑一次。
   */
  function recoverInterruptedRuns() {
    let schedules;
    try {
      schedules = listSchedules();
    } catch (err) {
      log(`读取计划失败，跳过中断恢复：${err.message}`);
      return;
    }
    for (const schedule of schedules) {
      if (schedule.lastRun?.status === 'started' && !isTaskRecovering(schedule.lastRun.taskId)) {
        saveRun(schedule.id, {
          date: schedule.lastRun.date,
          status: 'failed',
          taskId: schedule.lastRun.taskId,
          filename: schedule.lastRun.filename,
          method: schedule.lastRun.method,
          message: '服务重启，任务中断，结果未知',
        });
        log(`「${schedule.name || schedule.id}」上次运行被中断，已标记为失败`);
      }
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      recoverInterruptedRuns();
      tick(); // 启动时先看一眼，补上当天已到点但没跑的那趟
      timer = setInterval(tick, TICK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

