/**
 * 取一份官方 Node.js 二进制（下载 → 解包 → 本地缓存），支持任意平台/架构组合。
 *
 * 便携包构建和 SEA 交叉编译共用这里：只要能下到目标平台的 node，就能在 mac 上产出
 * Linux/Windows 的可执行文件。国内网络可用 NODE_MIRROR 或 --mirror 换源，例如：
 *   NODE_MIRROR=https://nodejs.org/dist npm run build:sea:linux
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_MIRROR = process.env.NODE_MIRROR || 'https://nodejs.org/dist';
export const CACHE_ROOT = path.join(ROOT, '.node-cache');

export function nodeArtifact({ version, platform, arch, mirror = DEFAULT_MIRROR }) {
  const base = `${mirror.replace(/\/+$/, '')}/v${version}`;
  if (platform === 'win32') {
    return { url: `${base}/win-${arch}/node.exe`, archive: false, binaryName: 'node.exe' };
  }
  const dirName = `node-v${version}-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`;
  return {
    url: `${base}/${dirName}.tar.gz`,
    archive: true,
    archiveMember: `${dirName}/bin/node`,
    binaryName: 'node',
  };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (target, redirects = 0) => {
      https.get(target, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode)) {
          if (redirects > 5) return reject(new Error(`重定向过多: ${target}`));
          response.resume();
          return request(response.headers.location, redirects + 1);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${response.statusCode} — ${target}`));
        }
        const total = Number(response.headers['content-length']) || 0;
        let received = 0;
        let lastShown = -1;
        response.on('data', (chunk) => {
          received += chunk.length;
          const pct = total ? Math.round((received / total) * 100) : Math.floor(received / 1024 / 1024);
          if (pct === lastShown) return; // 别把整根进度条刷进构建日志
          lastShown = pct;
          process.stdout.write(`\r  下载中 ${total ? `${pct}%` : ''} (${(received / 1024 / 1024).toFixed(1)} MB)   `);
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      }).on('error', (err) => {
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
    };
    request(url);
  });
}

/**
 * 返回缓存里的 node 可执行文件路径，没有就下载。
 */
export async function fetchNodeBinary({ version, platform, arch, mirror = DEFAULT_MIRROR, cacheRoot = CACHE_ROOT }) {
  const artifact = nodeArtifact({ version, platform, arch, mirror });
  const cacheDir = path.join(cacheRoot, `v${version}`, `${platform}-${arch}`);
  const binaryPath = path.join(cacheDir, artifact.binaryName);

  if (fs.existsSync(binaryPath)) {
    console.log(`  ✓ 复用缓存: ${path.relative(ROOT, binaryPath)}`);
    return binaryPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`  ${artifact.url}`);

  if (!artifact.archive) {
    await download(artifact.url, binaryPath);
  } else {
    const tarPath = path.join(cacheDir, 'node.tar.gz');
    await download(artifact.url, tarPath);
    execFileSync('tar', ['-xzf', tarPath, '--strip-components=2', '-C', cacheDir, artifact.archiveMember], {
      stdio: 'pipe',
    });
    fs.unlinkSync(tarPath);
  }

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`node 二进制没拿到: ${binaryPath}`);
  }
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}
