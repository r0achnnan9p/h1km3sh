/**
 * Segment Splitter Module
 *
 * Splits a requested time range into shorter segments for parallel downloading.
 * Adds configurable overlap duration at segment boundaries to ensure seamless
 * concatenation after trimming.
 */

/**
 * Parse Hikvision time format string to Date object.
 * Format: "YYYYMMDDTHHmmssZ" e.g. "20231012T080000Z"
 * @param {string} timeStr - Hikvision format time string
 * @returns {Date} Parsed Date object
 */
function parseHikvisionTime(timeStr) {
  const year = parseInt(timeStr.substring(0, 4), 10);
  const month = parseInt(timeStr.substring(4, 6), 10) - 1; // 0-indexed
  const day = parseInt(timeStr.substring(6, 8), 10);
  // Skip 'T' at index 8
  const hour = parseInt(timeStr.substring(9, 11), 10);
  const minute = parseInt(timeStr.substring(11, 13), 10);
  const second = parseInt(timeStr.substring(13, 15), 10);
  // Skip 'Z' at index 15

  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

/**
 * Format a Date object to Hikvision time format string.
 * @param {Date} date - Date object to format
 * @returns {string} Hikvision format time string "YYYYMMDDTHHmmssZ"
 */
function formatHikvisionTime(date) {
  const year = date.getUTCFullYear().toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hour = date.getUTCHours().toString().padStart(2, '0');
  const minute = date.getUTCMinutes().toString().padStart(2, '0');
  const second = date.getUTCSeconds().toString().padStart(2, '0');

  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

/**
 * Split a time range into segments for parallel downloading.
 *
 * @param {string} startTime - Start time in Hikvision format "YYYYMMDDTHHmmssZ"
 * @param {string} endTime - End time in Hikvision format "YYYYMMDDTHHmmssZ"
 * @param {number} segmentDuration - Duration of each segment in seconds (default 120, min 30)
 * @param {number} overlapDuration - Overlap duration in seconds (default 3)
 * @returns {Array<Object>} Array of TimeSegment objects
 */
export function splitTimeRange(startTime, endTime, segmentDuration = 120, overlapDuration = 3) {
  // Validate segmentDuration
  if (segmentDuration < 30) {
    throw new Error(`segmentDuration must be >= 30 seconds, got ${segmentDuration}`);
  }

  const startDate = parseHikvisionTime(startTime);
  const endDate = parseHikvisionTime(endTime);
  const totalDurationSeconds = Math.floor((endDate.getTime() - startDate.getTime()) / 1000);

  // When total duration <= 60s, return single segment covering full range with no overlap
  if (totalDurationSeconds <= 60) {
    return [{
      index: 0,
      startTime: startTime,
      endTime: endTime,
      originalStart: startTime,
      originalEnd: endTime,
      isFirst: true,
      isLast: true,
      overlapBefore: 0,
      overlapAfter: 0,
    }];
  }

  // Calculate number of full segments and build segment list
  const numFullSegments = Math.floor(totalDurationSeconds / segmentDuration);
  const remainder = totalDurationSeconds % segmentDuration;
  const totalSegments = remainder > 0 ? numFullSegments + 1 : numFullSegments;

  const segments = [];

  for (let i = 0; i < totalSegments; i++) {
    const isFirst = i === 0;
    const isLast = i === totalSegments - 1;

    // Calculate original (non-overlapping) boundaries
    const originalStartSeconds = i * segmentDuration;
    const originalEndSeconds = isLast
      ? totalDurationSeconds
      : (i + 1) * segmentDuration;

    const originalStartDate = new Date(startDate.getTime() + originalStartSeconds * 1000);
    const originalEndDate = new Date(startDate.getTime() + originalEndSeconds * 1000);

    // Calculate actual boundaries with overlap
    const overlapBefore = isFirst ? 0 : overlapDuration;
    const overlapAfter = isLast ? 0 : overlapDuration;

    const actualStartDate = new Date(originalStartDate.getTime() - overlapBefore * 1000);
    const actualEndDate = new Date(originalEndDate.getTime() + overlapAfter * 1000);

    segments.push({
      index: i,
      startTime: formatHikvisionTime(actualStartDate),
      endTime: formatHikvisionTime(actualEndDate),
      originalStart: formatHikvisionTime(originalStartDate),
      originalEnd: formatHikvisionTime(originalEndDate),
      isFirst,
      isLast,
      overlapBefore,
      overlapAfter,
    });
  }

  return segments;
}
