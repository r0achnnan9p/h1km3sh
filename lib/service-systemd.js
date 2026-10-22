/**
 * Linux 后端：systemd 用户级 service（~/.config/systemd/user），不需要 sudo。
 *
 * 用户级 unit 默认跟着登录会话走；想「开机就跑、不用登录」要开 linger，
 * install 之后会检测并提示（那条命令需要 sudo，脚本不替用户执行）。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec, ensureServiceDir } from './service-utils.js';

export const SYSTEMD_UNIT = 'hikvision-extractor.service';

export function unitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function quote(value) {
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

export function buildUnit(ctx) {
  const execStart = [ctx.command, ...ctx.args].map(quote).join(' ');
  // 整条赋值包引号，否则带空格的 PATH/目录会被 systemd 拆成两条环境变量
  const envLines = Object.entries(ctx.env)
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`)
    .join('\n');

  return `[Unit]
Description=H1kM3sh
Documentation=https://github.com/r0achnnan9p/h1km3sh
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ctx.cwd}
ExecStart=${execStart}
${envLines}
Restart=always
RestartSec=5
StandardOutput=append:${ctx.logFile}
StandardError=append:${ctx.logFile}

[Install]
WantedBy=default.target
`;
}

async function systemctl(args) {
  return exec('systemctl', ['--user', ...args]);
}

async function lingerHint() {
  const user = os.userInfo().username;
  const res = await exec('loginctl', ['show-user', user, '-p', 'Linger', '--value']);
  if (res.ok && res.stdout.trim() === 'yes') return null;
  return `注销后也想继续跑，需要开 linger：sudo loginctl enable-linger ${user}`;
}

export const backend = {
  id: 'systemd',
  label: 'systemd 用户级服务（Linux）',

  available() {
    return fs.existsSync('/run/systemd/system');
  },

  unavailableMessage() {
    return '当前系统没有 systemd（容器/WSL1 常见），无法安装为服务。可以改用 nohup/screen 手动后台运行。';
  },

  describe() {
    return [['服务定义', unitPath()]];
  },

  async install(ctx) {
    ensureServiceDir(ctx);
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), buildUnit(ctx));
    await systemctl(['daemon-reload']);
    const res = await systemctl(['enable', '--now', SYSTEMD_UNIT]);
    if (!res.ok) {
      return { ok: false, message: `systemctl enable --now 失败：${res.stderr.trim() || res.code}` };
    }
    return {
      ok: true,
      message: `已安装并启动，开机自启已启用\n  服务定义: ${unitPath()}`,
      hint: await lingerHint(),
    };
  },

  async uninstall(ctx) {
    await systemctl(['disable', '--now', SYSTEMD_UNIT]);
    let existed = true;
    try {
      fs.unlinkSync(unitPath());
    } catch (err) {
      if (err.code !== 'ENOENT') return { ok: false, message: `删除 unit 失败：${err.message}` };
      existed = false;
    }
    await systemctl(['daemon-reload']);
    await systemctl(['reset-failed', SYSTEMD_UNIT]);
    return existed
      ? { ok: true, message: `已停止并删除服务定义\n  日志仍保留: ${ctx.logFile}` }
      : { ok: true, message: '服务本来就没安装，已确认清理干净' };
  },

  async start() {
    const res = await systemctl(['start', SYSTEMD_UNIT]);
    return res.ok
      ? { ok: true, message: '已启动' }
      : { ok: false, message: `启动失败：${res.stderr.trim() || res.code}` };
  },

  async stop() {
    const res = await systemctl(['stop', SYSTEMD_UNIT]);
    return res.ok
      ? { ok: true, message: '已停止（服务定义保留，start 可再次拉起）' }
      : { ok: false, message: `停止失败：${res.stderr.trim() || res.code}` };
  },

  async restart() {
    const res = await systemctl(['restart', SYSTEMD_UNIT]);
    return res.ok
      ? { ok: true, message: '已重启' }
      : { ok: false, message: `重启失败：${res.stderr.trim() || res.code}` };
  },

  async enable() {
    const res = await systemctl(['enable', SYSTEMD_UNIT]);
    return res.ok
      ? { ok: true, message: '开机自启已启用', hint: await lingerHint() }
      : { ok: false, message: `启用失败：${res.stderr.trim() || res.code}` };
  },

  async disable() {
    const res = await systemctl(['disable', SYSTEMD_UNIT]);
    return res.ok
      ? { ok: true, message: '开机自启已禁用（当前进程不受影响，要停现在的请执行 stop）' }
      : { ok: false, message: `禁用失败：${res.stderr.trim() || res.code}` };
  },

  async status() {
    const installed = fs.existsSync(unitPath());
    const active = await systemctl(['is-active', SYSTEMD_UNIT]);
    const enabled = await systemctl(['is-enabled', SYSTEMD_UNIT]);
    const mainPid = await systemctl(['show', SYSTEMD_UNIT, '-p', 'MainPID', '--value']);
    const pid = Number(mainPid.stdout.trim()) || null;
    return {
      installed,
      autostart: installed ? enabled.stdout.trim() === 'enabled' : false,
      running: active.stdout.trim() === 'active',
      pid,
      extra: [['systemd 状态', active.stdout.trim() || 'unknown']],
    };
  },
};

