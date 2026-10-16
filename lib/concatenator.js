/**
 * Concatenator Module
 *
 * Performs binary concatenation of trimmed Annex B segment files in index order.
 * Validates all input files exist and have non-zero size before concatenation.
 * Deletes individual segment files after successful concatenation.
 */

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Validate that all trimmed files exist and have non-zero size.
 * @param {Array<{index: number, trimmedPath: string, bytesRemoved: number}>} trimmedFiles
 * @returns {{valid: boolean, missingIndices: number[]}}
 */
function validateFiles(trimmedFiles) {
  const missingIndices = [];

  for (const file of trimmedFiles) {
    try {
      const stat = fs.statSync(file.trimmedPath);
      if (stat.size === 0) {
        missingIndices.push(file.index);
      }
    } catch {
      missingIndices.push(file.index);
    }
  }

  return {
    valid: missingIndices.length === 0,
    missingIndices,
  };
}

/**
 * Concatenate trimmed Annex B segment files into a single output file.
 *
 * @param {Array<{index: number, trimmedPath: string, bytesRemoved: number}>} trimmedFiles - sorted by index
 * @param {string} outputPath - path for the concatenated output file
 * @returns {Promise<string>} - returns the output file path
 */
export async function concatenate(trimmedFiles, outputPath) {
  if (!trimmedFiles || trimmedFiles.length === 0) {
    throw new Error('No files to concatenate');
  }

  // Sort by index to ensure correct order
  const sorted = [...trimmedFiles].sort((a, b) => a.index - b.index);

  // Validate all files exist and have non-zero size
  const { valid, missingIndices } = validateFiles(sorted);
  if (!valid) {
    throw new Error(
      `Concatenation aborted: missing or empty segment files at indices [${missingIndices.join(', ')}]`
    );
  }

  // Perform binary concatenation using streaming reads/writes
  const writeStream = fs.createWriteStream(outputPath);

  try {
    for (const file of sorted) {
      const readStream = fs.createReadStream(file.trimmedPath);
      await pipeline(readStream, writeStream, { end: false });
    }
    writeStream.end();

    // Wait for the write stream to finish
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  } catch (err) {
    // Clean up partial output on failure
    writeStream.destroy();
    try {
      fs.unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  // Note: Individual segment file cleanup is handled by the pipeline orchestrator
  // to ensure all intermediate files (including untrimmed originals) are cleaned up.

  return outputPath;
}
