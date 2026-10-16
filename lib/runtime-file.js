/**
 * 后台服务的运行时信息（pid + 实际监听端口）。
 *
 * 只有设置了 HIKVISION_RUNTIME_FILE 才会写——该变量由 `service install` 生成的
 * 服务定义注入，普通前台运行不受影响。service CLI 靠这个文件回答两个问题：
 * 「现在跑没跑」和「端口自动顺延后到底落在哪个端口」。
 */

import fs from 'fs';
import path from 'path';

export function getRuntimeFilePath() {
  return process.env.HIKVISION_RUNTIME_FILE || null;
}

export function writeRuntimeFile(info) {
  const target = getRuntimeFilePath();
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const payload = { pid: process.pid, startedAt: new Date().toISOString(), ...info };
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(`  [service] 写入运行时信息失败: ${err.message}`);
  }
}

export function clearRuntimeFile() {
  const target = getRuntimeFilePath();
  if (!target) return;
  try {
    fs.unlinkSync(target);
  } catch (_) {
    // 文件不存在或已被清理
  }
}

export function readRuntimeFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

/** pid 是否还活着（signal 0 只做存在性探测，Windows 同样适用） */
export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 进程退出前清掉运行时文件，避免 status 读到过期 pid */
export function registerRuntimeCleanup() {
  if (!getRuntimeFilePath()) return;
  process.once('exit', clearRuntimeFile);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      clearRuntimeFile();
      process.exit(0);
    });
  }
}
