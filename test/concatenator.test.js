import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { concatenate } from '../lib/concatenator.js';

describe('Concatenator - concatenate', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      fs.unlinkSync(path.join(tmpDir, file));
    }
    fs.rmdirSync(tmpDir);
  });

  it('should concatenate multiple files in correct index order', async () => {
    // Create segment files with distinct content
    const seg0 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xAA, 0xBB]);
    const seg1 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xCC, 0xDD]);
    const seg2 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xEE, 0xFF]);

    const file0 = path.join(tmpDir, 'seg000.h264');
    const file1 = path.join(tmpDir, 'seg001_trimmed.h264');
    const file2 = path.join(tmpDir, 'seg002_trimmed.h264');

    fs.writeFileSync(file0, seg0);
    fs.writeFileSync(file1, seg1);
    fs.writeFileSync(file2, seg2);

    const trimmedFiles = [
      { index: 0, trimmedPath: file0, bytesRemoved: 0 },
      { index: 1, trimmedPath: file1, bytesRemoved: 50 },
      { index: 2, trimmedPath: file2, bytesRemoved: 50 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');
    const result = await concatenate(trimmedFiles, outputPath);

    assert.equal(result, outputPath);
    assert.ok(fs.existsSync(outputPath));

    const output = fs.readFileSync(outputPath);
    const expected = Buffer.concat([seg0, seg1, seg2]);
    assert.deepEqual(output, expected);
  });

  it('should concatenate files in index order even if input is unordered', async () => {
    const seg0 = Buffer.from([0x01, 0x02, 0x03]);
    const seg1 = Buffer.from([0x04, 0x05, 0x06]);
    const seg2 = Buffer.from([0x07, 0x08, 0x09]);

    const file0 = path.join(tmpDir, 'seg000.h264');
    const file1 = path.join(tmpDir, 'seg001.h264');
    const file2 = path.join(tmpDir, 'seg002.h264');

    fs.writeFileSync(file0, seg0);
    fs.writeFileSync(file1, seg1);
    fs.writeFileSync(file2, seg2);

    // Provide files in reverse order
    const trimmedFiles = [
      { index: 2, trimmedPath: file2, bytesRemoved: 0 },
      { index: 0, trimmedPath: file0, bytesRemoved: 0 },
      { index: 1, trimmedPath: file1, bytesRemoved: 0 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');
    await concatenate(trimmedFiles, outputPath);

    const output = fs.readFileSync(outputPath);
    const expected = Buffer.concat([seg0, seg1, seg2]);
    assert.deepEqual(output, expected);
  });

  it('should throw error with missing file indices when files do not exist', async () => {
    const seg0 = Buffer.from([0x01, 0x02, 0x03]);
    const file0 = path.join(tmpDir, 'seg000.h264');
    fs.writeFileSync(file0, seg0);

    const trimmedFiles = [
      { index: 0, trimmedPath: file0, bytesRemoved: 0 },
      { index: 1, trimmedPath: path.join(tmpDir, 'nonexistent1.h264'), bytesRemoved: 0 },
      { index: 3, trimmedPath: path.join(tmpDir, 'nonexistent3.h264'), bytesRemoved: 0 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');

    await assert.rejects(
      () => concatenate(trimmedFiles, outputPath),
      (err) => {
        assert.ok(err.message.includes('1'));
        assert.ok(err.message.includes('3'));
        assert.ok(err.message.includes('missing or empty'));
        return true;
      }
    );
  });

  it('should throw error with indices when files have zero bytes', async () => {
    const seg0 = Buffer.from([0x01, 0x02, 0x03]);
    const file0 = path.join(tmpDir, 'seg000.h264');
    const file1 = path.join(tmpDir, 'seg001.h264');
    const file2 = path.join(tmpDir, 'seg002.h264');

    fs.writeFileSync(file0, seg0);
    fs.writeFileSync(file1, Buffer.alloc(0)); // zero-byte file
    fs.writeFileSync(file2, Buffer.alloc(0)); // zero-byte file

    const trimmedFiles = [
      { index: 0, trimmedPath: file0, bytesRemoved: 0 },
      { index: 1, trimmedPath: file1, bytesRemoved: 0 },
      { index: 2, trimmedPath: file2, bytesRemoved: 0 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');

    await assert.rejects(
      () => concatenate(trimmedFiles, outputPath),
      (err) => {
        assert.ok(err.message.includes('1'));
        assert.ok(err.message.includes('2'));
        assert.ok(err.message.includes('missing or empty'));
        return true;
      }
    );
  });

  it('should not delete segment files (cleanup is handled by pipeline orchestrator)', async () => {
    const seg0 = Buffer.from([0xAA, 0xBB]);
    const seg1 = Buffer.from([0xCC, 0xDD]);

    const file0 = path.join(tmpDir, 'seg000.h264');
    const file1 = path.join(tmpDir, 'seg001_trimmed.h264');

    fs.writeFileSync(file0, seg0);
    fs.writeFileSync(file1, seg1);

    const trimmedFiles = [
      { index: 0, trimmedPath: file0, bytesRemoved: 0 },
      { index: 1, trimmedPath: file1, bytesRemoved: 50 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');
    await concatenate(trimmedFiles, outputPath);

    // Segment files should still exist (cleanup is pipeline orchestrator's responsibility)
    assert.equal(fs.existsSync(file0), true);
    assert.equal(fs.existsSync(file1), true);
    // Output file should exist
    assert.ok(fs.existsSync(outputPath));
  });

  it('should handle single file concatenation (just copies it)', async () => {
    const seg0 = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0xAA, 0xBB, 0xCC]);
    const file0 = path.join(tmpDir, 'seg000.h264');
    fs.writeFileSync(file0, seg0);

    const trimmedFiles = [
      { index: 0, trimmedPath: file0, bytesRemoved: 0 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');
    const result = await concatenate(trimmedFiles, outputPath);

    assert.equal(result, outputPath);
    const output = fs.readFileSync(outputPath);
    assert.deepEqual(output, seg0);
    // Original file should still exist (cleanup is pipeline orchestrator's responsibility)
    assert.equal(fs.existsSync(file0), true);
  });

  it('should throw error when trimmedFiles array is empty', async () => {
    const outputPath = path.join(tmpDir, 'output_concat.h264');

    await assert.rejects(
      () => concatenate([], outputPath),
      (err) => {
        assert.ok(err.message.includes('No files to concatenate'));
        return true;
      }
    );
  });

  it('should not create output file when validation fails', async () => {
    const trimmedFiles = [
      { index: 0, trimmedPath: path.join(tmpDir, 'nonexistent.h264'), bytesRemoved: 0 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');

    await assert.rejects(() => concatenate(trimmedFiles, outputPath));
    assert.equal(fs.existsSync(outputPath), false);
  });

  it('should handle large binary data correctly', async () => {
    // Create larger segment files (64KB each)
    const seg0 = Buffer.alloc(65536, 0xAA);
    const seg1 = Buffer.alloc(65536, 0xBB);
    const seg2 = Buffer.alloc(65536, 0xCC);

    const file0 = path.join(tmpDir, 'seg000.h264');
    const file1 = path.join(tmpDir, 'seg001.h264');
    const file2 = path.join(tmpDir, 'seg002.h264');

    fs.writeFileSync(file0, seg0);
    fs.writeFileSync(file1, seg1);
    fs.writeFileSync(file2, seg2);

    const trimmedFiles = [
      { index: 0, trimmedPath: file0, bytesRemoved: 0 },
      { index: 1, trimmedPath: file1, bytesRemoved: 100 },
      { index: 2, trimmedPath: file2, bytesRemoved: 100 },
    ];

    const outputPath = path.join(tmpDir, 'output_concat.h264');
    await concatenate(trimmedFiles, outputPath);

    const output = fs.readFileSync(outputPath);
    assert.equal(output.length, 65536 * 3);
    // Verify content integrity
    assert.deepEqual(output.subarray(0, 65536), seg0);
    assert.deepEqual(output.subarray(65536, 131072), seg1);
    assert.deepEqual(output.subarray(131072, 196608), seg2);
  });
});
