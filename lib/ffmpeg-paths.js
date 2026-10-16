/**
 * FFmpeg/FFprobe Path Resolution
 *
 * Resolution order:
 *   1. System PATH (ffmpeg / ffprobe command available globally)
 *   2. Bundled ffmpeg-static / ffprobe-static npm packages (fallback)
 *   3. Bare command name as last resort (will fail at spawn time with clear error)
 *
 * This allows portable builds to skip bundling ffmpeg binaries
 * when the target system already has ffmpeg installed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Try to find a binary in the system PATH.
 * Returns the full path if found, null otherwise.
 */
function findInPath(binaryName) {
  try {
    if (process.platform === 'win32') {
      const result = execFileSync('where', [binaryName], { stdio: 'pipe', encoding: 'utf-8' }).trim();
      const firstLine = result.split(/\r?\n/)[0];
      if (firstLine && existsSync(firstLine)) return firstLine;
    } else {
      const result = execFileSync('which', [binaryName], { stdio: 'pipe', encoding: 'utf-8' }).trim();
      if (result && existsSync(result)) return result;
    }
  } catch {
    // Not found in PATH
  }
  return null;
}

/**
 * Try to resolve the bundled ffmpeg-static package path.
 */
function getBundledFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    if (p && existsSync(p)) return p;
  } catch {
    // Package not installed
  }
  return null;
}

/**
 * Try to resolve the bundled ffprobe-static package path.
 */
function getBundledFfprobe() {
  try {
    const mod = require('ffprobe-static');
    const p = mod.path || mod;
    if (p && existsSync(p)) return p;
  } catch {
    // Package not installed
  }
  return null;
}

// --- Resolve at module load ---

function resolveFfmpeg() {
  return findInPath('ffmpeg') || getBundledFfmpeg() || 'ffmpeg';
}

function resolveFfprobe() {
  return findInPath('ffprobe') || getBundledFfprobe() || 'ffprobe';
}

export const ffmpegPath = resolveFfmpeg();
export const ffprobePath = resolveFfprobe();

// Log which binaries we're using (helpful for debugging deployment issues)
// 两个子命令要静音：service 是纯 CLI，别在它的输出里插播这两行；
// mcp 的 stdout 被 JSON-RPC 协议独占，多一行就是解析错误（而且它压根不跑 ffmpeg）。
const QUIET_SUBCOMMANDS = new Set(['service', 'mcp']);
if (process.env.NODE_TEST !== '1' && !QUIET_SUBCOMMANDS.has(process.argv[2])) {
  const ffmpegSource = findInPath('ffmpeg') ? 'system' : getBundledFfmpeg() ? 'bundled' : 'fallback';
  const ffprobeSource = findInPath('ffprobe') ? 'system' : getBundledFfprobe() ? 'bundled' : 'fallback';
  console.log(`[ffmpeg]  ${ffmpegPath} (${ffmpegSource})`);
  console.log(`[ffprobe] ${ffprobePath} (${ffprobeSource})`);
}