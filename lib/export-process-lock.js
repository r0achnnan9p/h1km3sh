/** Kernel-backed queue ownership; inherited by every export child until it exits. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
let descriptor = null;

export function acquireKernelExportLease(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(root, '.export.lock'), 'a+', 0o600);
  // flock(1) locks this inherited open-file description. The parent keeps the
  // same description open after flock exits; close does not explicitly unlock.
  const attempt = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], windowsHide: true });
  if (attempt.error || attempt.status !== 0) {
    fs.closeSync(fd);
    if (attempt.error?.code === 'ENOENT') {
      const error = new Error('系统缺少 flock，无法安全自动恢复导出；Linux 请安装 util-linux/flock。'); error.code = 'LOCK_UNAVAILABLE'; throw error;
    }
    const error = new Error('其他服务或尚未退出的媒体进程仍持有导出队列；等待退出后自动恢复。'); error.code = 'LOCK_BUSY'; throw error;
  }
  descriptor = fd;
  const release = () => {
    if (descriptor === fd) descriptor = null;
    try { fs.closeSync(fd); } catch {}
  };
  process.once('exit', release);
  return () => { process.removeListener('exit', release); release(); };
}

export function spawnExportProcess(binary, args, options = {}) {
  if (descriptor === null) return spawn(binary, args, options);
  const configured = options.stdio ?? ['pipe', 'pipe', 'pipe'];
  const stdio = Array.isArray(configured) ? [...configured] : [configured, configured, configured];
  // Reserve one additional descriptor without changing the child's standard I/O.
  stdio.push(descriptor);
  return spawn(binary, args, { ...options, stdio });
}
