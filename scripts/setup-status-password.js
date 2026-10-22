#!/usr/bin/env node
/** 生成仅可使用一次的公网控制台初始化码。 */
import { resolveDataDir } from '../lib/data-dir.js';
import { readStatusPasswordHash } from '../lib/mcp-security.js';
import { createStatusSetupCode } from '../lib/status-password-store.js';
import path from 'node:path';

try {
  const result = createStatusSetupCode(path.join(resolveDataDir(), 'public-console-auth.json'), readStatusPasswordHash());
  console.log(`初始化码（仅显示本次，请勿发到聊天里）：\n${result.code}\n有效期至：${result.expiresAt}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
