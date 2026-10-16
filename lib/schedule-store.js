/**
 * 定时导出计划，存 data/schedules.json。
 *
 * 文件本身就是接口：常驻服务里的 scheduler 每分钟重读一遍，MCP 进程（另一个
 * 进程，同一台机器）直接用这个模块读写同一个文件。所以没有 /api/schedules 那组
 * 端点——四个路由换不来什么，反而多一层要维护的东西。
 *
 * 位置规则与 devices.json 相同，见 data-dir.js。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDataDir } from './data-dir.js';
import { localDateStr, localSecondsOfDay, parseClock } from './hik-time.js';

const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, 'schedules.json');

/** 磁盘保留天数。主码流 2.5 小时约 9 GB 分片 + 成品，不清理一个月就能写满盘。 */
export const DEFAULT_RETENTION_DAYS = 7;

const DEFAULT_RUN_AT = '23:00';

/**
 * 首次运行时写入的默认计划：每天 23:00 拉当晚 20:00–22:30。
 *
 * 只有**当下已经过了 runAt** 才把今天标成跑过——那种情况下不标的话，服务一起来
 * 就会立刻触发一次 2.5 小时的导出，对刚装好的人太突然。在 runAt 之前装的话
 * lastRun 留空即可，今晚照常跑，没必要白白跳过一整晚。
 */
export function defaultSchedule(today = localDateStr(), now = new Date()) {
  const alreadyPastRunAt = localSecondsOfDay(now) >= parseClock(DEFAULT_RUN_AT);

  return {
    id: crypto.randomUUID(),
    name: '每晚常规',
    enabled: true,
    channel: null,
    startTime: '20:00',
    endTime: '22:30',
    runAt: DEFAULT_RUN_AT,
    method: 'auto',
    retentionDays: DEFAULT_RETENTION_DAYS,
    lastRun: alreadyPastRunAt
      ? { date: today, status: 'seeded', message: '首次创建时已过 runAt，跳过当天' }
      : null,
    createdAt: new Date().toISOString(),
  };
}

export function getScheduleFilePath() {
  return DATA_FILE;
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = { schedules: [defaultSchedule()] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(seeded, null, 2), 'utf-8');
  }
}

function readStore() {
  ensureDataFile();
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    if (!Array.isArray(data.schedules)) data.schedules = [];
    return data;
  } catch {
    // 文件被写坏时按「没有计划」处理：宁可不跑，也不要拿半个配置去导出
    return { schedules: [] };
  }
}

function writeStore(data) {
  ensureDataFile();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

export function getSchedules() {
  return readStore().schedules;
}

export function getScheduleById(id) {
  return readStore().schedules.find((s) => s.id === id) || null;
}

export function addSchedule(fields) {
  const store = readStore();
  const schedule = {
    ...defaultSchedule(),
    ...fields,
    id: crypto.randomUUID(),
    lastRun: null,
    createdAt: new Date().toISOString(),
  };
  store.schedules.push(schedule);
  writeStore(store);
  return schedule;
}

const UPDATABLE = ['name', 'enabled', 'channel', 'startTime', 'endTime', 'runAt', 'method', 'retentionDays'];

export function updateSchedule(id, fields) {
  const store = readStore();
  const index = store.schedules.findIndex((s) => s.id === id);
  if (index === -1) return null;

  for (const key of UPDATABLE) {
    if (fields[key] !== undefined) store.schedules[index][key] = fields[key];
  }
  store.schedules[index].updatedAt = new Date().toISOString();

  writeStore(store);
  return store.schedules[index];
}

export function deleteSchedule(id) {
  const store = readStore();
  const before = store.schedules.length;
  store.schedules = store.schedules.filter((s) => s.id !== id);
  if (store.schedules.length === before) return false;
  writeStore(store);
  return true;
}

/**
 * 记录一次触发结果。date 用本地日期，scheduler 靠它判断今天跑没跑过，
 * 所以**无论成功失败都要写**——失败了也不该在同一天里反复重试。
 */
export function recordRun(id, lastRun) {
  const store = readStore();
  const schedule = store.schedules.find((s) => s.id === id);
  if (!schedule) return null;

  schedule.lastRun = { at: new Date().toISOString(), ...lastRun };
  writeStore(store);
  return schedule;
}
