/**
 * 成品 MP4 的文件操作：枚举、删除、重命名。
 *
 * 只允许 .mp4：downloads/ 里还躺着几 GB 一个的 .hikraw 分片缓存，那是中间产物，
 * 没有理由让它们可以被整个局域网拖走（下载路由的放行逻辑在 server.js）。
 *
 * 路径安全：所有文件名必须满足「以 .mp4 结尾 + basename 即自身」，任何含路径
 * 分隔符或非 mp4 后缀的名字一律拒绝——这些名字可能来自 URL 参数（express
 * 已做 decode），不能直接拼进 fs 路径。
 */

import fs from 'fs';
import path from 'path';

/** 合法成品文件名：.mp4 结尾、无路径分隔符。 */
export function isOutputFilename(name) {
  return typeof name === 'string'
    && name.length > 0
    && !/[\x00-\x1f\x7f]/.test(name)
    && name.toLowerCase().endsWith('.mp4')
    && path.basename(name) === name
    && !name.includes('/')
    && !name.includes('\\');
}

/** UI and API accept a human title without requiring users to type the extension. */
export function normalizeOutputName(value) {
  if (typeof value !== 'string') throw new Error('新文件名不合法');
  const name = value.trim();
  const normalized = path.extname(name) ? name : `${name}.mp4`;
  if (!name || !isOutputFilename(normalized) || Buffer.byteLength(normalized, 'utf8') > 255) {
    throw new Error('新文件名不合法：请输入不含路径且不超过 255 字节的 MP4 名称。');
  }
  return normalized;
}

/** 紧凑时间（YYYYMMDDTHHmmssZ）→ ISO（YYYY-MM-DDTHH:mm:ssZ），解析失败返回空串。 */
export function compactToIso(compact) {
  if (typeof compact !== 'string' || !/^\d{8}T\d{6}Z$/.test(compact)) return '';
  const year = compact.slice(0, 4);
  const month = compact.slice(4, 6);
  const day = compact.slice(6, 8);
  const hour = compact.slice(9, 11);
  const min = compact.slice(11, 13);
  const sec = compact.slice(13, 15);
  return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
}

/**
 * 枚举成品 MP4（新的在前）。
 *
 * @param {string} downloadsDir
 * @param {{limit?:number}} [opts]
 * @returns {Array<{filename:string,size:number,modifiedAt:string,channel:string,startTime:string,endTime:string,url:string}>}
 */
export function listOutputFiles(downloadsDir, { limit = 50 } = {}) {
  const files = fs.readdirSync(downloadsDir)
    .filter((f) => f.toLowerCase().endsWith('.mp4'))
    .map((filename) => {
      // 枚举和 stat 之间文件可能被外部进程删掉（如正在清理的导出任务），
      // 单个文件 stat 失败不该让整个列表 500
      let stats;
      try {
        stats = fs.lstatSync(path.join(downloadsDir, filename));
        if (!isOutputFilename(filename) || !stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) return null;
      } catch {
        return null;
      }
      // baseFilename 形如 ch101_20260807T200000Z_to_20260807T223000Z；
      // 用户重命名过的中文名解析不出通道/时间，字段留空即可
      const match = filename.match(/^ch(\w+)_(\d{8}T\d{6}Z)_to_(\d{8}T\d{6}Z)\.mp4$/);
      return {
        filename,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        channel: match ? match[1] : '',
        startTime: match ? compactToIso(match[2]) : '',
        endTime: match ? compactToIso(match[3]) : '',
        url: `/downloads/${encodeURIComponent(filename)}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, Math.max(1, Math.min(200, limit)));
  return files;
}

/**
 * 删除一个成品。文件名不合法直接抛错；文件不存在返回 false。
 * @returns {boolean} 是否真的删掉了
 */
export function deleteOutputFile(downloadsDir, filename) {
  if (!isOutputFilename(filename)) {
    throw new Error('文件名不合法：只允许 .mp4 且不能包含路径');
  }
  const fullPath = path.join(downloadsDir, filename);
  if (!fs.existsSync(fullPath)) return false;
  fs.unlinkSync(fullPath);
  return true;
}

/**
 * 重命名一个成品。源不存在返回 null；目标已存在或名字不合法抛错。
 *
 * 错误带 `code` 字段供路由层区分状态码：`OUTPUT_EXISTS`（目标重名）之外
 * 都算参数错误。别用 message 字符串匹配——换文案就断。
 *
 * @returns {string|null} 新文件名
 */
export function renameOutputFile(downloadsDir, filename, newName) {
  if (!isOutputFilename(filename)) {
    throw new Error('文件名不合法：只允许 .mp4 且不能包含路径');
  }
  if (!isOutputFilename(newName)) {
    throw new Error('新文件名不合法：只允许 .mp4 且不能包含路径');
  }
  const src = path.join(downloadsDir, filename);
  const dst = path.join(downloadsDir, newName);
  let stats;
  try { stats = fs.lstatSync(src); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('源文件不合法：只允许普通 MP4 文件');
  if (newName === filename) return filename;

  try {
    // link 的排他创建避免 exists + rename 之间出现同名文件时被覆盖。
    fs.linkSync(src, dst);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const exists = new Error(`目标文件已存在：${newName}`);
    exists.code = 'OUTPUT_EXISTS';
    throw exists;
  }
  try {
    const current = fs.lstatSync(src), target = fs.lstatSync(dst);
    if (![current, target].every(file => file.isFile() && !file.isSymbolicLink()
      && file.dev === stats.dev && file.ino === stats.ino && file.size === stats.size && file.mtimeMs === stats.mtimeMs)) {
      throw new Error('文件在改名期间发生变化');
    }
    fs.unlinkSync(src);
  } catch (cause) {
    // unlink 可能已经生效才报错，或路径被外部替换；回滚删除 dst 会丢录像。
    // 保留能确认已创建的新路径，交给用户刷新检查，不删除任何猜测的目标。
    const error = new Error(`新文件名已创建为 ${newName}，但未能确认旧文件名已移除；请刷新检查，录像文件已保留。`, { cause });
    error.code = 'OUTPUT_RENAME_PARTIAL';
    error.filename = newName;
    throw error;
  }
  return newName;
}

