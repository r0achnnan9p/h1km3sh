import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { trimOverlaps } from '../lib/segment-trimmer.js';

// Helper: create a 4-byte Annex B start code
const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/**
 * Build a synthetic Annex B stream with NAL units at specified positions.
 * Each NAL unit has a start code followed by a header byte and payload.
 *
 * @param {Array<{type: number, codec: string, payloadSize: number}>} nalUnits
 * @returns {Buffer}
 */
function buildAnnexBStream(nalUnits, codec = 'h264') {
  const parts = [];
  for (const nal of nalUnits) {
    parts.push(START_CODE);
    let headerByte;
    if (codec === 'h264') {
      // H.264: nal_unit_type is in bits 0-4
      headerByte = nal.type & 0x1F;
    } else {
      // HEVC: nal_unit_type is in bits 1-6 of first byte
      headerByte = (nal.type & 0x3F) << 1;
    }
    parts.push(Buffer.from([headerByte]));
    // Add payload bytes
    parts.push(Buffer.alloc(nal.payloadSize || 100, 0xAB));
  }
  return Buffer.concat(parts);
}

describe('SegmentTrimmer - trimOverlaps', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimmer-test-'));
  });

  afterEach(() => {
    // Clean up temp files
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      fs.unlinkSync(path.join(tmpDir, file));
    }
    fs.rmdirSync(tmpDir);
  });

  it('should return first segment as-is without trimming', async () => {
    const stream = buildAnnexBStream([
      { type: 5, payloadSize: 200 },
      { type: 1, payloadSize: 100 },
    ]);
    const filePath = path.join(tmpDir, 'seg000.h264');
    fs.writeFileSync(filePath, stream);

    const segments = [{
      index: 0,
      startTime: '20231012T080000Z',
      endTime: '20231012T080200Z',
      originalStart: '20231012T080000Z',
      originalEnd: '20231012T080200Z',
      isFirst: true,
      isLast: false,
      overlapBefore: 0,
      overlapAfter: 3,
    }];

    const segmentFiles = [{
      index: 0,
      filePath,
      fileSize: stream.length,
      success: true,
      retries: 0,
    }];

    const results = await trimOverlaps(segments, segmentFiles, 'h264', 3);

    assert.equal(results.length, 1);
    assert.equal(results[0].index, 0);
    assert.equal(results[0].trimmedPath, filePath);
    assert.equal(results[0].bytesRemoved, 0);
  });

  it('should trim second segment at I-frame after overlap offset', async () => {
    // Build a stream where the I-frame is positioned just after the overlap region
    // but within the 2-second search window.
    // Strategy: use a short segment duration (10s) with 3s overlap.
    // overlapByteOffset = (3/10) * fileSize = 30% of file
    // 2s window = (2/10) * fileSize = 20% more
    // So I-frame needs to be between 30% and 50% of the file.

    // Each NAL = 4 (start code) + 1 (header) + 50 (payload) = 55 bytes
    // 100 NALs = 5500 bytes total
    // overlapByteOffset = (3/10) * 5500 = 1650 bytes = ~30 NALs
    // maxSearchOffset = 1650 + (2/10)*5500 = 1650 + 1100 = 2750 bytes = ~50 NALs
    // Place I-frame at NAL index 32 (byte ~1760), which is within the window

    const nalUnits = [];
    // First 32 NAL units are non-IDR (P-frames, type 1)
    for (let i = 0; i < 32; i++) {
      nalUnits.push({ type: 1, payloadSize: 50 });
    }
    // Then an IDR frame (type 5)
    nalUnits.push({ type: 5, payloadSize: 50 });
    // More P-frames after
    for (let i = 0; i < 67; i++) {
      nalUnits.push({ type: 1, payloadSize: 50 });
    }

    const stream = buildAnnexBStream(nalUnits);
    const filePath = path.join(tmpDir, 'seg001.h264');
    fs.writeFileSync(filePath, stream);

    // Use a 10-second segment so the byte offsets align with our NAL placement
    const segments = [
      {
        index: 0,
        startTime: '20231012T080000Z',
        endTime: '20231012T080013Z',
        originalStart: '20231012T080000Z',
        originalEnd: '20231012T080010Z',
        isFirst: true,
        isLast: false,
        overlapBefore: 0,
        overlapAfter: 3,
      },
      {
        index: 1,
        startTime: '20231012T080007Z',
        endTime: '20231012T080017Z',
        originalStart: '20231012T080010Z',
        originalEnd: '20231012T080017Z',
        isFirst: false,
        isLast: true,
        overlapBefore: 3,
        overlapAfter: 0,
      },
    ];

    const segmentFiles = [
      {
        index: 0,
        filePath: path.join(tmpDir, 'seg000.h264'),
        fileSize: 1000,
        success: true,
        retries: 0,
      },
      {
        index: 1,
        filePath,
        fileSize: stream.length,
        success: true,
        retries: 0,
      },
    ];

    // Write a dummy first segment file
    fs.writeFileSync(segmentFiles[0].filePath, Buffer.alloc(1000));

    const results = await trimOverlaps(segments, segmentFiles, 'h264', 3);

    assert.equal(results.length, 2);
    // First segment untouched
    assert.equal(results[0].bytesRemoved, 0);
    // Second segment should be trimmed
    assert.ok(results[1].bytesRemoved > 0);
    assert.ok(results[1].trimmedPath.includes('_trimmed'));

    // Verify trimmed file exists and starts with a start code
    const trimmedData = fs.readFileSync(results[1].trimmedPath);
    assert.ok(trimmedData.length > 0);
    // Should start with start code
    assert.equal(trimmedData[0], 0x00);
    assert.equal(trimmedData[1], 0x00);
    assert.equal(trimmedData[2], 0x00);
    assert.equal(trimmedData[3], 0x01);
    // Should be an IDR frame (type 5)
    const nalType = trimmedData[4] & 0x1F;
    assert.equal(nalType, 5);
  });

  it('should handle HEVC codec with IDR_W_RADL (type 19)', async () => {
    // Use 10s segment with 3s overlap so I-frame at NAL 32 is within search window
    const nalUnits = [];
    // Non-IDR NALs (type 1 = TRAIL_R in HEVC)
    for (let i = 0; i < 32; i++) {
      nalUnits.push({ type: 1, payloadSize: 50 });
    }
    // IDR_W_RADL (type 19)
    nalUnits.push({ type: 19, payloadSize: 50 });
    // More non-IDR
    for (let i = 0; i < 67; i++) {
      nalUnits.push({ type: 1, payloadSize: 50 });
    }

    const stream = buildAnnexBStream(nalUnits, 'hevc');
    const filePath = path.join(tmpDir, 'seg001.h264');
    fs.writeFileSync(filePath, stream);

    const segments = [
      {
        index: 0,
        startTime: '20231012T080000Z',
        endTime: '20231012T080013Z',
        isFirst: true,
        isLast: false,
        overlapBefore: 0,
        overlapAfter: 3,
      },
      {
        index: 1,
        startTime: '20231012T080007Z',
        endTime: '20231012T080017Z',
        isFirst: false,
        isLast: true,
        overlapBefore: 3,
        overlapAfter: 0,
      },
    ];

    const segmentFiles = [
      { index: 0, filePath: path.join(tmpDir, 'seg000.h264'), fileSize: 1000, success: true, retries: 0 },
      { index: 1, filePath, fileSize: stream.length, success: true, retries: 0 },
    ];

    fs.writeFileSync(segmentFiles[0].filePath, Buffer.alloc(1000));

    const results = await trimOverlaps(segments, segmentFiles, 'hevc', 3);

    assert.equal(results[1].bytesRemoved > 0, true);
    assert.ok(results[1].trimmedPath.includes('_trimmed'));

    // Verify the trimmed output starts with an HEVC IDR NAL
    const trimmedData = fs.readFileSync(results[1].trimmedPath);
    const nalHeaderByte = trimmedData[4]; // byte after 4-byte start code
    const nalType = (nalHeaderByte >> 1) & 0x3F;
    assert.equal(nalType, 19);
  });

  it('should handle HEVC codec with IDR_N_LP (type 20)', async () => {
    // Use 10s segment with 3s overlap
    const nalUnits = [];
    for (let i = 0; i < 32; i++) {
      nalUnits.push({ type: 1, payloadSize: 50 });
    }
    // IDR_N_LP (type 20)
    nalUnits.push({ type: 20, payloadSize: 50 });
    for (let i = 0; i < 67; i++) {
      nalUnits.push({ type: 1, payloadSize: 50 });
    }

    const stream = buildAnnexBStream(nalUnits, 'hevc');
    const filePath = path.join(tmpDir, 'seg001.h264');
    fs.writeFileSync(filePath, stream);

    const segments = [
      {
        index: 0,
        startTime: '20231012T080000Z',
        endTime: '20231012T080013Z',
        isFirst: true,
        isLast: false,
        overlapBefore: 0,
        overlapAfter: 3,
      },
      {
        index: 1,
        startTime: '20231012T080007Z',
        endTime: '20231012T080017Z',
        isFirst: false,
        isLast: true,
        overlapBefore: 3,
        overlapAfter: 0,
      },
    ];

    const segmentFiles = [
      { index: 0, filePath: path.join(tmpDir, 'seg000.h264'), fileSize: 1000, success: true, retries: 0 },
      { index: 1, filePath, fileSize: stream.length, success: true, retries: 0 },
    ];

    fs.writeFileSync(segmentFiles[0].filePath, Buffer.alloc(1000));

    const results = await trimOverlaps(segments, segmentFiles, 'hevc', 3);

    const trimmedData = fs.readFileSync(results[1].trimmedPath);
    const nalHeaderByte = trimmedData[4];
    const nalType = (nalHeaderByte >> 1) & 0x3F;
    assert.equal(nalType, 20);
  });

  it('should fall back to nearest start code when no I-frame within 2s window', async () => {
    // Build a stream with NO I-frames at all - only P-frames
    const nalUnits = [];
    for (let i = 0; i < 100; i++) {
      nalUnits.push({ type: 1, payloadSize: 50 });
    }

    const stream = buildAnnexBStream(nalUnits);
    const filePath = path.join(tmpDir, 'seg001.h264');
    fs.writeFileSync(filePath, stream);

    const segments = [
      {
        index: 0,
        startTime: '20231012T080000Z',
        endTime: '20231012T080203Z',
        isFirst: true,
        isLast: false,
        overlapBefore: 0,
        overlapAfter: 3,
      },
      {
        index: 1,
        startTime: '20231012T080157Z',
        endTime: '20231012T080403Z',
        isFirst: false,
        isLast: false,
        overlapBefore: 3,
        overlapAfter: 3,
      },
    ];

    const segmentFiles = [
      { index: 0, filePath: path.join(tmpDir, 'seg000.h264'), fileSize: 1000, success: true, retries: 0 },
      { index: 1, filePath, fileSize: stream.length, success: true, retries: 0 },
    ];

    fs.writeFileSync(segmentFiles[0].filePath, Buffer.alloc(1000));

    const results = await trimOverlaps(segments, segmentFiles, 'h264', 3);

    // Should still trim (fallback to nearest start code)
    assert.ok(results[1].bytesRemoved > 0);
    assert.ok(results[1].trimmedPath.includes('_trimmed'));

    // Verify trimmed output starts with a valid start code
    const trimmedData = fs.readFileSync(results[1].trimmedPath);
    assert.equal(trimmedData[0], 0x00);
    assert.equal(trimmedData[1], 0x00);
    assert.equal(trimmedData[2], 0x00);
    assert.equal(trimmedData[3], 0x01);
  });

  it('should handle empty segment file gracefully', async () => {
    const filePath = path.join(tmpDir, 'seg001.h264');
    fs.writeFileSync(filePath, Buffer.alloc(0));

    const segments = [
      {
        index: 0,
        startTime: '20231012T080000Z',
        endTime: '20231012T080203Z',
        isFirst: true,
        isLast: false,
        overlapBefore: 0,
        overlapAfter: 3,
      },
      {
        index: 1,
        startTime: '20231012T080157Z',
        endTime: '20231012T080403Z',
        isFirst: false,
        isLast: false,
        overlapBefore: 3,
        overlapAfter: 3,
      },
    ];

    const segmentFiles = [
      { index: 0, filePath: path.join(tmpDir, 'seg000.h264'), fileSize: 1000, success: true, retries: 0 },
      { index: 1, filePath, fileSize: 0, success: true, retries: 0 },
    ];

    fs.writeFileSync(segmentFiles[0].filePath, Buffer.alloc(1000));

    const results = await trimOverlaps(segments, segmentFiles, 'h264', 3);

    assert.equal(results[1].bytesRemoved, 0);
    assert.equal(results[1].trimmedPath, filePath);
  });

  it('should write trimmed file with _trimmed suffix preserving extension', async () => {
    const nalUnits = [
      { type: 1, payloadSize: 500 },
      { type: 5, payloadSize: 200 },
      { type: 1, payloadSize: 300 },
    ];

    const stream = buildAnnexBStream(nalUnits);
    const filePath = path.join(tmpDir, 'seg001.h264');
    fs.writeFileSync(filePath, stream);

    const segments = [
      {
        index: 0,
        startTime: '20231012T080000Z',
        endTime: '20231012T080203Z',
        isFirst: true,
        isLast: false,
        overlapBefore: 0,
        overlapAfter: 3,
      },
      {
        index: 1,
        startTime: '20231012T080157Z',
        endTime: '20231012T080403Z',
        isFirst: false,
        isLast: false,
        overlapBefore: 3,
        overlapAfter: 3,
      },
    ];

    const segmentFiles = [
      { index: 0, filePath: path.join(tmpDir, 'seg000.h264'), fileSize: 1000, success: true, retries: 0 },
      { index: 1, filePath, fileSize: stream.length, success: true, retries: 0 },
    ];

    fs.writeFileSync(segmentFiles[0].filePath, Buffer.alloc(1000));

    const results = await trimOverlaps(segments, segmentFiles, 'h264', 3);

    const expectedTrimmedPath = path.join(tmpDir, 'seg001_trimmed.h264');
    assert.equal(results[1].trimmedPath, expectedTrimmedPath);
    assert.ok(fs.existsSync(expectedTrimmedPath));
  });
});
