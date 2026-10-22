/**
 * Server-side UI session storage backed by a JSON file.
 *
 * 存的是「上次在界面上选到哪儿」：日期、起止时间、通道、导出方式。
 * 早期这些放在浏览器 localStorage 里，换浏览器/换电脑就丢，也和已经落在服务端的
 * 设备列表（device-store.js）不一致。
 *
 * 文件位置规则与 devices.json 相同，见 data-dir.js。
 */

import fs from 'fs';
import path from 'path';
import { resolveDataDir } from './data-dir.js';

const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, 'session.json');

const DEFAULT_SESSION = {
  date: null,
  startTime: null,
  endTime: null,
  channel: null,
  exportMethod: null,
};

/** 白名单：前端只能写这些字段，避免把任意内容落到磁盘 */
const ALLOWED_KEYS = Object.keys(DEFAULT_SESSION);

/** Absolute path to the session.json file currently in use. */
export function getSessionFilePath() {
  return DATA_FILE;
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_SESSION, null, 2), 'utf-8');
  }
}

function readStore() {
  ensureDataFile();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return { ...DEFAULT_SESSION, ...raw };
  } catch {
    // 文件被写坏时退回默认值，不要让整个页面加载不出来
    return { ...DEFAULT_SESSION };
  }
}

function writeStore(data) {
  ensureDataFile();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

/** @returns {{date:string|null, startTime:string|null, endTime:string|null, channel:string|null, exportMethod:string|null}} */
export function getSession() {
  return readStore();
}

/**
 * 合并式更新：只覆盖 patch 里出现的已知字段，其余保持原值。
 *
 * @param {object} patch
 * @returns {object} 更新后的完整会话
 */
export function saveSession(patch) {
  const next = readStore();
  for (const key of ALLOWED_KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      const value = patch[key];
      next[key] = (value === null || value === undefined) ? null : String(value);
    }
  }
  writeStore(next);
  return next;
}
