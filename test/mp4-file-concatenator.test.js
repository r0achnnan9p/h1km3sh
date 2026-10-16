import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildConcatFileList } from '../lib/mp4-file-concatenator.js';
import { resolve } from 'node:path';

describe('MP4FileConcatenator - buildConcatFileList', () => {
  it('should sort entries by startTime ascending', () => {
    const trimResults = [
      { index: 2, filePath: '/tmp/file3.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:30:00Z' },
      { index: 0, filePath: '/tmp/file1_trimmed.mp4', isTemporary: true, trimmedStart: true, trimmedEnd: false, startTime: '2026-05-07T17:58:17Z' },
      { index: 1, filePath: '/tmp/file2.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:13:47Z' },
    ];

    const result = buildConcatFileList(trimResults);
    const lines = result.trim().split('\n');

    assert.equal(lines.length, 3);
    assert.ok(lines[0].includes('file1_trimmed.mp4'));
    assert.ok(lines[1].includes('file2.hikraw'));
    assert.ok(lines[2].includes('file3.hikraw'));
  });

  it('should use absolute paths in file entries', () => {
    const trimResults = [
      { index: 0, filePath: 'downloads/ch201_test.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T17:58:17Z' },
    ];

    const result = buildConcatFileList(trimResults);
    const lines = result.trim().split('\n');

    const expectedPath = resolve('downloads/ch201_test.hikraw');
    assert.equal(lines[0], `file '${expectedPath}'`);
  });

  it('should format each line as ffmpeg concat demuxer expects', () => {
    const trimResults = [
      { index: 0, filePath: '/path/to/file1.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T17:00:00Z' },
      { index: 1, filePath: '/path/to/file2_trimmed.mp4', isTemporary: true, trimmedStart: false, trimmedEnd: true, startTime: '2026-05-07T17:15:00Z' },
    ];

    const result = buildConcatFileList(trimResults);
    const lines = result.trim().split('\n');

    for (const line of lines) {
      // Each line should match: file '/absolute/path'
      assert.match(line, /^file '.*'$/);
    }
  });

  it('should handle single file input', () => {
    const trimResults = [
      { index: 0, filePath: '/tmp/single.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:00:00Z' },
    ];

    const result = buildConcatFileList(trimResults);
    const lines = result.trim().split('\n');

    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('single.hikraw'));
  });

  it('should end with a newline', () => {
    const trimResults = [
      { index: 0, filePath: '/tmp/file.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:00:00Z' },
    ];

    const result = buildConcatFileList(trimResults);
    assert.ok(result.endsWith('\n'));
  });

  it('should not mutate the original trimResults array', () => {
    const trimResults = [
      { index: 1, filePath: '/tmp/b.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:30:00Z' },
      { index: 0, filePath: '/tmp/a.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:00:00Z' },
    ];

    const originalFirst = trimResults[0];
    buildConcatFileList(trimResults);

    // Original array should not be modified
    assert.equal(trimResults[0], originalFirst);
    assert.equal(trimResults[0].index, 1);
  });

  it('should handle files with same startTime (stable order)', () => {
    const trimResults = [
      { index: 0, filePath: '/tmp/fileA.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:00:00Z' },
      { index: 1, filePath: '/tmp/fileB.hikraw', isTemporary: false, trimmedStart: false, trimmedEnd: false, startTime: '2026-05-07T18:00:00Z' },
    ];

    const result = buildConcatFileList(trimResults);
    const lines = result.trim().split('\n');

    assert.equal(lines.length, 2);
    // Both should be present (order among equal times is implementation-defined but stable)
    const allContent = lines.join('');
    assert.ok(allContent.includes('fileA.hikraw'));
    assert.ok(allContent.includes('fileB.hikraw'));
  });
});
