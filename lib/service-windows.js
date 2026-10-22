/**
 * Windows 后端：计划任务（登录时触发）+ VBS 隐藏启动器，全程不需要管理员权限。
 *
 * 为什么要中间套一层 VBS：计划任务直接跑 node.exe 会弹出一个黑色控制台窗口，
 * WScript.Shell.Run(cmd, 0, True) 才能真正隐藏窗口，同时把输出重定向进日志文件。
 *
 * 计划任务用 XML 注册（schtasks /Create /XML），避免 /TR 里嵌套引号被层层转义弄坏，
 * 顺便能设置「不限时长」「多实例忽略」这些 schtasks 命令行给不了的选项。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec, ensureServiceDir, escapeXml } from './service-utils.js';
import { readRuntimeFile, isPidAlive } from './runtime-file.js';

export const TASK_NAME = 'HikvisionVideoExtractor';

export function vbsPath(ctx) {
  return path.join(ctx.serviceDir, 'run-hidden.vbs');
}

export function taskXmlPath(ctx) {
  return path.join(ctx.serviceDir, 'task.xml');
}

function currentUserId() {
  const { USERDOMAIN, USERNAME } = process.env;
  if (USERDOMAIN && USERNAME) return `${USERDOMAIN}\\${USERNAME}`;
  return USERNAME || os.userInfo().username;
}

function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function buildVbs(ctx) {
  const quoted = (p) => `"${p}"`;
  // cmd 的老规矩：整条命令再包一层引号，里面每个路径各自带引号
  const inner = `${[ctx.command, ...ctx.args].map(quoted).join(' ')} >> ${quoted(ctx.logFile)} 2>&1`;
  const commandLine = `cmd /c "${inner}"`;

  const envLines = Object.entries(ctx.env)
    .map(([key, value]) => `env(${vbsString(key)}) = ${vbsString(value)}`)
    .join('\n');

  return [
    "' 由 H1kM3sh 自动生成（service install），手动改动会在下次安装时被覆盖",
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("Process")',
    envLines,
    `shell.CurrentDirectory = ${vbsString(ctx.cwd)}`,
    `shell.Run ${vbsString(commandLine)}, 0, True`,
    '',
  ].join('\r\n');
}

export function buildTaskXml(ctx) {
  const userId = currentUserId();
  const args = `//nologo "${vbsPath(ctx)}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>H1kM3sh background service</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${escapeXml(args)}</Arguments>
      <WorkingDirectory>${escapeXml(ctx.cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks 输出可能是 UTF-16LE（带或不带 BOM），按内容判断解码方式 */
export function decodeWindowsOutput(raw) {
  if (!Buffer.isBuffer(raw)) return String(raw ?? '');
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.toString('utf16le', 2);
  if (raw.length >= 4 && raw[1] === 0x00 && raw[3] === 0x00) return raw.toString('utf16le');
  return raw.toString('utf8');
}

/** 只认 <Settings> 段里的 Enabled——触发器里也有一个同名节点 */
export function parseTaskEnabled(xml) {
  const settings = xml.split('<Settings>')[1];
  if (!settings) return null;
  const match = settings.match(/<Enabled>(true|false)<\/Enabled>/i);
  return match ? match[1].toLowerCase() === 'true' : null;
}

async function queryTaskXml() {
  const res = await exec('schtasks', ['/Query', '/TN', TASK_NAME, '/XML', 'ONE'], { encoding: 'buffer' });
  return { ok: res.ok, xml: decodeWindowsOutput(res.stdout) };
}

function runningPid(ctx) {
  const info = readRuntimeFile(ctx.runtimeFile);
  if (info && isPidAlive(info.pid)) return info.pid;
  return null;
}

