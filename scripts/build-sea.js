/**
 * Build Single Executable Application (SEA)
 *
 * 产出一个单文件可执行程序，里面塞了：
 *   - Node.js runtime
 *   - 打包后的应用代码（esbuild）
 *   - public/ 全部静态资源（base64 内联）
 *
 * 只依赖目标机器的 ffmpeg/ffprobe 在 PATH 里。
 *
 * 支持交叉编译：blob 本身与平台无关，注入的「壳」换成目标平台的官方 node 二进制即可，
 * 所以在 mac 上能直接产出 Linux amd64 / Windows x64 的单文件。
 *
 * 用法：
 *   node scripts/build-sea.js                      # 当前平台
 *   node scripts/build-sea.js --target=linux       # Linux x64（amd64）
 *   node scripts/build-sea.js --target=win         # Windows x64
 *   node scripts/build-sea.js --target=mac --arch=arm64
 *   node scripts/build-sea.js --target=linux --node-version=22.20.0
 *   NODE_MIRROR=https://npmmirror.com/mirrors/node node scripts/build-sea.js --target=linux
 *
 * 要求：Node.js >= 20
 */

import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchNodeBinary, DEFAULT_MIRROR } from './node-binary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DIST_DIR = path.join(ROOT, 'dist-sea');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const TARGETS = {
  win: { label: 'Windows', platform: 'win32', defaultArch: 'x64' },
  linux: { label: 'Linux', platform: 'linux', defaultArch: 'x64' },
  mac: { label: 'macOS', platform: 'darwin', defaultArch: process.arch === 'arm64' ? 'arm64' : 'x64' },
};

const HOST_TARGET = { win32: 'win', linux: 'linux', darwin: 'mac' }[process.platform];

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const [key, value = 'true'] = a.slice(2).split('=');
        return [key, value];
      })
  );

  const targetKey = ({ windows: 'win', ubuntu: 'linux', darwin: 'mac', macos: 'mac' })[args.target] || args.target || HOST_TARGET;
  const target = TARGETS[targetKey];
  if (!target) {
    console.error(`未知目标平台: ${args.target}。可选 --target=win|linux|mac`);
    process.exit(1);
  }

  const arch = args.arch || target.defaultArch;
  if (!['x64', 'arm64'].includes(arch)) {
    console.error(`未知架构: ${arch}。可选 --arch=x64|arm64`);
    process.exit(1);
  }

  const nodeVersion = args['node-version'] || process.versions.node;
  const cross = target.platform !== process.platform || arch !== process.arch;
  const suffix = targetKey === 'win' ? '.exe' : '';
  // Windows 产物沿用旧名字，CI 和已有文档都指着它
  const exeName = targetKey === 'win'
    ? 'hikvision-downloader.exe'
    : `hikvision-downloader-${targetKey === 'mac' ? 'macos' : 'linux'}-${arch}${suffix}`;

  return { targetKey, target, arch, nodeVersion, cross, exeName, mirror: args.mirror || DEFAULT_MIRROR };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Step 1: Generate embedded assets as a JS snippet ───────────────────────

function generateEmbeddedAssetsSnippet() {
  console.log('[1/5] Embedding public/ assets...');

  const publicDir = path.join(ROOT, 'public');
  const assets = {};

  function walkDir(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const urlPath = prefix + '/' + entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, urlPath);
      } else {
        const content = fs.readFileSync(fullPath);
        const ext = path.extname(entry.name).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        };
        assets[urlPath] = {
          content: content.toString('base64'),
          mime: mimeTypes[ext] || 'application/octet-stream',
        };
      }
    }
  }

  walkDir(publicDir);

  const assetCount = Object.keys(assets).length;
  console.log(`  ✓ ${assetCount} files embedded`);

  return `
// ══════ Embedded Static Assets ══════
const __EMBEDDED_ASSETS__ = ${JSON.stringify(assets)};

function __serveEmbeddedAssets__(req, res, next) {
  const asset = __EMBEDDED_ASSETS__[req.path];
  if (asset) {
    const buf = Buffer.from(asset.content, 'base64');
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buf);
  } else {
    next();
  }
}
// ══════ End Embedded Assets ══════
`;
}

// ─── Step 2: Bundle with esbuild and patch ──────────────────────────────────

function bundleAndPatch(assetsSnippet) {
  console.log('[2/5] Bundling application with esbuild...');

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

  let code = fs.readFileSync(outBundle, 'utf-8');

  // Patch 1: fix import.meta.url for CJS
  code = code.replace(
    /var (import_meta\d*) = \{\};/g,
    'var $1 = { url: require("url").pathToFileURL(__filename).href };'
  );

  // Patch 2: replace express.static(...) with our embedded middleware
  // esbuild produces: app.use(import_express.default.static(import_path2.default.join(__dirname, "public")));
  code = code.replace(
    /app\.use\(.*?\.static\(.*?"public"\)\)\)/,
    'app.use(__serveEmbeddedAssets__)'
  );

  // Patch 3: __dirname is virtual inside a single executable, so the default
  // downloads dir must be relative to the exe location. Only rewrite the
  // __dirname-based join; the HIKVISION_DOWNLOADS_DIR override from the source
  // must stay intact.
  code = code.replace(
    /join\(__dirname\d*, "downloads"\)/,
    'join(require("path").dirname(process.execPath), "downloads")'
  );

  const finalCode = assetsSnippet + '\n' + code;

  const seaEntryPath = path.join(DIST_DIR, 'sea-entry.js');
  fs.writeFileSync(seaEntryPath, finalCode);

  // CJS package.json so Node doesn't try ESM
  fs.writeFileSync(
    path.join(DIST_DIR, 'package.json'),
    JSON.stringify({ name: 'hikvision-downloader-sea', type: 'commonjs' }, null, 2)
  );

  const size = (fs.statSync(seaEntryPath).size / 1024 / 1024).toFixed(2);
  console.log(`  ✓ Combined entry file: ${size} MB`);

  try { fs.unlinkSync(outBundle); } catch (_) {}
}

