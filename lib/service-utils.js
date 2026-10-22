/**
 * 后台服务管理的公共部件：进程调用、服务上下文（启动命令 / 日志 / 运行时文件）、日志读取。
 *
 * 三个平台后端（service-launchd.js / service-systemd.js / service-windows.js）
 * 和 CLI（service-manager.js）都从这里取，避免互相 import 形成环。
 */

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as sea from 'node:sea';
import { resolveDataDir } from './data-dir.js';

const execFileAsync = promisify(execFile);

/**
 * 跑一条外部命令，永远不抛异常——调用方看 ok/code 自己决定怎么处理。
 */
export async function exec(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}

/**
 * 服务要执行的启动命令。三种运行形态：
 *   - SEA 单文件:  直接跑 exe 自身
 *   - 便携包/源码: 当前 node + 入口脚本（app.js / server.js）
 */
export function resolveRunCommand(entry) {
  let isSea = false;
  try { isSea = sea.isSea(); } catch { /* node:sea 不可用 */ }
  if (isSea) {
    return {
      command: process.execPath,
      args: [],
      cwd: path.dirname(process.execPath),
    };
  }
  const script = path.resolve(entry || process.argv[1]);
  return {
    command: process.execPath,
    args: [script],
    cwd: path.dirname(script),
  };
}

/**
 * 服务上下文：启动命令 + 注入的环境变量 + 日志/运行时文件位置。
 * 环境变量里显式钉死数据目录，保证服务和手动前台运行读写同一份 devices.json。
 */
export function resolveServiceContext({ entry, port } = {}) {
  const dataDir = resolveDataDir();
  const serviceDir = path.join(dataDir, 'service');
  const runtimeFile = path.join(serviceDir, 'runtime.json');
  const run = resolveRunCommand(entry);

  const env = {
    PATH: process.env.PATH || '',
    HIKVISION_DATA_DIR: dataDir,
    HIKVISION_RUNTIME_FILE: runtimeFile,
  };
  if (port) env.PORT = String(port);

  return {
    ...run,
    dataDir,
    serviceDir,
    runtimeFile,
    logFile: path.join(serviceDir, 'service.log'),
    env,
  };
}

/** 帮助信息里怎么称呼自己：SEA 是 exe，其余是 node <入口> */
export function defaultInvocation() {
  let isSea = false;
  try { isSea = sea.isSea(); } catch { /* node:sea 不可用 */ }
  if (isSea) return `${path.basename(process.execPath)} service`;
  return `node ${path.basename(process.argv[1] || 'server.js')} service`;
}

export function ensureServiceDir(ctx) {
  fs.mkdirSync(ctx.serviceDir, { recursive: true });
}

/** 命令行还原成一行，只用于打印给用户看 */
export function formatCommandLine(ctx) {
  return [ctx.command, ...ctx.args].map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
}

export function tailFile(file, lines) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (_) {
    return null;
  }
  const rows = content.split(/\r?\n/);
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows.slice(-lines).join('\n');
}

/** 跟随日志（Ctrl+C 退出）；Windows 上没有 tail，改用 PowerShell */
export function followFile(file, lines) {
  const child = process.platform === 'win32'
    ? spawn('powershell', ['-NoProfile', '-Command', `Get-Content -Path '${file.replace(/'/g, "''")}' -Tail ${lines} -Wait`], { stdio: 'inherit' })
    : spawn('tail', ['-n', String(lines), '-f', file], { stdio: 'inherit' });

  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
