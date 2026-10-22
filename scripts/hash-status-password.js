import { createStatusPasswordHash } from '../lib/mcp-security.js';

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  process.stderr.write('请在交互式终端运行此脚本。\n');
  process.exit(1);
}

process.stdout.write('输入状态看板密码（8–128 个字符，回车结束）：');
process.stdin.setRawMode(true);
process.stdin.resume();
let password = '';

process.stdin.on('data', chunk => {
  for (const character of chunk.toString('utf8')) {
    if (character === '\u0003') {
      process.stdin.setRawMode(false);
      process.stdout.write('\n');
      process.exit(130);
    }
    if (character === '\r' || character === '\n') {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      try { process.stdout.write(createStatusPasswordHash(password) + '\n'); }
      catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
      password = '';
      return;
    }
    if (character === '\u007f' || character === '\b') password = password.slice(0, -1);
    else if (character >= ' ') password += character;
  }
});
