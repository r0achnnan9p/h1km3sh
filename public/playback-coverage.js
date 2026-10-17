/** 返回导出区间内第一个本地录像缺口；没有缺口则返回 null。 */
export function findCoverageGap(segments, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const ranges = coverageRanges(segments, startMs, endMs);

  let coveredUntil = startMs;
  for (const range of ranges) {
    if (range.end <= coveredUntil) continue;
    if (range.start > coveredUntil) return { start: coveredUntil, end: Math.min(endMs, range.start) };
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= endMs) return null;
  }
  return coveredUntil < endMs ? { start: coveredUntil, end: endMs } : null;
}

function coverageRanges(segments, startMs, endMs) {
  return (segments || []).map(segment => {
    const start = Number.isFinite(segment.startMs) ? segment.startMs : Date.parse(segment.start);
    const end = Number.isFinite(segment.endMs) ? segment.endMs : start + Number(segment.duration) * 1000;
    return { start, end };
  }).filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start && range.end > startMs && range.start < endMs)
    .sort((left, right) => left.start - right.start);
}

/** List every disjoint missing interval, clipped to the selected range. */
export function listCoverageGaps(segments, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  let coveredUntil = startMs;
  const missing = [];
  for (const range of coverageRanges(segments, startMs, endMs)) {
    if (range.end <= coveredUntil || range.end <= range.start) continue;
    if (range.start > coveredUntil) missing.push({ start: coveredUntil, end: Math.min(endMs, range.start) });
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= endMs) return missing;
  }
  if (coveredUntil < endMs) missing.push({ start: coveredUntil, end: endMs });
  return missing;
}

/** Count disjoint missing intervals; server consent stays authoritative. */
export function countCoverageGaps(segments, startMs, endMs) {
  return listCoverageGaps(segments, startMs, endMs).length;
}

const gapTimeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function gapClock(value) {
  let milliseconds = typeof value === 'number' ? value : NaN;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
      milliseconds = Date.parse(value.replace(' ', 'T') + '+08:00');
    } else if (/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) return null;
  const parts = Object.fromEntries(gapTimeParts.formatToParts(new Date(milliseconds)).map(part => [part.type, part.value]));
  return { milliseconds, clock: `${parts.hour}:${parts.minute}:${parts.second}`,
    day: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000 };
}

function gapDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '时长待核实';
  const rounded = Math.round(milliseconds);
  if (rounded === 0) return '小于0.001秒';
  const seconds = Math.floor(rounded / 1000), fraction = rounded % 1000;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  const secondText = String(seconds % 60).padStart(hours || minutes ? 2 : 1, '0') +
    (fraction ? `.${String(fraction).padStart(3, '0').replace(/0+$/, '')}` : '');
  if (hours) return `${hours}小时${String(minutes).padStart(2, '0')}分${secondText}秒`;
  return `${minutes ? `${minutes}分` : ''}${secondText}秒`;
}

/** Present cached UTC gaps or server wall-clock gaps without redundant dates.
 * Server start/end strings control the clocks: its numeric bounds use a different
 * time axis from the browser timeline, but their difference still gives duration.
 * Formatting is presentation-only and never changes recording coverage or consent.
 */
export function formatCoverageGap(interval) {
  const start = gapClock(interval?.start), end = gapClock(interval?.end);
  const days = start && end ? end.day - start.day : 0;
  const dayLabel = days === 1 ? '次日 ' : days > 1 ? `${days}天后 ` : '';
  const milliseconds = Number.isFinite(interval?.durationSeconds) ? interval.durationSeconds * 1000
    : Number.isFinite(interval?.startMs) && Number.isFinite(interval?.endMs) ? interval.endMs - interval.startMs
      : start && end ? end.milliseconds - start.milliseconds : NaN;
  return { rangeText: `${start?.clock || '--:--:--'} → ${dayLabel}${end?.clock || '--:--:--'}`,
    durationText: gapDuration(milliseconds) };
}
