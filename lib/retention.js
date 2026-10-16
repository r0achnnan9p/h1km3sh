/**
 * downloads/ 的保留策略。
 *
 * 为什么必须有：主码流 8192 kbps 录 2.5 小时，.hikraw 分片约 9 GB，加上成品 MP4
 * 一晚接近 18 GB。定时任务一天一趟，不清理的话一个月就能把盘写满，而写满盘的
 * 表现是导出中途失败，很难第一时间联想到是磁盘问题。
 *
 * 只动本工具自己产出的三类文件，其余一概不碰。
 */

import fs from 'fs';
import path from 'path';

/**
 * 只清理本工具自己产出的文件。
 *
 * 后三种是**导出中断后的残留**：正常跑完 rtspclip / 单流链路会自己删掉这些裸流
 * 中间文件，但服务重启、崩溃、断电时它们会留在原地，而且此前没有任何东西会清。
 * 一段 1 分钟的主码流分段就有 5 MB 出头，按每晚一趟攒下去不容忽视。
 * 按 7 天的年龄阈值删是安全的——没有哪次导出会跑上一星期。
 */
const PRUNABLE_SUFFIXES = ['.mp4', '.hikraw', '.hikraw.done', '.h264', '.hevc', '.aac'];

export function isPrunable(filename) {
  const lower = String(filename).toLowerCase();
  return PRUNABLE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * 挑出过期文件。抽成纯函数是为了能直接测边界，不用摆一堆真文件。
 *
 * @param {Array<{name:string, mtimeMs:number}>} entries
 * @param {{nowMs:number, retentionDays:number}} options
 * @returns {string[]} 该删的文件名
 */
export function findExpired(entries, { nowMs, retentionDays }) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];

  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  return entries
    .filter((entry) => isPrunable(entry.name) && entry.mtimeMs < cutoff)
    .map((entry) => entry.name);
}

/**
 * 清理目录里的过期文件。
 *
 * 删不掉的（权限、正被占用）只记一笔继续走，不要因为一个文件让整趟清理中断。
 *
 * @returns {{deleted:string[], freedBytes:number, failed:Array<{name:string,error:string}>}}
 */
export function pruneDirectory(dir, { retentionDays, nowMs = Date.now(), log = () => {} } = {}) {
  const result = { deleted: [], freedBytes: 0, failed: [] };

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return result;
  if (!fs.existsSync(dir)) return result;

  let entries;
  try {
    entries = fs.readdirSync(dir).map((name) => {
      const stats = fs.statSync(path.join(dir, name));
      return { name, mtimeMs: stats.mtimeMs, size: stats.size };
    });
  } catch (err) {
    log(`清理失败，读不了目录 ${dir}：${err.message}`);
    return result;
  }

  const sizeByName = new Map(entries.map((e) => [e.name, e.size]));

  for (const name of findExpired(entries, { nowMs, retentionDays })) {
    try {
      fs.unlinkSync(path.join(dir, name));
      result.deleted.push(name);
      result.freedBytes += sizeByName.get(name) || 0;
    } catch (err) {
      result.failed.push({ name, error: err.message });
    }
  }

  if (result.deleted.length) {
    const gb = (result.freedBytes / 1024 ** 3).toFixed(2);
    log(`清理了 ${result.deleted.length} 个超过 ${retentionDays} 天的文件，释放 ${gb} GB`);
  }
  for (const failure of result.failed) {
    log(`删不掉 ${failure.name}：${failure.error}`);
  }

  return result;
}
