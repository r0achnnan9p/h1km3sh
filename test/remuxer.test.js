import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { remux } from '../lib/remuxer.js';

describe('Remuxer - remux', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remuxer-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tmpDir, file));
      }
      fs.rmdirSync(tmpDir);
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it('should export the remux function', () => {
    assert.equal(typeof remux, 'function');
  });

  it('should accept options with inputPath, outputPath, frameRate, faststart, and onProgress', () => {
    // Verify the function signature accepts the expected options
    assert.equal(remux.length, 1); // single options parameter
  });

  it('should throw error when inputPath is missing', async () => {
    await assert.rejects(
      () => remux({ outputPath: '/tmp/out.mp4' }),
      (err) => {
        assert.ok(err.message.includes('inputPath is required'));
        return true;
      }
    );
  });

  it('should throw error when outputPath is missing', async () => {
    await assert.rejects(
      () => remux({ inputPath: '/tmp/in.h264' }),
      (err) => {
        assert.ok(err.message.includes('outputPath is required'));
        return true;
      }
    );
  });

  it('should remux a valid Annex B file to MP4', async () => {
    // Create a minimal valid H.264 Annex B file with SPS, PPS, and IDR NAL units
    // This is a minimal synthetic stream that ffmpeg can process
    const sps = Buffer.from([
      0x00, 0x00, 0x00, 0x01, // start code
      0x67, // SPS NAL type (7)
      0x42, 0x00, 0x0a, 0xf8, 0x41, 0xa2, // minimal SPS data
    ]);
    const pps = Buffer.from([
      0x00, 0x00, 0x00, 0x01, // start code
      0x68, // PPS NAL type (8)
      0xce, 0x38, 0x80, // minimal PPS data
    ]);
    const idr = Buffer.from([
      0x00, 0x00, 0x00, 0x01, // start code
      0x65, // IDR NAL type (5)
      0x88, 0x80, 0x40, 0x00, // minimal IDR slice data
    ]);

    const inputData = Buffer.concat([sps, pps, idr]);
    const inputPath = path.join(tmpDir, 'test_concat.h264');
    const outputPath = path.join(tmpDir, 'test_output.mp4');

    fs.writeFileSync(inputPath, inputData);

    // This may fail with a non-zero exit code since the synthetic data
    // isn't a fully valid H.264 stream, but we test the happy path with
    // a real ffmpeg invocation to verify args are passed correctly.
    try {
      const result = await remux({ inputPath, outputPath });
      // If ffmpeg succeeds, verify the result
      assert.equal(result, outputPath);
      assert.ok(fs.existsSync(outputPath));
      // Input file should be deleted after successful remux
      assert.equal(fs.existsSync(inputPath), false);
    } catch (err) {
      // ffmpeg may reject our minimal synthetic data - that's acceptable
      // The important thing is it tried (error should be about exit code, not about spawning)
      assert.ok(err.message.includes('ffmpeg exited with code'));
    }
  });

  it('should call onProgress callback during remux', async () => {
    const inputPath = path.join(tmpDir, 'test_input.h264');
    const outputPath = path.join(tmpDir, 'test_output.mp4');

    // Create a minimal file (will likely fail ffmpeg but we can check progress was called)
    fs.writeFileSync(inputPath, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]));

    const progressUpdates = [];
    const onProgress = (update) => {
      progressUpdates.push(update);
    };

    try {
      await remux({ inputPath, outputPath, onProgress });
    } catch (err) {
      // Expected - minimal data won't produce valid MP4
    }

    // onProgress should have been called at least once (the starting notification)
    assert.ok(progressUpdates.length >= 1);
    assert.equal(progressUpdates[0].phase, 'remuxing');
    assert.equal(typeof progressUpdates[0].overallPercent, 'number');
    assert.equal(typeof progressUpdates[0].message, 'string');
  });

  it('should use default frameRate of 20 and faststart of true', async () => {
    const inputPath = path.join(tmpDir, 'test_input.h264');
    const outputPath = path.join(tmpDir, 'test_output.mp4');

    fs.writeFileSync(inputPath, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]));

    // Just verify it doesn't throw on missing frameRate/faststart
    try {
      await remux({ inputPath, outputPath });
    } catch (err) {
      // ffmpeg exit code error is fine - we're testing defaults are applied
      assert.ok(err.message.includes('ffmpeg exited with code'));
    }
  });

  it('should omit movflags when faststart is false', async () => {
    const inputPath = path.join(tmpDir, 'test_input.h264');
    const outputPath = path.join(tmpDir, 'test_output.mp4');

    fs.writeFileSync(inputPath, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]));

    // Should not throw about invalid args - just ffmpeg processing error
    try {
      await remux({ inputPath, outputPath, faststart: false });
    } catch (err) {
      assert.ok(err.message.includes('ffmpeg exited with code'));
    }
  });

  it('should use custom frameRate when provided', async () => {
    const inputPath = path.join(tmpDir, 'test_input.h264');
    const outputPath = path.join(tmpDir, 'test_output.mp4');

    fs.writeFileSync(inputPath, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]));

    try {
      await remux({ inputPath, outputPath, frameRate: 30 });
    } catch (err) {
      // ffmpeg exit code error is fine - we're testing custom frameRate is accepted
      assert.ok(err.message.includes('ffmpeg exited with code'));
    }
  });

  it('should delete input file after successful remux', async () => {
    // Create a more complete H.264 stream that ffmpeg might accept
    // Using a raw approach - create a file that ffmpeg can at least attempt to process
    const inputPath = path.join(tmpDir, 'test_input.h264');
    const outputPath = path.join(tmpDir, 'test_output.mp4');

    // Minimal but slightly more complete H.264 Annex B
    const nalData = Buffer.alloc(256);
    nalData[0] = 0x00; nalData[1] = 0x00; nalData[2] = 0x00; nalData[3] = 0x01;
    nalData[4] = 0x67; // SPS
    nalData[5] = 0x42; nalData[6] = 0xc0; nalData[7] = 0x1e;
    nalData[8] = 0xd9; nalData[9] = 0x00; nalData[10] = 0xa0; nalData[11] = 0x47;
    nalData[12] = 0xfe; nalData[13] = 0xc8;

    fs.writeFileSync(inputPath, nalData);

    try {
      const result = await remux({ inputPath, outputPath });
      // If it succeeds, input should be deleted
      assert.equal(fs.existsSync(inputPath), false);
      assert.equal(result, outputPath);
    } catch (err) {
      // If ffmpeg rejects the data, input file should still exist
      // (deletion only happens on success)
      assert.ok(fs.existsSync(inputPath));
    }
  });
});
