/**
 * 读取普通 MP4 的时长，只解析文件头里的 moov/mvhd，不启动 ffprobe。
 *
 * 成片库列表会在每次轮询时重读文件名和大小；如果为每个成片启动一次
 * ffprobe，既慢又会和导出/缩略图争抢 CPU。这里按 box 结构逐个跳过
 * mdat，只读取少量头部字节，因此 faststart 与非 faststart 文件都能处理。
 * 无法解析（损坏、分片 MP4、没有 mvhd）时返回 null，由 UI 保留占位符。
 */
import fs from 'node:fs';

const HEADER_BYTES = 16;
const MVHD_MAX_BYTES = 40;

/** 读取指定偏移处的 box 头；box 必须在 limit 内完整结束。 */
function readBoxHeader(fd, offset, limit) {
  if (offset < 0 || offset + 8 > limit) return null;
  const header = Buffer.alloc(HEADER_BYTES);
  let bytes;
  try { bytes = fs.readSync(fd, header, 0, HEADER_BYTES, offset); } catch { return null; }
  if (bytes < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.toString('latin1', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (bytes < 16) return null;
    const large = header.readBigUInt64BE(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (!/^[\x20-\x7e]{4}$/.test(type) || size < headerSize || offset + size > limit) return null;
  return { type, size, headerSize, dataOffset: offset + headerSize, end: offset + size };
}

/** 在 [start, end) 的连续子 box 中查找指定类型。 */
function findChildBox(fd, start, end, wanted) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(fd, offset, end);
    if (!box || box.end <= offset) return null;
    if (box.type === wanted) return box;
    offset = box.end;
  }
  return null;
}

function readMvhdSeconds(fd, mvhd) {
  const length = Math.min(MVHD_MAX_BYTES, mvhd.end - mvhd.dataOffset);
  if (length < 20) return null;
  const payload = Buffer.alloc(length);
  let bytes;
  try { bytes = fs.readSync(fd, payload, 0, length, mvhd.dataOffset); } catch { return null; }
  if (bytes < 20) return null;
  const version = payload[0];
  // 未知版本不能套用 v0/v1 的字段偏移猜时长，交给 UI 保留占位符。
  if (version !== 0 && version !== 1) return null;
  const timescale = version === 1 ? (bytes >= 24 ? payload.readUInt32BE(20) : 0) : payload.readUInt32BE(12);
  if (!Number.isFinite(timescale) || timescale <= 0) return null;
  let duration;
  if (version === 1) {
    if (bytes < 32) return null;
    const large = payload.readBigUInt64BE(24);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(large);
  } else {
    duration = payload.readUInt32BE(16);
    if (duration === 0xffffffff) return null; // v0 未知时长，不能当成 49 天
  }
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.round((duration / timescale) * 1000) / 1000;
}

/**
 * @param {string} filePath
 * @returns {number|null} 秒数；无法解析时返回 null
 */
export function readMp4DurationSeconds(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const size = fs.fstatSync(fd).size;
    let offset = 0, moov = null;
    while (offset + 8 <= size) {
      const box = readBoxHeader(fd, offset, size);
      if (!box || box.end <= offset) return null;
      if (box.type === 'moov') { moov = box; break; }
      offset = box.end;
    }
    if (!moov) return null;
    const mvhd = findChildBox(fd, moov.dataOffset, moov.end, 'mvhd');
    return mvhd ? readMvhdSeconds(fd, mvhd) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 只读探测器不能影响列表 */ }
    }
  }
}
