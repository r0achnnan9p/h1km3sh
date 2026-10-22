/**
 * 后台服务 CLI：install / uninstall / start / stop / restart / status / enable / disable / logs
 *
 * 三个平台各用系统自带的机制（都不需要管理员/root）：
 *   macOS   launchd 用户级 LaunchAgent
 *   Linux   systemd 用户级 service
 *   Windows 计划任务（登录触发）+ VBS 隐藏窗口启动器
 *
 * 入口有两个，走的是同一份逻辑：
 *   node scripts/service.js <命令>      （源码运行）
 *   <exe|app.js> service <命令>         （SEA 单文件 / 便携包）
 */

import fs from 'fs';
import { resolveServiceContext, formatCommandLine, tailFile, followFile, defaultInvocation } from './service-utils.js';
import { readRuntimeFile, isPidAlive } from './runtime-file.js';
import { getLanAddresses } from './lan-address.js';
import { backend as launchdBackend } from './service-launchd.js';
import { backend as systemdBackend } from './service-systemd.js';
import { backend as windowsBackend } from './service-windows.js';

const BACKENDS = {
  darwin: launchdBackend,
  linux: systemdBackend,
  win32: windowsBackend,
};

const COMMANDS = [
  ['install', '安装为后台服务（含开机自启）并立即启动'],
  ['uninstall', '停止并删除服务（日志保留）'],
  ['start', '启动服务'],
  ['stop', '停止服务（服务定义保留）'],
  ['restart', '重启服务'],
  ['status', '查看安装 / 自启 / 运行状态与 API 地址'],
  ['enable', '打开开机自启'],
  ['disable', '关闭开机自启（不影响当前正在跑的进程）'],
  ['logs', '查看服务日志（-f 跟随输出）'],
];

export function parseServiceArgs(argv) {
  const result = { command: argv[0] || 'status', port: null, lines: 60, follow: false, error: null };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-f' || arg === '--follow') {
      result.follow = true;
    } else if (arg === '-n' || arg === '--lines') {
      result.lines = Number(argv[++i]);
    } else if (arg.startsWith('--lines=')) {
      result.lines = Number(arg.slice('--lines='.length));
    } else if (arg === '--port') {
      result.port = Number(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      result.port = Number(arg.slice('--port='.length));
    } else {
      result.error = `无法识别的参数：${arg}`;
      return result;
    }
  }
  if (result.port !== null && !Number.isInteger(result.port)) {
    result.error = '--port 需要一个整数端口号';
  } else if (result.port !== null && (result.port < 1 || result.port > 65535)) {
    result.error = '--port 超出 1-65535 范围';
  } else if (!Number.isInteger(result.lines) || result.lines < 1) {
    result.error = '-n/--lines 需要一个正整数';
  }
  return result;
}

function printHelp(invocation) {
  console.log(`\nH1kM3sh · 后台服务管理\n`);
  console.log(`用法: ${invocation} <命令> [选项]\n`);
  console.log('命令:');
  for (const [name, desc] of COMMANDS) {
    console.log(`  ${name.padEnd(11)}${desc}`);
  }
  console.log('\n选项:');
  console.log('  --port <端口>     仅 install：固定监听端口（默认沿用 30001，占用时自动顺延）');
  console.log('  -n, --lines <n>   仅 logs：显示末尾多少行，默认 60');
  console.log('  -f, --follow      仅 logs：持续跟随输出，Ctrl+C 退出');
  console.log('');
}

// 标签统一是 4 个全角字（占 8 列），空标签就补满同样的宽度
function row(label, value) {
  console.log(`  ${label ? `${label}  ` : ' '.repeat(10)}${value}`);
}

/** 服务刚拉起时端口还没定，等运行时文件落盘好把真实地址打出来 */
async function waitForRuntime(ctx, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readRuntimeFile(ctx.runtimeFile);
    if (info && isPidAlive(info.pid)) return info;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function printUrls(port) {
  row('API 地址', `http://localhost:${port}`);
  for (const addr of getLanAddresses()) {
    row('', `http://${addr}:${port}`);
  }
}

async function showStatus(ctx, backend) {
  const state = await backend.status(ctx);
  const runtime = readRuntimeFile(ctx.runtimeFile);
  const alive = runtime && isPidAlive(runtime.pid);

  console.log('');
  row('服务后端', backend.label);
  row('安装状态', state.installed ? '已安装' : '未安装');
  row('开机自启', state.installed ? (state.autostart ? '已启用' : '已禁用') : '—');
  row('运行状态', state.running || alive ? `运行中（PID ${state.pid || runtime?.pid || '未知'}）` : '未运行');
  if ((state.running || alive) && runtime?.port) {
    printUrls(runtime.port);
  }
  for (const [label, value] of backend.describe(ctx)) row(label, value);
  for (const [label, value] of state.extra || []) row(label, value);
  row('日志文件', ctx.logFile);
  row('启动命令', formatCommandLine(ctx));
  console.log('');
  return 0;
}

async function showLogs(ctx, options) {
  if (!fs.existsSync(ctx.logFile)) {
    console.log(`还没有日志文件（服务没跑过？）：${ctx.logFile}`);
    return 0;
  }
  if (options.follow) {
    console.log(`跟随日志 ${ctx.logFile}（Ctrl+C 退出）\n`);
    return followFile(ctx.logFile, options.lines);
  }
  console.log(tailFile(ctx.logFile, options.lines) ?? '');
  return 0;
}

function report(result) {
  console.log(`\n  ${result.ok ? '✓' : '✗'} ${result.message}`);
  if (result.hint) console.log(`  提示: ${result.hint}`);
  console.log('');
  return result.ok ? 0 : 1;
}

export async function runServiceCli(argv, { entry, invocation = defaultInvocation() } = {}) {
  const options = parseServiceArgs(argv);

  if (['-h', '--help', 'help'].includes(options.command)) {
    printHelp(invocation);
    return 0;
  }
  if (options.error) {
    console.error(`\n  ✗ ${options.error}\n`);
    printHelp(invocation);
    return 1;
  }
  if (!COMMANDS.some(([name]) => name === options.command)) {
    console.error(`\n  ✗ 未知命令：${options.command}\n`);
    printHelp(invocation);
    return 1;
  }

  const backend = BACKENDS[process.platform];
  if (!backend) {
    console.error(`\n  ✗ 暂不支持在 ${process.platform} 上安装后台服务\n`);
    return 1;
  }
  if (backend.available && !backend.available()) {
    console.error(`\n  ✗ ${backend.unavailableMessage()}\n`);
    return 1;
  }

  const ctx = resolveServiceContext({ entry, port: options.port });

  if (options.command === 'status') return showStatus(ctx, backend);
  if (options.command === 'logs') return showLogs(ctx, options);

  const result = await backend[options.command](ctx);
  const code = report(result);

  if (result.ok && ['install', 'start', 'restart'].includes(options.command)) {
    const runtime = await waitForRuntime(ctx);
    if (runtime) {
      printUrls(runtime.port);
      console.log('');
    } else {
      console.log(`  服务已拉起但还没报告端口，稍后看 status 或日志：${ctx.logFile}\n`);
    }
  }
  return code;
}

