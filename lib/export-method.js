/**
 * 按时长自动挑导出方式。
 *
 * 短片段用 rtspclip：`Rate-Control: no` 全速拉流，不用先下整个录像文件，快。
 * 长片段用 mp4download：慢一些，但 .hikraw 分片有断点续传，而且**留在本地能被
 * 后续重导复用**——这才是选它的主要理由。
 *
 * 复用是这样发生的：每天 20:00–22:30 那趟走 mp4download，分片留下；某天 19:30
 * 就开球了，重导 19:30–22:30 时 20:00 之后的部分直接命中缓存，只需要新下
 * 19:30–20:00 覆盖到的那个录像文件。缓存文件名里的起止时间是 NVR 上录像文件
 * **自身**的边界（见 lib/file-downloader.js），不是请求区间的边界，所以重叠
 * 区间天然命中，不需要额外做区间对齐。
 *
 * 也正因为有这条复用路径，「扩展时段」一律是换参数重导一次，而不是把两段成品
 * MP4 拼起来——拼成品要求两段编码参数完全一致、时间戳连续，出问题极难排查。
 */

/** 分界线：满 1 小时就换 mp4download。 */
export const METHOD_THRESHOLD_SECONDS = 3600;

export const EXPORT_METHODS = ['rtspclip', 'mp4download'];

/**
 * @param {number} durationSeconds 导出区间时长（秒）
 * @returns {{method:'rtspclip'|'mp4download', reason:string}}
 */
export function pickExportMethod(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Invalid duration: ${durationSeconds}`);
  }

  // 不足 1 分钟的按秒说，否则「30 秒」会被四舍五入成「约 1 分钟」
  const span = durationSeconds < 60
    ? `${Math.round(durationSeconds)} 秒`
    : `约 ${Math.round(durationSeconds / 60)} 分钟`;

  if (durationSeconds < METHOD_THRESHOLD_SECONDS) {
    return {
      method: 'rtspclip',
      reason: `时长 ${span}，不足 1 小时，用快速导出（rtspclip）`,
    };
  }

  return {
    method: 'mp4download',
    reason: `时长 ${span}，达到 1 小时，用完整下载（mp4download）以获得断点续传和分片缓存复用`,
  };
}

/**
 * 解析用户/调用方给的 method。'auto'、空值都走自动选择；显式指定则原样返回，
 * 并说明这是显式覆盖（好让 MCP 把理由如实转述给使用者）。
 *
 * @param {string|undefined|null} requested
 * @param {number} durationSeconds
 * @returns {{method:'rtspclip'|'mp4download', reason:string, auto:boolean}}
 */
export function resolveExportMethod(requested, durationSeconds) {
  if (!requested || requested === 'auto') {
    return { ...pickExportMethod(durationSeconds), auto: true };
  }

  if (!EXPORT_METHODS.includes(requested)) {
    throw new Error(`Unsupported export method: ${requested}（可选 ${EXPORT_METHODS.join(' / ')} 或 auto）`);
  }

  return { method: requested, reason: `调用方显式指定了 ${requested}`, auto: false };
}