// ─── Step 3: Generate SEA blob ──────────────────────────────────────────────

function generateSeaBlob({ cross }) {
  console.log('[3/5] Generating SEA blob...');

  // 代码缓存是按平台/架构编译的，交叉编译必须关掉，否则目标机器上直接崩
  const seaConfig = {
    main: './sea-entry.js',
    output: './sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: !cross,
  };

  const configPath = path.join(DIST_DIR, 'sea-config.json');
  fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

  execSync(`"${process.execPath}" --experimental-sea-config sea-config.json`, {
    cwd: DIST_DIR,
    stdio: 'inherit',
  });

  const blobPath = path.join(DIST_DIR, 'sea-prep.blob');
  if (!fs.existsSync(blobPath)) {
    throw new Error('SEA blob generation failed — sea-prep.blob not found');
  }

  const blobSize = (fs.statSync(blobPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ SEA blob generated (${blobSize} MB${seaConfig.useCodeCache ? '' : '，交叉编译已关闭 code cache'})`);
}

// ─── Step 4: Prepare the base node binary ───────────────────────────────────

async function prepareBaseBinary(config) {
  console.log(`[4/5] Preparing base node binary (${config.target.label} ${config.arch}, node v${config.nodeVersion})...`);

  const exePath = path.join(DIST_DIR, config.exeName);

  if (!config.cross && config.nodeVersion === process.versions.node) {
    fs.copyFileSync(process.execPath, exePath);
    console.log(`  ✓ 用当前 node: ${process.execPath}`);
  } else {
    const cached = await fetchNodeBinary({
      version: config.nodeVersion,
      platform: config.target.platform,
      arch: config.arch,
      mirror: config.mirror,
    });
    fs.copyFileSync(cached, exePath);
  }
  fs.chmodSync(exePath, 0o755);

  // 注入前先卸掉签名：Windows 是 Authenticode，macOS 是 Mach-O 代码签名
  if (config.target.platform === 'win32' && process.platform === 'win32') {
    try {
      execSync(`signtool remove /s "${exePath}"`, { stdio: 'pipe' });
      console.log('  ✓ 已移除原有 Authenticode 签名');
    } catch (_) { /* 没装 signtool 或本来就没签名 */ }
  }
  if (config.target.platform === 'darwin' && process.platform === 'darwin') {
    try {
      execFileSync('codesign', ['--remove-signature', exePath], { stdio: 'pipe' });
      console.log('  ✓ 已移除原有代码签名');
    } catch (_) { /* 没签名 */ }
  }

  return exePath;
}

// ─── Step 5: Inject blob ────────────────────────────────────────────────────

function injectBlob(config, exePath) {
  console.log('[5/5] Injecting SEA blob...');

  const blobPath = path.join(DIST_DIR, 'sea-prep.blob');
  const extra = config.target.platform === 'darwin' ? ' --macho-segment-name NODE_SEA' : '';

  execSync(
    `npx --yes postject "${exePath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${SENTINEL_FUSE}${extra}`,
    { cwd: DIST_DIR, stdio: 'inherit' }
  );

  if (config.target.platform === 'darwin') {
    if (process.platform === 'darwin') {
      execFileSync('codesign', ['--sign', '-', '--force', exePath], { stdio: 'pipe' });
      console.log('  ✓ 已重新做 ad-hoc 签名');
    } else {
      console.log('  ⚠️  非 macOS 主机无法签名，产物在较新的 macOS 上会被拒绝运行');
    }
  }
  if (config.target.platform === 'win32' && process.platform !== 'win32') {
    console.log('  ⚠️  跨平台构建的 exe 没有有效签名，Windows 首次运行可能弹 SmartScreen（点“更多信息 → 仍要运行”）');
  }

  fs.chmodSync(exePath, 0o755);
  const exeSize = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${config.exeName} ready (${exeSize} MB)`);
}

// ─── Cleanup & Summary ──────────────────────────────────────────────────────

function cleanup() {
  const toDelete = ['sea-entry.js', 'sea-prep.blob', 'sea-config.json', 'package.json'];
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(DIST_DIR, f)); } catch (_) {}
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  console.log(`\n=== Building Single Executable: ${config.exeName} ===`);
  console.log(`目标: ${config.target.label} ${config.arch} · node v${config.nodeVersion}${config.cross ? ' · 交叉编译' : ''}\n`);

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    console.error('ERROR: Node.js >= 20 is required for SEA support.');
    console.error(`Current version: ${process.version}`);
    process.exit(1);
  }

  ensureDir(DIST_DIR);

  const assetsSnippet = generateEmbeddedAssetsSnippet();
  bundleAndPatch(assetsSnippet);
  generateSeaBlob(config);
  const exePath = await prepareBaseBinary(config);
  injectBlob(config, exePath);
  cleanup();

  console.log(`\n=== Build complete! ===`);
  console.log(`\nOutput: dist-sea/${config.exeName}`);
  console.log(`\n用法:`);
  console.log(`  前台运行:  ./${config.exeName}        （Windows 双击即可）`);
  console.log(`  后台服务:  ./${config.exeName} service install`);
  console.log(`  查看状态:  ./${config.exeName} service status`);
  console.log(`\n说明:`);
  console.log(`  • 默认端口 30001，被占用时自动顺延`);
  console.log(`  • data/ 与 downloads/ 会在 exe 同级目录自动创建`);
  console.log(`  • 目标机器需要自备 ffmpeg/ffprobe 并加入 PATH`);
}

main().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});
