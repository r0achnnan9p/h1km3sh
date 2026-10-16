/**
 * Segment Trimmer Module
 *
 * Removes overlap duration from the beginning of downloaded segments by locating
 * the first I-frame at or after the overlap point. Preserves Annex B format
 * without re-encoding.
 */

import fs from 'node:fs';
import path from 'node:path';

// NAL unit start code patterns
const START_CODE_4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const START_CODE_3 = Buffer.from([0x00, 0x00, 0x01]);

/**
 * Find the next NAL unit start code position in a buffer starting from offset.
 * Handles both 4-byte (0x00 0x00 0x00 0x01) and 3-byte (0x00 0x00 0x01) start codes.
 *
 * @param {Buffer} buf - The buffer to search
 * @param {number} offset - Starting position for the search
 * @returns {{ position: number, length: number } | null} Position and length of start code, or null if not found
 */
function findNextStartCode(buf, offset) {
  for (let i = offset; i < buf.length - 3; i++) {
    // Check 4-byte start code first
    if (buf[i] === 0x00 && buf[i + 1] === 0x00 && buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
      return { position: i, length: 4 };
    }
    // Check 3-byte start code (only if not part of a 4-byte code)
    if (buf[i] === 0x00 && buf[i + 1] === 0x00 && buf[i + 2] === 0x01) {
      // Make sure this isn't preceded by 0x00 (which would make it a 4-byte code)
      if (i === 0 || buf[i - 1] !== 0x00) {
        return { position: i, length: 3 };
      }
    }
  }
  return null;
}

/**
 * Check if a NAL unit is an I-frame (IDR) based on codec type.
 *
 * H.264: nal_unit_type = byte & 0x1F, IDR = type 5
 * HEVC:  nal_unit_type = (byte >> 1) & 0x3F, IDR_W_RADL = 19, IDR_N_LP = 20
 *
 * @param {number} nalHeaderByte - First byte after the start code
 * @param {string} codec - "h264" or "hevc"
 * @returns {boolean} True if this NAL unit is an IDR frame
 */
function isIFrame(nalHeaderByte, codec) {
  if (codec === 'h264') {
    const nalType = nalHeaderByte & 0x1F;
    return nalType === 5;
  } else if (codec === 'hevc') {
    const nalType = (nalHeaderByte >> 1) & 0x3F;
    return nalType === 19 || nalType === 20;
  }
  return false;
}

/**
 * Estimate the duration of a segment in seconds from its TimeSegment object.
 *
 * @param {Object} segment - TimeSegment object with startTime and endTime
 * @returns {number} Duration in seconds
 */
function estimateSegmentDuration(segment) {
  const start = parseHikvisionTime(segment.startTime);
  const end = parseHikvisionTime(segment.endTime);
  return (end.getTime() - start.getTime()) / 1000;
}

/**
 * Parse Hikvision time format string to Date object.
 * Format: "YYYYMMDDTHHmmssZ"
 *
 * @param {string} timeStr - Hikvision format time string
 * @returns {Date} Parsed Date object
 */
function parseHikvisionTime(timeStr) {
  const year = parseInt(timeStr.substring(0, 4), 10);
  const month = parseInt(timeStr.substring(4, 6), 10) - 1;
  const day = parseInt(timeStr.substring(6, 8), 10);
  const hour = parseInt(timeStr.substring(9, 11), 10);
  const minute = parseInt(timeStr.substring(11, 13), 10);
  const second = parseInt(timeStr.substring(13, 15), 10);
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

/**
 * Trim overlap from the beginning of downloaded segments.
 *
 * For the first segment: no trimming needed, returns as-is.
 * For subsequent segments: locates the first I-frame at or after the overlap
 * duration byte offset. If no I-frame is found within 2 seconds of the expected
 * trim point, falls back to the nearest NAL start code boundary at the overlap offset.
 *
 * @param {Array<Object>} segments - Array of TimeSegment objects
 * @param {Array<Object>} segmentFiles - Array of SegmentResult objects with filePath and fileSize
 * @param {string} codec - "h264" or "hevc"
 * @param {number} overlapDuration - Overlap duration in seconds
 * @returns {Promise<Array<Object>>} Array of TrimResult objects
 */
export async function trimOverlaps(segments, segmentFiles, codec, overlapDuration) {
  const results = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const segmentFile = segmentFiles[i];

    // First segment: no trimming needed
    if (segment.isFirst) {
      results.push({
        index: i,
        trimmedPath: segmentFile.filePath,
        bytesRemoved: 0,
      });
      continue;
    }

    // Read the segment file
    const fileData = fs.readFileSync(segmentFile.filePath);
    const fileSize = fileData.length;

    if (fileSize === 0) {
      // Empty file, return as-is
      results.push({
        index: i,
        trimmedPath: segmentFile.filePath,
        bytesRemoved: 0,
      });
      continue;
    }

    // Calculate the approximate byte offset for the overlap duration
    const segmentDuration = estimateSegmentDuration(segment);
    const bytesPerSecond = fileSize / segmentDuration;
    const overlapByteOffset = Math.floor(overlapDuration * bytesPerSecond);

    // Calculate the 2-second search window in bytes
    const searchWindowBytes = Math.floor(2 * bytesPerSecond);
    const maxSearchOffset = Math.min(overlapByteOffset + searchWindowBytes, fileSize);

    // Search for I-frame starting from the overlap byte offset
    let trimPoint = -1;
    let fallbackStartCodePos = -1;
    let searchPos = Math.max(0, overlapByteOffset - 4); // Start slightly before to catch start codes at boundary

    while (searchPos < maxSearchOffset) {
      const startCode = findNextStartCode(fileData, searchPos);
      if (!startCode) {
        break;
      }

      // Track the first start code at or after the overlap offset as fallback
      if (startCode.position >= overlapByteOffset && fallbackStartCodePos === -1) {
        fallbackStartCodePos = startCode.position;
      }

      // Check if this NAL unit is an I-frame
      const nalHeaderOffset = startCode.position + startCode.length;
      if (nalHeaderOffset < fileSize) {
        const nalHeaderByte = fileData[nalHeaderOffset];

        if (isIFrame(nalHeaderByte, codec) && startCode.position >= overlapByteOffset) {
          trimPoint = startCode.position;
          break;
        }
      }

      // Move past this start code to find the next one
      searchPos = startCode.position + startCode.length;
    }

    // If no I-frame found within the 2-second window, fall back
    if (trimPoint === -1) {
      if (fallbackStartCodePos !== -1) {
        // Fall back to nearest start code at or after overlap offset
        trimPoint = fallbackStartCodePos;
      } else {
        // No start code found at all after overlap offset - trim at byte boundary
        trimPoint = Math.min(overlapByteOffset, fileSize);
      }
    }

    // Write trimmed output
    const trimmedData = fileData.subarray(trimPoint);
    const ext = path.extname(segmentFile.filePath);
    const baseName = segmentFile.filePath.slice(0, -ext.length);
    const trimmedPath = `${baseName}_trimmed${ext}`;

    fs.writeFileSync(trimmedPath, trimmedData);

    results.push({
      index: i,
      trimmedPath,
      bytesRemoved: trimPoint,
    });
  }

  return results;
}