export const backend = {
  id: 'schtasks',
  label: 'Windows 计划任务（登录时启动，隐藏窗口）',

  describe(ctx) {
    return [
      ['计划任务', TASK_NAME],
      ['启动器', vbsPath(ctx)],
    ];
  },

  async install(ctx) {
    ensureServiceDir(ctx);
    // 两个文件都写 UTF-16LE + BOM：中文用户名的路径（C:\用户\…）只有这样才不会乱码，
    // WSH 认 BOM，schtasks /XML 也只吃 Unicode 文件
    fs.writeFileSync(vbsPath(ctx), Buffer.from('\ufeff' + buildVbs(ctx), 'utf16le'));
    fs.writeFileSync(taskXmlPath(ctx), Buffer.from('\ufeff' + buildTaskXml(ctx), 'utf16le'));

    const res = await exec('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', taskXmlPath(ctx), '/F']);
    if (!res.ok) {
      return { ok: false, message: `创建计划任务失败：${decodeWindowsOutput(res.stderr).trim() || res.code}` };
    }
    const run = await exec('schtasks', ['/Run', '/TN', TASK_NAME]);
    if (!run.ok) {
      return { ok: true, message: `计划任务已创建（登录时自动运行），但立即启动失败：${decodeWindowsOutput(run.stderr).trim()}` };
    }
    return { ok: true, message: `已安装并启动，登录时自动运行\n  计划任务: ${TASK_NAME}` };
  },

  async uninstall(ctx) {
    await this.stop(ctx);
    const res = await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    for (const file of [vbsPath(ctx), taskXmlPath(ctx)]) {
      try { fs.unlinkSync(file); } catch (_) { /* 不存在就算了 */ }
    }
    if (!res.ok && !/找不到|cannot find|does not exist/i.test(decodeWindowsOutput(res.stderr))) {
      return { ok: false, message: `删除计划任务失败：${decodeWindowsOutput(res.stderr).trim() || res.code}` };
    }
    return { ok: true, message: `已停止并删除计划任务\n  日志仍保留: ${ctx.logFile}` };
  },

  async start(ctx) {
    if (runningPid(ctx)) return { ok: true, message: `已经在运行（PID ${runningPid(ctx)}）` };
    const res = await exec('schtasks', ['/Run', '/TN', TASK_NAME]);
    return res.ok
      ? { ok: true, message: '已启动' }
      : { ok: false, message: `启动失败：${decodeWindowsOutput(res.stderr).trim() || res.code}（任务被 disable 时无法启动）` };
  },

  async stop(ctx) {
    const pid = runningPid(ctx);
    await exec('schtasks', ['/End', '/TN', TASK_NAME]);
    if (pid) {
      const kill = await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
      if (!kill.ok && isPidAlive(pid)) {
        return { ok: false, message: `停止失败：${decodeWindowsOutput(kill.stderr).trim() || kill.code}` };
      }
    }
    return { ok: true, message: '已停止（计划任务保留，start 可再次拉起）' };
  },

  async restart(ctx) {
    await this.stop(ctx);
    return this.start(ctx);
  },

  async enable() {
    const res = await exec('schtasks', ['/Change', '/TN', TASK_NAME, '/ENABLE']);
    return res.ok
      ? { ok: true, message: '开机自启已启用（下次登录自动运行）' }
      : { ok: false, message: `启用失败：${decodeWindowsOutput(res.stderr).trim() || res.code}` };
  },

  async disable() {
    const res = await exec('schtasks', ['/Change', '/TN', TASK_NAME, '/DISABLE']);
    return res.ok
      ? { ok: true, message: '开机自启已禁用（当前进程不受影响，要停现在的请执行 stop）' }
      : { ok: false, message: `禁用失败：${decodeWindowsOutput(res.stderr).trim() || res.code}` };
  },

  async status(ctx) {
    const { ok, xml } = await queryTaskXml();
    const pid = runningPid(ctx);
    return {
      installed: ok,
      autostart: ok ? parseTaskEnabled(xml) !== false : false,
      running: Boolean(pid),
      pid,
      extra: [],
    };
  },
};

