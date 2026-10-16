/** 公网录像控制台的短密码存储；密码与初始化码只保存哈希。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto, { pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { createStatusPasswordHash } from './mcp-security.js';

const pbkdf2Async = promisify(pbkdf2);
const HASH_PATTERN = /^pbkdf2:210000:([a-f0-9]{32}):([a-f0-9]{64})$/;
const SETUP_TTL_MS = 30 * 60 * 1000;

function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function same(left, right) {
  if (!Buffer.isBuffer(left)) left = Buffer.from(left || '');
  if (!Buffer.isBuffer(right)) right = Buffer.from(right || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function parseHash(value) {
  const match = HASH_PATTERN.exec(String(value || ''));
  if (!match) return null;
  return { salt: Buffer.from(match[1], 'hex'), expected: Buffer.from(match[2], 'hex') };
}
export async function verifyStatusPassword(password, hash) {
  const parsed = parseHash(hash);
  if (!parsed || typeof password !== 'string' || password.length > 128) return false;
  const actual = await pbkdf2Async(password, parsed.salt, 210_000, 32, 'sha256');
  return same(actual, parsed.expected);
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readState(filePath, initialHash) {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        Object.keys(state).some(key => !['passwordHash', 'setupHash', 'setupExpiresAt'].includes(key)) ||
        (state.passwordHash && !parseHash(state.passwordHash)) ||
        (state.setupHash && !/^[a-f0-9]{64}$/.test(state.setupHash)) ||
        (state.setupExpiresAt !== undefined && !Number.isFinite(state.setupExpiresAt))) {
      throw new Error('公网控制台密码文件格式无效，请检查 data/public-console-auth.json。');
    }
    return state.passwordHash || !initialHash ? state : { ...state, passwordHash: initialHash };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...(initialHash ? { passwordHash: initialHash } : {}) };
    if (error instanceof SyntaxError) throw new Error('公网控制台密码文件不是有效 JSON。');
    throw error;
  }
}

export function createStatusPasswordStore({ filePath, initialHash = '', loginPassword = '', sessionSecret = '' } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('必须指定公网控制台密码文件路径。');
  // Environment-managed credentials override stored state without changing it.
  // Derive the managed salt from the existing high-entropy MCP secret so an
  // unchanged password survives restarts. Never derive it from the password or
  // a public constant. Without that secret retain random, process-local salts.
  if (sessionSecret && (typeof sessionSecret !== 'string' || sessionSecret.length < 32 || /\s/.test(sessionSecret))) {
    throw new Error('控制台会话密钥必须至少 32 字符且不能包含空白。');
  }
  const managed = loginPassword !== '';
  const salt = sessionSecret ? crypto.createHmac('sha256', sessionSecret).update('hikclip-status-password-salt-v1').digest().subarray(0, 16) : undefined;
  const managedHash = managed ? createStatusPasswordHash(loginPassword, salt) : '';
  loginPassword = '';
  let state = managed ? { passwordHash: managedHash } : readState(filePath, initialHash);
  function requireFileManaged() {
    if (managed) throw new Error('登录密码由服务器环境变量 HIKCLIP_LOGIN_PASSWORD 管理，请在服务器本地修改后重启服务。');
  }
  function persist(next) { writeState(filePath, next); state = next; }
  return {
    getPasswordHash() { return state.passwordHash || ''; },
    isConfigured() { return Boolean(state.passwordHash); },
    isManaged() { return managed; },
    async initialize(code, password) {
      requireFileManaged();
      // 初始化码由服务器本机命令在进程启动后写入；校验前重新读取，避免使用启动时的旧状态。
      state = readState(filePath, initialHash);
      if (state.passwordHash) throw new Error('密码已经设置，请登录后在设置页修改。');
      if (!state.setupHash || !Number.isFinite(state.setupExpiresAt) || state.setupExpiresAt <= Date.now() ||
          typeof code !== 'string' || !same(digest(code), Buffer.from(state.setupHash, 'hex'))) {
        throw new Error('一次性初始化码无效或已过期。');
      }
      const hash = createStatusPasswordHash(password);
      persist({ passwordHash: hash });
      return true;
    },
    async change(oldPassword, password) {
      requireFileManaged();
      if (!state.passwordHash || !(await verifyStatusPassword(oldPassword, state.passwordHash))) {
        throw new Error('当前密码不正确。');
      }
      const hash = createStatusPasswordHash(password);
      persist({ passwordHash: hash });
      return true;
    },
  };
}

/** 由仅在服务器本机运行的一次性命令调用，明文码仅打印一次。 */
export function createStatusSetupCode(filePath, initialHash = '') {
  const current = readState(filePath, initialHash);
  if (current.passwordHash) throw new Error('公网控制台密码已经设置；请登录控制台后修改。');
  const code = crypto.randomBytes(24).toString('base64url');
  writeState(filePath, { setupHash: digest(code).toString('hex'), setupExpiresAt: Date.now() + SETUP_TTL_MS });
  return { code, expiresAt: new Date(Date.now() + SETUP_TTL_MS).toISOString() };
}

