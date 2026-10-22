import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getCacheFilePath } from '../lib/file-downloader.js';

describe('getCacheFilePath', () => {
  it('should generate correct path for typical recording file', () => {
    const result = getCacheFilePath('/tmp/downloads', {
      playbackURI: 'rtsp://192.0.2.200/Streaming/tracks/201/?size=929491916',
      startTime: '2026-05-07T17:58:17Z',
      endTime: '2026-05-07T18:13:47Z',
      size: 929491916,
      channel: '201',
    });

    const expected = path.join('/tmp/downloads', 'ch201_20260507T175817Z_20260507T181347Z.hikraw');
    assert.equal(result, expected);
  });

  it('should convert ISO time to compact format (remove dashes and colons)', () => {
    const result = getCacheFilePath('/output', {
      playbackURI: 'rtsp://ip/path?size=100',
      startTime: '2025-12-31T23:59:59Z',
      endTime: '2026-01-01T00:00:00Z',
      size: 100,
      channel: '101',
    });

    const expected = path.join('/output', 'ch101_20251231T235959Z_20260101T000000Z.hikraw');
    assert.equal(result, expected);
  });

  it('should handle single-digit channel numbers', () => {
    const result = getCacheFilePath('/downloads', {
      playbackURI: 'rtsp://ip/path?size=500',
      startTime: '2026-03-15T08:00:00Z',
      endTime: '2026-03-15T08:15:00Z',
      size: 500,
      channel: '1',
    });

    const expected = path.join('/downloads', 'ch1_20260315T080000Z_20260315T081500Z.hikraw');
    assert.equal(result, expected);
  });

  it('should handle three-digit channel numbers', () => {
    const result = getCacheFilePath('/data', {
      playbackURI: 'rtsp://ip/path?size=1000',
      startTime: '2026-06-01T12:30:45Z',
      endTime: '2026-06-01T12:45:30Z',
      size: 1000,
      channel: '301',
    });

    const expected = path.join('/data', 'ch301_20260601T123045Z_20260601T124530Z.hikraw');
    assert.equal(result, expected);
  });

  it('should use the outputDir as the directory prefix', () => {
    const result = getCacheFilePath('C:\\Users\\test\\downloads', {
      playbackURI: 'rtsp://ip/path?size=200',
      startTime: '2026-01-15T10:00:00Z',
      endTime: '2026-01-15T10:17:30Z',
      size: 200,
      channel: '201',
    });

    // path.join handles platform-specific separators
    assert.ok(result.startsWith('C:\\Users\\test\\downloads'));
    assert.ok(result.endsWith('.hikraw'));
    assert.ok(result.includes('ch201_'));
  });

  it('should always produce .hikraw extension', () => {
    const result = getCacheFilePath('/out', {
      playbackURI: 'rtsp://ip/path?size=999',
      startTime: '2026-08-20T00:00:00Z',
      endTime: '2026-08-20T00:18:00Z',
      size: 999,
      channel: '202',
    });

    assert.ok(result.endsWith('.hikraw'));
  });

  it('should produce unique filenames for different time ranges on same channel', () => {
    const file1 = getCacheFilePath('/out', {
      playbackURI: 'rtsp://ip/path?size=100',
      startTime: '2026-05-07T17:58:17Z',
      endTime: '2026-05-07T18:13:47Z',
      size: 100,
      channel: '201',
    });

    const file2 = getCacheFilePath('/out', {
      playbackURI: 'rtsp://ip/path?size=200',
      startTime: '2026-05-07T18:13:47Z',
      endTime: '2026-05-07T18:30:00Z',
      size: 200,
      channel: '201',
    });

    assert.notEqual(file1, file2);
  });

  it('should produce unique filenames for same time range on different channels', () => {
    const file1 = getCacheFilePath('/out', {
      playbackURI: 'rtsp://ip/path?size=100',
      startTime: '2026-05-07T17:58:17Z',
      endTime: '2026-05-07T18:13:47Z',
      size: 100,
      channel: '201',
    });

    const file2 = getCacheFilePath('/out', {
      playbackURI: 'rtsp://ip/path?size=100',
      startTime: '2026-05-07T17:58:17Z',
      endTime: '2026-05-07T18:13:47Z',
      size: 100,
      channel: '301',
    });

    assert.notEqual(file1, file2);
  });
});
