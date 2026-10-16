/** 使用海康的墙钟数轴，不接受带时区的 ISO 日期。 */
import { toCompact, compactToMs, msToCompact, compactToDisplay } from './hik-time.js';

export function wallTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    throw new Error('时间必须为 YYYY-MM-DD HH:MM[:SS]，按录像机本地墙钟填写。');
  }
  return compactToMs(toCompact(value.slice(0, 10), value.slice(11)));
}

export function wallRange(start, end) {
  const startMs = wallTime(start), endMs = wallTime(end);
  if (endMs <= startMs) throw new Error('结束时间必须晚于开始时间。');
  return { startMs, endMs, durationSeconds: (endMs - startMs) / 1000 };
}

export function displayWall(ms) {
  return compactToDisplay(msToCompact(ms));
}
