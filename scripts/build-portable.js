/**
 * Build Portable Distribution
 *
 * Creates a self-contained directory with:
 *   - Node.js runtime binary (downloaded from nodejs.org)
 *   - Bundled app (single JS file via esbuild)
 *   - public/ directory
 *   - Launcher script (start.bat for Windows, start.sh for Linux)
 *
 * ffmpeg/ffprobe are NOT bundled — the app uses system-installed ffmpeg from PATH.
 *
 * Usage:
 *   node scripts/build-portable.js                  # builds for current platform
 *   node scripts/build-portable.js --target=win     # Windows x64
 *   node scripts/build-portable.js --target=linux   # Linux x64 (Ubuntu etc.)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchNodeBinary } from './node-binary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const APP_NAME = 'hikvision-downloader';
const NODE_VERSION = '20.18.1'; // LTS

// ─── Platform Configuration ─────────────────────────────────────────────────

const PLATFORMS = {
  win: {
    label: 'Windows x64',
    nodePlatform: 'win32',
    nodeFilename: 'node.exe',
    launcher: 'start.bat',
  },
  linux: {
    label: 'Linux x64',
    nodePlatform: 'linux',
    nodeFilename: 'node',
    launcher: 'start.sh',
  },
};

// ─── Parse Arguments ────────────────────────────────────────────────────────

function parseTarget() {
  const arg = process.argv.find(a => a.startsWith('--target='));
  if (arg) {
    const val = arg.split('=')[1].toLowerCase();
    if (val === 'win' || val === 'windows') return 'win';
    if (val === 'linux' || val === 'ubuntu') return 'linux';
    console.error(`Unknown target: ${val}. Use --target=win or --target=linux`);
    process.exit(1);
  }
  // Default to current platform
  return process.platform === 'win32' ? 'win' : 'linux';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyDirSync(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Main Build ─────────────────────────────────────────────────────────────

async function build() {
  const target = parseTarget();
  const platform = PLATFORMS[target];
  const DIST_DIR = path.join(ROOT, `dist-${target}`);

  console.log(`\n=== Building portable ${APP_NAME} for ${platform.label} ===\n`);

  // Clean dist（node 二进制由 .node-cache 缓存，不用担心重复下载）
  const nodeExeDest = path.join(DIST_DIR, platform.nodeFilename);

  if (fs.existsSync(DIST_DIR)) {
    try {
      fs.rmSync(DIST_DIR, { recursive: true });
    } catch (err) {
      console.error(`\n  ✗ Cannot delete ${DIST_DIR} — it's locked by another process.`);
      console.error(`    Close any programs using that folder, then try again.`);
      console.error(`    Or manually delete it: Remove-Item -Recurse -Force "${DIST_DIR}"\n`);
      process.exit(1);
    }
  }
  ensureDir(DIST_DIR);

  // Step 1: Bundle JS with esbuild
  console.log('[1/4] Bundling application with esbuild...');

  const outBundle = path.join(DIST_DIR, 'server.bundle.js').replace(/\\/g, '/');
  execSync(
    [
      'npx esbuild server.js',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${outBundle}`,
      '--log-level=error',
    ].join(' '),
    { cwd: ROOT, stdio: 'inherit' }
  );

  // Post-build patch: fix import.meta.url for CJS
  // esbuild creates empty `var import_meta = {}` (and import_meta2, etc.) for each ESM file
  // We replace ALL occurrences with a proper URL derived from __filename
  let bundleContent = fs.readFileSync(path.join(DIST_DIR, 'server.bundle.js'), 'utf-8');
  bundleContent = bundleContent.replace(
    /var (import_meta\d*) = \{\};/g,
    'var $1 = { url: require("url").pathToFileURL(__filename).href };'
  );
  fs.writeFileSync(path.join(DIST_DIR, 'server.bundle.js'), bundleContent);

  // Create app.js entry point
  // Also create a package.json to ensure CJS mode (parent project may have "type": "module")
  fs.writeFileSync(path.join(DIST_DIR, 'package.json'), JSON.stringify({ name: APP_NAME, type: 'commonjs' }, null, 2));
  fs.writeFileSync(path.join(DIST_DIR, 'app.js'), `#!/usr/bin/env node
// Portable entry point
require('./server.bundle.js');
`);

  const bundleSize = (fs.statSync(path.join(DIST_DIR, 'server.bundle.js')).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ Bundle created (${bundleSize} MB)`);

  // Step 2: Copy public directory
  console.log('[2/4] Copying public assets...');
  copyDirSync(path.join(ROOT, 'public'), path.join(DIST_DIR, 'public'));
  console.log('  ✓ public/ copied');

  // Step 3: Node.js runtime（任意主机都能取任意目标平台的二进制）
  console.log('[3/4] Preparing Node.js runtime...');

  const cachedNode = await fetchNodeBinary({
    version: NODE_VERSION,
    platform: platform.nodePlatform,
    arch: 'x64',
  });
  fs.copyFileSync(cachedNode, nodeExeDest);
  fs.chmodSync(nodeExeDest, 0o755);
  console.log(`  ✓ ${platform.nodeFilename} ready`);

  // Step 4: Create launcher script
  console.log('[4/4] Creating launcher script...');

  if (target === 'win') {
    const batContent = [
      '@echo off',
      'chcp 65001 >nul',
      'title H1kM3sh',
      'echo ========================================',
      'echo   H1kM3sh',
      'echo   http://localhost:30001',
      'echo ========================================',
      'echo.',
      '',
      'REM Check ffmpeg availability',
      'where ffmpeg >nul 2>nul',
      'if %errorlevel% neq 0 (',
      '  echo [ERROR] ffmpeg not found in PATH!',
      '  echo Please install ffmpeg and add it to system PATH.',
      '  echo Download: https://www.gyan.dev/ffmpeg/builds/',
      '  echo.',
      '  pause',
      '  exit /b 1',
      ')',
      '',
      'echo Starting server... Press Ctrl+C to stop.',
      'echo.',
      '"%~dp0node.exe" "%~dp0app.js"',
      'pause',
      '',
    ].join('\r\n');
    fs.writeFileSync(path.join(DIST_DIR, 'start.bat'), batContent);
  } else {
    const shContent = [
      '#!/bin/bash',
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'echo "========================================"',
      'echo "  H1kM3sh"',
      'echo "  http://localhost:30001"',
      'echo "========================================"',
      'echo ""',
      '',
      '# Check ffmpeg availability',
      'if ! command -v ffmpeg &> /dev/null; then',
      '  echo "[ERROR] ffmpeg not found in PATH!"',
      '  echo "Please install: sudo apt install ffmpeg"',
      '  exit 1',
      'fi',
      '',
      'echo "Starting server... Press Ctrl+C to stop."',
      'echo ""',
      'exec "$DIR/node" "$DIR/app.js"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(DIST_DIR, 'start.sh'), shContent, { mode: 0o755 });
  }

  // Create downloads directory
  ensureDir(path.join(DIST_DIR, 'downloads'));
  fs.writeFileSync(path.join(DIST_DIR, 'downloads', '.gitkeep'), '');

  // Summary
  console.log(`\n=== Build complete! ===`);
  console.log(`Output: ${DIST_DIR}/`);
  console.log(`\nDirectory structure:`);
  console.log(`  dist-${target}/`);
  console.log(`  ├── ${platform.nodeFilename.padEnd(22)} (Node.js ${NODE_VERSION} runtime)`);
  console.log(`  ├── app.js                 (entry point)`);
  console.log(`  ├── server.bundle.js       (bundled application)`);
  console.log(`  ├── ${platform.launcher.padEnd(22)} (launcher script)`);
  console.log(`  ├── public/`);
  console.log(`  │   ├── index.html`);
  console.log(`  │   ├── app.js`);
  console.log(`  │   └── style.css`);
  console.log(`  └── downloads/`);
  console.log(`\n⚠️  Requires ffmpeg installed on the target system and available in PATH.`);
  console.log(`\nTo distribute: zip/tar the entire dist-${target}/ folder.`);
  if (target === 'win') {
    console.log(`To run: double-click start.bat`);
    console.log(`As a background service (auto-start at logon): node.exe app.js service install`);
  } else {
    console.log(`To run: chmod +x start.sh && ./start.sh`);
    console.log(`As a background service (auto-start at logon): ./node app.js service install`);
  }
}

build().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});

