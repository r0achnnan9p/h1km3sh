/**
 * 人话时间（"2026-08-07" + "19:30"）↔ 海康紧凑时间（YYYYMMDDTHHmmssZ）。
 *
 * 全项目的语义是「本地墙上时钟直接贴 Z，不做时区换算」：前端 formatHikTime()
 * 就是这么干的，server.js 里「结束时间不能晚于当前时间」的校验也按同样语义
 * 折算当前时刻，源码进程的 TZ 必须与 NVR 时区一致。这里必须保持一致
 * ——19:30 指的是 NVR 面板上显示的 19:30，不是 UTC 19:30。
 *
 * 所以这个模块里不出现任何时区换算，只做字符串拼装和字段算术。
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * compact "20260714T020000Z" → epoch 毫秒。
 *
 * 注意这是「按 UTC 解析墙上时钟」，得到的不是真实时刻，只是一个可以互相比较
 * 和相减的数轴坐标。要和 Date.now() 比较，必须把当前时刻按同样方式折算
 * （server.js 的 nowWallMs 就是干这个的）。
 */
export function compactToMs(compact) {
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  return Date.parse(iso);
}

/** epoch 毫秒 → compact 格式 */
export function msToCompact(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * 校验 "YYYY-MM-DD"，返回 {year, month, day}；格式或日历上不成立时抛错。
 */
export function parseDate(dateStr) {
  const match = DATE_PATTERN.exec(String(dateStr ?? '').trim());
  if (!match) {
    throw new Error(`日期格式应为 YYYY-MM-DD，收到：${dateStr}`);
  }

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  // 用 UTC 构造来复核日历合法性（2026-02-30 这种），构造本身不代表时区语义
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`日期不存在：${dateStr}`);
  }

  return { year, month, day };
}

/**
 * 校验 "HH:MM" / "HH:MM:SS"，返回当天第几秒；不合法时抛错。
 */
export function parseClock(timeStr) {
  const match = CLOCK_PATTERN.exec(String(timeStr ?? '').trim());
  if (!match) {
    throw new Error(`时间格式应为 HH:MM 或 HH:MM:SS，收到：${timeStr}`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);

  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(`时间超出范围：${timeStr}`);
  }

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * "2026-08-07" + "19:30" → "20260807T193000Z"
 */
export function toCompact(dateStr, timeStr) {
  const { year, month, day } = parseDate(dateStr);
  const secondsOfDay = parseClock(timeStr);

  const hours = Math.floor(secondsOfDay / 3600);
  const minutes = Math.floor((secondsOfDay % 3600) / 60);
  const seconds = secondsOfDay % 60;

  return `${year}${pad2(month)}${pad2(day)}T${pad2(hours)}${pad2(minutes)}${pad2(seconds)}Z`;
}

/**
 * "20260807T193000Z" → "2026-08-07 19:30:00"（给人看，不给设备看）
 */
export function compactToDisplay(compact) {
  const s = String(compact ?? '');
  if (!/^\d{8}T\d{6}Z$/.test(s)) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
}

/**
 * 两个紧凑时间之间的秒数。两端都按同一套「贴 Z 不换算」语义解析，
 * 所以差值就是真实的墙钟时长。
 */
export function durationSeconds(startCompact, endCompact) {
  const startMs = compactToMs(startCompact);
  const endMs = compactToMs(endCompact);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error(`无法解析时间范围：${startCompact} → ${endCompact}`);
  }
  return (endMs - startMs) / 1000;
}

/** 本地日期字符串 "YYYY-MM-DD"。 */
export function localDateStr(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 本地时钟 "HH:MM"。 */
export function localClockStr(now = new Date()) {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** 本地时间是当天第几秒。 */
export function localSecondsOfDay(now = new Date()) {
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

/**
 * 把本地日期往前/后挪 n 天，返回 "YYYY-MM-DD"。
 * 用 UTC 做算术避开夏令时导致的 ±1 小时漂移，再取 UTC 字段——因为输入输出
 * 都只是「日历上的那一天」，不带时刻。
 */
export function shiftDate(dateStr, days) {
  const { year, month, day } = parseDate(dateStr);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}
