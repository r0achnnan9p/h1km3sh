/**
 * macOS 后端：用户级 LaunchAgent（~/Library/LaunchAgents），不需要 sudo。
 *
 * 语义对应：
 *   install   写 plist + launchctl bootstrap（同时就是开机自启）
 *   start/stop  bootstrap / bootout（bootout 只是卸载运行中的任务，plist 还在）
 *   enable/disable  launchctl enable/disable，控制登录时要不要加载
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec, ensureServiceDir, escapeXml } from './service-utils.js';

export const LAUNCHD_LABEL = 'com.hikvision.video-extractor';

export function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function domain() {
  return `gui/${process.getuid()}`;
}

function serviceTarget() {
  return `${domain()}/${LAUNCHD_LABEL}`;
}

export function buildPlist(ctx) {
  const programArguments = [ctx.command, ...ctx.args]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');

  const envEntries = Object.entries(ctx.env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(ctx.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(ctx.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(ctx.logFile)}</string>
</dict>
</plist>
`;
}

/** launchctl print 的输出里挖出 state / pid */
export function parseLaunchctlPrint(stdout) {
  const pid = stdout.match(/^\s*pid\s*=\s*(\d+)/m);
  const state = stdout.match(/^\s*state\s*=\s*(\S+)/m);
  return {
    pid: pid ? Number(pid[1]) : null,
    running: state ? state[1] === 'running' : Boolean(pid),
  };
}

/** print-disabled 在不同 macOS 上分别打印 "=> true" 和 "=> disabled" */
export function parseDisabled(stdout, label = LAUNCHD_LABEL) {
  const line = stdout.split('\n').find((row) => row.includes(`"${label}"`));
  if (!line) return false;
  return /=>\s*(true|disabled)/.test(line);
}

async function loaded() {
  const res = await exec('launchctl', ['print', serviceTarget()]);
  return { loaded: res.ok, ...parseLaunchctlPrint(res.stdout) };
}

async function isDisabled() {
  const res = await exec('launchctl', ['print-disabled', domain()]);
  return parseDisabled(res.stdout);
}

/** launchctl 的报错第二行永远是「用 root 再跑一次」的套话，只留第一行 */
function firstLine(stderr, fallback) {
  const line = String(stderr).trim().split('\n')[0];
  return line || String(fallback);
}

async function bootstrap() {
  return exec('launchctl', ['bootstrap', domain(), plistPath()]);
}

export const backend = {
  id: 'launchd',
  label: 'launchd 用户级 LaunchAgent（macOS）',

  describe() {
    return [['服务定义', plistPath()]];
  },

  async install(ctx) {
    ensureServiceDir(ctx);
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    await exec('launchctl', ['bootout', serviceTarget()]);
    fs.writeFileSync(plistPath(), buildPlist(ctx));
    await exec('launchctl', ['enable', serviceTarget()]);
    const res = await bootstrap();
    if (!res.ok) {
      return { ok: false, message: `launchctl bootstrap 失败：${firstLine(res.stderr, res.code)}` };
    }
    return { ok: true, message: `已安装并启动，登录时自动运行\n  服务定义: ${plistPath()}` };
  },

  async uninstall(ctx) {
    await exec('launchctl', ['bootout', serviceTarget()]);
    await exec('launchctl', ['enable', serviceTarget()]);
    try {
      fs.unlinkSync(plistPath());
    } catch (err) {
      if (err.code !== 'ENOENT') return { ok: false, message: `删除 plist 失败：${err.message}` };
      return { ok: true, message: '服务本来就没安装，已确认清理干净' };
    }
    return { ok: true, message: `已停止并删除服务定义\n  日志仍保留: ${ctx.logFile}` };
  },

  async start() {
    const state = await loaded();
    if (state.loaded && state.running) {
      return { ok: true, message: `已经在运行（PID ${state.pid}）` };
    }
    if (state.loaded) {
      const res = await exec('launchctl', ['kickstart', serviceTarget()]);
      return res.ok
        ? { ok: true, message: '已启动' }
        : { ok: false, message: `启动失败：${firstLine(res.stderr, res.code)}` };
    }
    if (!fs.existsSync(plistPath())) {
      return { ok: false, message: '服务尚未安装，先执行 install' };
    }
    // 被 disable 过的服务 launchd 直接拒绝加载，报错文本还看不出原因，先自己判一下
    if (await isDisabled()) {
      return { ok: false, message: '开机自启处于禁用状态，launchd 不允许加载；先执行 enable 再 start' };
    }
    const res = await bootstrap();
    return res.ok
      ? { ok: true, message: '已启动' }
      : { ok: false, message: `启动失败：${firstLine(res.stderr, res.code)}` };
  },

  async stop() {
    const res = await exec('launchctl', ['bootout', serviceTarget()]);
    if (!res.ok && !/no such process|not find|Boot-out failed/i.test(res.stderr)) {
      return { ok: false, message: `停止失败：${firstLine(res.stderr, res.code)}` };
    }
    return { ok: true, message: '已停止（服务定义保留，start 可再次拉起）' };
  },

  async restart(ctx) {
    const state = await loaded();
    if (!state.loaded) return this.start(ctx);
    const res = await exec('launchctl', ['kickstart', '-k', serviceTarget()]);
    return res.ok
      ? { ok: true, message: '已重启' }
      : { ok: false, message: `重启失败：${firstLine(res.stderr, res.code)}` };
  },

  async enable() {
    const res = await exec('launchctl', ['enable', serviceTarget()]);
    return res.ok
      ? { ok: true, message: '开机自启已启用（下次登录自动运行）' }
      : { ok: false, message: `启用失败：${firstLine(res.stderr, res.code)}` };
  },

  async disable() {
    const res = await exec('launchctl', ['disable', serviceTarget()]);
    return res.ok
      ? { ok: true, message: '开机自启已禁用（当前进程不受影响，要停现在的请执行 stop）' }
      : { ok: false, message: `禁用失败：${firstLine(res.stderr, res.code)}` };
  },

  async status() {
    const installed = fs.existsSync(plistPath());
    const state = await loaded();
    const autostart = installed && !(await isDisabled());
    return {
      installed,
      autostart,
      running: state.running,
      pid: state.pid,
      extra: state.loaded ? [] : installed ? [['当前状态', '已安装但未加载（stop 之后的状态）']] : [],
    };
  },
};
