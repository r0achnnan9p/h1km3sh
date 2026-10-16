/**
 * Remuxer Module
 *
 * Converts concatenated Annex B stream to MP4 format using ffmpeg with forced
 * frame rate and faststart flag for progressive playback.
 */

import { spawnExportProcess as spawn } from './export-process-lock.js';
import fs from 'node:fs';
import { ffmpegPath } from './ffmpeg-paths.js';

/**
 * Remux an Annex B stream into MP4 format.
 *
 * @param {object} options
 * @param {string} options.inputPath - Path to the concatenated Annex B file
 * @param {string} options.outputPath - Path for the output MP4 file
 * @param {number} [options.frameRate=20] - Frame rate for input interpretation
 * @param {boolean} [options.faststart=true] - Whether to apply movflags +faststart
 * @param {function} [options.onProgress] - Progress callback: ({ phase, overallPercent, message }) => void
 * @returns {Promise<string>} Resolves with the output file path on success
 */
export async function remux(options) {
  const {
    inputPath,
    outputPath,
    frameRate = 20,
    faststart = true,
    onProgress,
  } = options;

  if (!inputPath) {
    throw new Error('inputPath is required');
  }
  if (!outputPath) {
    throw new Error('outputPath is required');
  }

  // Build ffmpeg arguments
  const args = [
    '-r', String(frameRate),
    '-i', inputPath,
    '-c', 'copy',
  ];

  if (faststart) {
    args.push('-movflags', '+faststart');
  }

  args.push('-y', outputPath);

  // Notify progress: starting remux
  if (onProgress) {
    onProgress({
      phase: 'remuxing',
      overallPercent: 93,
      message: `Remuxing to MP4: ${outputPath}`,
    });
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args);

    let stderrOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        // Delete the intermediate concatenated Annex B file
        try {
          fs.unlinkSync(inputPath);
        } catch (err) {
          // Ignore deletion errors (file may already be gone)
        }

        // Report completion
        if (onProgress) {
          onProgress({
            phase: 'remuxing',
            overallPercent: 100,
            message: `Remux complete: ${outputPath}`,
          });
        }

        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

