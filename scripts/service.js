#!/usr/bin/env node
/**
 * 源码运行时的后台服务管理入口。
 *
 *   npm run service:install / :start / :stop / :status / :logs ...
 *   npm run service -- <命令> [选项]
 *
 * 便携包与 SEA 单文件走的是另一个入口（`<exe> service <命令>`），逻辑同一份。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { runServiceCli } from '../lib/service-manager.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const code = await runServiceCli(process.argv.slice(2), {
  entry: path.join(ROOT, 'server.js'),
  invocation: 'npm run service --',
});

process.exit(code);
