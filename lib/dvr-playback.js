const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 海康时间串的 Z 表示录像机墙上时间；转换成播放器使用的真实时间轴。 */
function parseDvrTime(value) {
  const text = String(value || '');
  const wallClock = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?$/.exec(text);
  return Date.parse(wallClock ? `${wallClock[1]}+08:00` : text);
}

/** 海康 ISAPI 录像搜索区间和结果转换为控制台使用的上海日期区段。 */
export function dvrDateRange(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式必须为 YYYY-MM-DD。');
  const [year, month, day] = date.split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== date) throw new Error('日期不存在。');
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const wallStartMs = Date.parse(`${date}T00:00:00Z`), wallEndMs = Date.parse(`${nextDate}T00:00:00Z`);
  return { start: new Date(wallStartMs).toISOString(), end: new Date(wallEndMs).toISOString(),
    startMs: wallStartMs - SHANGHAI_OFFSET_MS, endMs: wallEndMs - SHANGHAI_OFFSET_MS };
}

export function normalizeDvrSegments(files, date) {
  const { startMs: dayStart, endMs: dayEnd } = dvrDateRange(date);
  return (files || []).flatMap(file => {
    const startMs = parseDvrTime(file?.startTime), endMs = parseDvrTime(file?.endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    const start = Math.max(startMs, dayStart), end = Math.min(endMs, dayEnd);
    return end > start ? [{ start: new Date(start).toISOString(), duration: (end - start) / 1000 }] : [];
  }).sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}
