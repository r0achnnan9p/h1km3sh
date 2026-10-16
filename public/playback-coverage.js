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
  }).filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > startMs && range.start < endMs)
    .sort((left, right) => left.start - right.start);
}

/** Count disjoint missing intervals for the local export warning; server consent stays authoritative. */
export function countCoverageGaps(segments, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  let coveredUntil = startMs, count = 0;
  for (const range of coverageRanges(segments, startMs, endMs)) {
    if (range.end <= coveredUntil || range.end <= range.start) continue;
    if (range.start > coveredUntil) count++;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= endMs) return count;
  }
  return count + (coveredUntil < endMs ? 1 : 0);
}
