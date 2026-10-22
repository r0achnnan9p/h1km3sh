/** Non-secret upload defaults and sanitized worker observations. Never reads credentials. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeCloud189TargetPath } from './cloud189-queue.js';
import { CONSOLE_CONFIG_OWNER } from './console-config.js';

// Existing football collection mapping documented in docs/camera-mcp.md.
// This is configuration, not ownership proof: workers still verify the account,
// collection name, eligibility and exact section before sending any video.
export const FOOTBALL_COLLECTION = Object.freeze({ seasonId: 1735361, sectionId: 1992175 });
const defaults = () => ({ cloud189TargetPath: '/H1kM3sh', bilibiliTitlePrefix: '', bilibiliExtraTags: [], managedEnabled: true, bilibiliEnabled: true, cloud189Enabled: true,
  bilibiliSeasonId: FOOTBALL_COLLECTION.seasonId, bilibiliSectionId: FOOTBALL_COLLECTION.sectionId });
export function validateUploadSettings(input, previous = defaults(), { legacy = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['cloud189TargetPath', 'bilibiliTitlePrefix', 'bilibiliExtraTags', 'managedEnabled', 'bilibiliEnabled', 'cloud189Enabled', 'bilibiliSeasonId', 'bilibiliSectionId'].includes(k))) throw new Error('上传配置已固定，请刷新页面后重试。');
  const result = { ...previous, cloud189TargetPath: '/H1kM3sh', managedEnabled: true, bilibiliEnabled: true, cloud189Enabled: true, bilibiliTitlePrefix: '', bilibiliExtraTags: [], bilibiliSeasonId: FOOTBALL_COLLECTION.seasonId, bilibiliSectionId: FOOTBALL_COLLECTION.sectionId };
  for (const key of ['managedEnabled', 'bilibiliEnabled', 'cloud189Enabled']) if (Object.hasOwn(input, key)) {
    if (typeof input[key] !== 'boolean') throw new Error('上传开关必须为布尔值。');
    if (!legacy && input[key] !== true) throw new Error('配置完成即可上传，无需上传开关。');
  }
  for (const key of ['bilibiliSeasonId', 'bilibiliSectionId']) if (Object.hasOwn(input, key)) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) throw new Error('合集和章节编号必须为正整数，或用 0 清除。');
    if (!legacy && input[key] !== result[key]) throw new Error('足球合集和分节由服务器固定，无需填写编号。');
  }
  if (Object.hasOwn(input, 'cloud189TargetPath')) {
    const value = input.cloud189TargetPath;
    const normalized = typeof value === 'string' && !value.trim() ? '' : normalizeCloud189TargetPath(value);
    if (!legacy && normalized !== '/H1kM3sh') throw new Error('天翼云盘目录固定为 /H1kM3sh。');
  }
  if (Object.hasOwn(input, 'bilibiliTitlePrefix')) {
    const value = input.bilibiliTitlePrefix;
    if (typeof value !== 'string' || [...value].length > 30 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('标题前缀最多 30 个字符，不能包含控制字符。');
    if (!legacy && value.trim()) throw new Error('投稿标题固定沿用文件名，不添加前缀。');
  }
  if (Object.hasOwn(input, 'bilibiliExtraTags')) {
    const tags = input.bilibiliExtraTags;
    if (!Array.isArray(tags) || tags.length > 9 || tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 20 || /[,\x00-\x1f\x7f]/.test(t))) throw new Error('补充标签最多 9 个，每个最多 20 字，不能包含逗号或控制字符。');
    if (!legacy && tags.some(tag => tag.trim() !== '足球')) throw new Error('投稿标签固定为足球。');
  }
  return result;
}
export function createUploadSettingsStore(file) {
  function read() {
    try { return validateUploadSettings(JSON.parse(fs.readFileSync(file, 'utf8')), defaults(), { legacy: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return defaults();
      throw new Error('上传设置无法读取，原文件已保留，请检查服务器配置。');
    }
  }
  function update(input) {
    const value = validateUploadSettings(input, read());
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
    }
    return value;
  }
  return { read, update };
}
function observation(root, directory, now) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, directory, 'worker-status.json'), 'utf8'));
    const age = now / 1000 - value.checkedAt;
    if (!Number.isFinite(value.checkedAt) || age < -5 || age >= 150) return null;
    return value;
  } catch { return null; }
}
export function readUploadIntegrations(root, { enabled = process.env.HIKVISION_BILIUP_ENABLED === '1', now = Date.now() } = {}) {
  const bili = observation(root, 'biliup_work', now), cloud = observation(root, 'cloud189_work', now);
  const binary = bili?.binaryAvailable === true, credentials = bili?.credentialsPresent === true, cover = bili?.coverAvailable === true;
  return {
    bilibiliEnabled: enabled && binary && credentials && cover,
    bilibiliConfigured: enabled,
    bilibiliWorkerAvailable: !!bili, bilibiliBinaryAvailable: binary,
    bilibiliCredentialsPresent: credentials, bilibiliCoverAvailable: cover,
    // A credential file says nothing about expiration or remote account validity.
    bilibiliAuthState: !bili ? 'unknown' : credentials ? 'unverified' : 'missing',
    cloud189WorkerAvailable: !!cloud,
    cloud189BinaryAvailable: cloud?.binaryAvailable === true,
    cloud189Authenticated: cloud?.authenticated === true,
    cloud189Enabled: cloud?.binaryAvailable === true && cloud?.authenticated === true,
    cloud189AuthState: !cloud ? 'unknown' : cloud.authenticated === true ? 'verified' : 'unverified',
    webLoginSupported: false,
  };
}
export function uploadTitle(filename) {
  return [...filename.replace(/\.mp4$/i, '')].slice(0, 80).join('');
}
export function mountUploadSettings(app, { store, integrations, cover = () => ({ present: false, source: 'missing' }), canWrite = () => true, onChange = () => {} }) {
  const endpoint = '/console/api/settings';
  app.use(endpoint, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req[CONSOLE_CONFIG_OWNER]) return res.status(401).json({ success: false, error: '请从已登录的控制台配置上传。' });
    next();
  });
  app.get(endpoint, (req, res) => {
    try { res.json({ success: true, settings: store.read(), integrations: integrations(), cover: cover(), csrfToken: req[CONSOLE_CONFIG_OWNER].csrfToken }); }
    catch { res.status(500).json({ success: false, error: '上传设置无法读取，原文件已保留。' }); }
  });
  app.put(endpoint, async (req, res) => {
    if (req[CONSOLE_CONFIG_OWNER]?.isSessionActive?.() === false) return res.status(401).json({ success: false, error: '登录已退出，请重新登录后修改上传设置。' });
    if (!canWrite()) return res.status(503).json({ success: false, error: '恢复队列尚未就绪，暂不能修改上传设置。' });
    try { const settings = store.update(req.body); await onChange(); res.json({ success: true, settings, integrations: integrations(), cover: cover(), csrfToken: req[CONSOLE_CONFIG_OWNER].csrfToken }); }
    catch { res.status(400).json({ success: false, error: '上传设置保存失败。B 站固定足球合集、足球标签和无前缀标题；请刷新页面后重试。' }); }
  });
}
