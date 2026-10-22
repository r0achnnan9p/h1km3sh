/** 安全清理 DVR 下载缓存：只删带 .done 的完整 .hikraw，绝不删断点续传分片。 */
import fs from 'node:fs';
import path from 'node:path';

const CAMERA_DIR = /^camera_[a-f0-9]{16}$/;

export function listDvrCache(downloadsDir) {
  const entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
  const directories = [downloadsDir, ...entries.filter(entry => entry.isDirectory() && CAMERA_DIR.test(entry.name)).map(entry => path.join(downloadsDir, entry.name))];
  const files = [];
  for (const directory of directories) {
    let names;
    try { names = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (!entry.isFile() || !entry.name.endsWith('.hikraw')) continue;
      const file = path.join(directory, entry.name);
      let stats;
      try { stats = fs.lstatSync(file); } catch { continue; }
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      const done = fs.existsSync(file + '.done');
      files.push({ filename: entry.name, relativePath: path.relative(downloadsDir, file), size: stats.size, complete: done });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function cleanCompletedDvrCache(downloadsDir, { busy = false } = {}) {
  if (busy) return { deletedCount: 0, deletedSize: 0, skippedBusy: true };
  let deletedCount = 0, deletedSize = 0;
  for (const cache of listDvrCache(downloadsDir)) {
    if (!cache.complete) continue;
    const file = path.resolve(downloadsDir, cache.relativePath);
    const base = path.resolve(downloadsDir);
    if (!file.startsWith(base + path.sep)) continue;
    try {
      const stats = fs.lstatSync(file);
      if (!stats.isFile() || stats.isSymbolicLink() || !fs.existsSync(file + '.done')) continue;
      fs.unlinkSync(file);
      fs.rmSync(file + '.done', { force: true });
      deletedCount++;
      deletedSize += stats.size;
    } catch { /* 并发删除或文件系统错误时保留其余缓存。 */ }
  }
  return { deletedCount, deletedSize, skippedBusy: false };
}
