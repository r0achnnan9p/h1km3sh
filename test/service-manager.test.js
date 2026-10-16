/**
 * 后台服务管理相关模块的测试。
 *
 * 三个平台的服务定义都是「拼字符串 → 交给系统工具」，能在这里验的就是拼出来的
 * 内容：路径带空格/中文时有没有被拆开、转义对不对、状态输出解析得准不准。
 * 真正的 launchctl / systemctl / schtasks 调用不在测试范围内。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import xml2js from 'xml2js';

import { parseServiceArgs } from '../lib/service-manager.js';
import { resolveRunCommand, resolveServiceContext, escapeXml, tailFile } from '../lib/service-utils.js';
import { buildPlist, parseLaunchctlPrint, parseDisabled, LAUNCHD_LABEL } from '../lib/service-launchd.js';
import { buildUnit } from '../lib/service-systemd.js';
import { buildVbs, buildTaskXml, parseTaskEnabled, decodeWindowsOutput, TASK_NAME } from '../lib/service-windows.js';

// 故意用带空格的路径——真实世界里 "C:\Program Files" 和 "/Users/张三/我的 视频" 都存在
const CTX = {
  command: '/opt/my apps/node',
  args: ['/opt/my apps/server.js'],
  cwd: '/opt/my apps',
  serviceDir: '/opt/my apps/data/service',
  runtimeFile: '/opt/my apps/data/service/runtime.json',
  logFile: '/opt/my apps/data/service/service.log',
  env: {
    PATH: '/usr/local/bin:/usr/bin',
    HIKVISION_DATA_DIR: '/opt/my apps/data',
    HIKVISION_RUNTIME_FILE: '/opt/my apps/data/service/runtime.json',
  },
};

describe('parseServiceArgs', () => {
  it('不给参数时默认看状态', () => {
    assert.deepEqual(parseServiceArgs([]), { command: 'status', port: null, lines: 60, follow: false, error: null });
  });

  it('识别 --port 的两种写法', () => {
    assert.equal(parseServiceArgs(['install', '--port', '8080']).port, 8080);
    assert.equal(parseServiceArgs(['install', '--port=8080']).port, 8080);
  });

  it('识别 logs 的 -n / -f', () => {
    const parsed = parseServiceArgs(['logs', '-n', '200', '-f']);
    assert.equal(parsed.lines, 200);
    assert.equal(parsed.follow, true);
  });

  it('端口越界或不是数字要报错', () => {
    assert.match(parseServiceArgs(['install', '--port', '70000']).error, /65535/);
    assert.match(parseServiceArgs(['install', '--port', 'abc']).error, /整数/);
  });

  it('认不出来的参数直接报错，不静默忽略', () => {
    assert.match(parseServiceArgs(['install', '--forever']).error, /--forever/);
  });
});

describe('服务上下文', () => {
  it('源码运行时启动命令是「当前 node + 入口脚本」', () => {
    const run = resolveRunCommand('/tmp/some project/server.js');
    assert.equal(run.command, process.execPath);
    assert.deepEqual(run.args, ['/tmp/some project/server.js']);
    assert.equal(run.cwd, '/tmp/some project');
  });

  it('数据目录、运行时文件、日志都锚在同一处，PORT 只在指定时注入', () => {
    const withoutPort = resolveServiceContext({ entry: '/tmp/p/server.js' });
    assert.equal(withoutPort.env.PORT, undefined);
    assert.equal(withoutPort.env.HIKVISION_DATA_DIR, withoutPort.dataDir);
    assert.equal(withoutPort.env.HIKVISION_RUNTIME_FILE, withoutPort.runtimeFile);
    assert.equal(path.dirname(withoutPort.logFile), withoutPort.serviceDir);

    const withPort = resolveServiceContext({ entry: '/tmp/p/server.js', port: 30005 });
    assert.equal(withPort.env.PORT, '30005');
  });
});

describe('launchd plist', () => {
  it('带空格的路径各自独立成一个 <string>，不会被拆开', async () => {
    const parsed = await xml2js.parseStringPromise(buildPlist(CTX));
    const dict = parsed.plist.dict[0];
    assert.deepEqual(dict.array[0].string, ['/opt/my apps/node', '/opt/my apps/server.js']);
  });

  it('登录自启 + 挂了自动拉起，日志指向服务日志文件', () => {
    const plist = buildPlist(CTX);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.ok(plist.includes(`<key>StandardOutPath</key>\n  <string>${CTX.logFile}</string>`));
  });

  it('环境变量原样写进 EnvironmentVariables', async () => {
    const parsed = await xml2js.parseStringPromise(buildPlist(CTX));
    const envDict = parsed.plist.dict[0].dict[0];
    assert.deepEqual(envDict.key, ['PATH', 'HIKVISION_DATA_DIR', 'HIKVISION_RUNTIME_FILE']);
    assert.equal(envDict.string[1], '/opt/my apps/data');
  });

  it('XML 特殊字符要转义（目录名带 & 也不能把 plist 写坏）', async () => {
    const ctx = { ...CTX, cwd: '/opt/a&b <test>' };
    const parsed = await xml2js.parseStringPromise(buildPlist(ctx));
    assert.ok(parsed.plist.dict[0].string.includes('/opt/a&b <test>'));
  });

  it('从 launchctl print 里读出 pid 与运行状态', () => {
    const out = 'com.hikvision.video-extractor = {\n\tactive count = 1\n\tpid = 4242\n\tstate = running\n}';
    assert.deepEqual(parseLaunchctlPrint(out), { pid: 4242, running: true });
    assert.deepEqual(parseLaunchctlPrint('state = not running'), { pid: null, running: false });
  });

  it('print-disabled 的两种输出格式都认', () => {
    assert.equal(parseDisabled(`\t"${LAUNCHD_LABEL}" => disabled`), true);
    assert.equal(parseDisabled(`\t"${LAUNCHD_LABEL}" => true`), true);
    assert.equal(parseDisabled(`\t"${LAUNCHD_LABEL}" => false`), false);
    assert.equal(parseDisabled('\t"com.apple.other" => true'), false);
  });
});

describe('systemd unit', () => {
  const unit = buildUnit(CTX);

  it('ExecStart 的每个路径单独加引号', () => {
    assert.match(unit, /^ExecStart="\/opt\/my apps\/node" "\/opt\/my apps\/server\.js"$/m);
  });

  it('环境变量整条赋值包引号，否则带空格的值会被 systemd 拆成两条', () => {
    assert.match(unit, /^Environment="HIKVISION_DATA_DIR=\/opt\/my apps\/data"$/m);
  });

  it('WorkingDirectory 不能加引号（systemd 会把引号当成路径的一部分）', () => {
    assert.match(unit, /^WorkingDirectory=\/opt\/my apps$/m);
  });

  it('挂了自动重启，输出追加到日志文件，装的是 default.target', () => {
    assert.match(unit, /^Restart=always$/m);
    assert.ok(unit.includes(`StandardOutput=append:${CTX.logFile}`));
    assert.match(unit, /^WantedBy=default\.target$/m);
  });
});

describe('Windows 计划任务', () => {
  const ctx = { ...CTX, cwd: 'C:\\Program Files\\Hik', serviceDir: 'C:\\Program Files\\Hik\\data\\service' };

  it('VBS 用隐藏窗口 + 同步等待的方式启动（0=隐藏，True=等子进程）', () => {
    const vbs = buildVbs(ctx);
    assert.match(vbs, /shell\.Run ".+", 0, True/);
  });

  it('命令行按 cmd 的规矩套两层引号，并把输出追加进日志', () => {
    const vbs = buildVbs(ctx);
    // VBS 字面量里的引号是双写的，还原后应当是 cmd /c ""node" "server.js" >> "log" 2>&1"
    const literal = vbs.split('shell.Run ')[1].split('", 0, True')[0].slice(1);
    const commandLine = literal.replace(/""/g, '"');
    assert.equal(
      commandLine,
      `cmd /c ""${CTX.command}" "${CTX.args[0]}" >> "${CTX.logFile}" 2>&1"`
    );
  });

  it('环境变量写进进程环境，子进程能继承', () => {
    const vbs = buildVbs(ctx);
    assert.ok(vbs.includes('env("HIKVISION_RUNTIME_FILE") = "/opt/my apps/data/service/runtime.json"'));
    assert.ok(vbs.includes('shell.CurrentDirectory = "C:\\Program Files\\Hik"'));
  });

  it('任务 XML 是合法 XML，登录触发、不限时长、动作指向 wscript', async () => {
    const parsed = await xml2js.parseStringPromise(buildTaskXml(ctx));
    const task = parsed.Task;
    assert.equal(task.Triggers[0].LogonTrigger[0].Enabled[0], 'true');
    assert.equal(task.Settings[0].ExecutionTimeLimit[0], 'PT0S');
    assert.equal(task.Settings[0].MultipleInstancesPolicy[0], 'IgnoreNew');
    assert.equal(task.Actions[0].Exec[0].Command[0], 'wscript.exe');
    assert.match(task.Actions[0].Exec[0].Arguments[0], /^\/\/nologo ".*run-hidden\.vbs"$/);
    assert.equal(task.RegistrationInfo[0].URI[0], `\\${TASK_NAME}`);
  });

  it('自启状态只看 <Settings> 里的 Enabled，别被触发器那个同名节点带偏', () => {
    const disabled = buildTaskXml(ctx).replace('<Enabled>true</Enabled>\n    <Hidden>', '<Enabled>false</Enabled>\n    <Hidden>');
    assert.equal(parseTaskEnabled(buildTaskXml(ctx)), true);
    assert.equal(parseTaskEnabled(disabled), false);
    assert.equal(parseTaskEnabled('没有 Settings 段'), null);
  });

  it('schtasks 的 UTF-16 输出能正确解码', () => {
    const text = '<Task>状态</Task>';
    assert.equal(decodeWindowsOutput(Buffer.from('\ufeff' + text, 'utf16le')), text);
    assert.equal(decodeWindowsOutput(Buffer.from(text, 'utf16le')), text);
    assert.equal(decodeWindowsOutput(Buffer.from(text, 'utf8')), text);
    assert.equal(decodeWindowsOutput('已经是字符串'), '已经是字符串');
  });
});

describe('runtime 文件', () => {
  let tmpDir;
  let runtime;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hik-runtime-'));
    process.env.HIKVISION_RUNTIME_FILE = path.join(tmpDir, 'runtime.json');
    runtime = await import('../lib/runtime-file.js');
  });

  after(() => {
    delete process.env.HIKVISION_RUNTIME_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('写入后能读回 pid 与端口，clear 之后就没了', () => {
    runtime.writeRuntimeFile({ port: 30001 });
    const info = runtime.readRuntimeFile(process.env.HIKVISION_RUNTIME_FILE);
    assert.equal(info.pid, process.pid);
    assert.equal(info.port, 30001);
    runtime.clearRuntimeFile();
    assert.equal(runtime.readRuntimeFile(process.env.HIKVISION_RUNTIME_FILE), null);
  });

  it('当前进程活着，不存在的 pid 判死', () => {
    assert.equal(runtime.isPidAlive(process.pid), true);
    assert.equal(runtime.isPidAlive(0), false);
    assert.equal(runtime.isPidAlive(2147483646), false);
  });
});

describe('日志读取', () => {
  it('tailFile 取末尾 N 行，文件不存在返回 null', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hik-log-')), 'service.log');
    fs.writeFileSync(file, '第1行\n第2行\n第3行\n');
    assert.equal(tailFile(file, 2), '第2行\n第3行');
    assert.equal(tailFile(file, 99), '第1行\n第2行\n第3行');
    assert.equal(tailFile(path.join(path.dirname(file), 'nope.log'), 5), null);
  });
});

describe('escapeXml', () => {
  it('五个特殊字符都转', () => {
    assert.equal(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
  });
});
