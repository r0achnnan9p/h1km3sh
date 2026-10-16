/** Owner-only, preparation-safe configuration. No device credentials leave this module. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { normalizeDeviceEndpoint } from './device-endpoint.js';
import { getAllDevices, addDevice, updateDevice, deleteDevice, getDataFilePath } from './device-store.js';
import { readCameras, cameraCatalog, saveCameras, getCameraDataFilePath } from './camera-store.js';
import { mediaChannelDiscovery } from './media-channel-discovery.js';

export const CONSOLE_CONFIG_OWNER = Symbol('console-config-owner');
export const PREPARATION_ERROR = '当前为独立准备模式。经授权启用本机新来源前，请在服务器将 HIKCLIP_PREPARATION_ONLY 设为 0 并重启；不要复制其他实例的配置。';
export function preparationGuard(req, res, next) {
  if (process.env.HIKCLIP_PREPARATION_ONLY === '1') return res.status(409).json({ success: false, error: PREPARATION_ERROR });
  next();
}

/** Body-parser errors can contain request bytes. Never expose or log them. */
export function consoleConfigJsonError(error, req, res, next) {
  if (/^\/console\/api\/(?:settings|config|cameras|mediamtx|dvrs|upload-accounts)(?:\/|$)/i.test(req.path)
    || /^\/console\/api\/tasks\/[a-f0-9-]{36}\/dvr-http-sample\/?$/i.test(req.path)) {
    return res.set('Cache-Control', 'no-store').status(error?.type === 'entity.too.large' ? 413 : 400).json({ success: false, error: '配置请求格式无效或内容过大。' });
  }
  next(error);
}

// Per-process private key makes browser revisions opaque even for low-entropy passwords.
// A restart deliberately invalidates old edits with a revision conflict.
const revisionKey = crypto.randomBytes(32);
const configFile = path.join(path.dirname(getDataFilePath()), 'console-sources.json');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function validatePlaybackUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('MediaMTX Playback 地址无效。');
  let url; try { url = new URL(value); } catch { throw fail('MediaMTX Playback 地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('MediaMTX Playback 地址必须是无账号密码的 HTTP(S) 服务根地址。');
  return url.origin;
}
export function readPlaybackUrl() {
  let raw; try { raw = fs.readFileSync(configFile, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return validatePlaybackUrl(process.env.HIKVISION_MEDIAMTX_PLAYBACK_URL || 'http://127.0.0.1:9996');
    throw fail('无法读取来源配置，原文件已保留。', 503);
  }
  try {
    const data = JSON.parse(raw);
    if (!data || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'playbackUrl')) throw Error();
    return validatePlaybackUrl(data.playbackUrl);
  } catch { throw fail('来源配置损坏，原文件已保留。', 503); }
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
export function configSnapshot() {
  const { devices } = getAllDevices(), cameras = readCameras(), playbackUrl = readPlaybackUrl();
  const digest = crypto.createHmac('sha256', revisionKey);
  for (const file of [getDataFilePath(), getCameraDataFilePath(), configFile]) {
    try { digest.update(fs.readFileSync(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; digest.update('missing'); }
    digest.update('\0');
  }
  return { success: true, revision: digest.digest('hex'), dvrs: devices.map(d => ({ id: d.id, name: d.name, ip: d.ip, httpPort: d.httpPort || 80, rtspPort: d.rtspPort || 554, username: d.username, hasPassword: Boolean(d.password) })), cameras, channels: cameraCatalog(cameras),
    mediamtx: { playbackUrl }, preparationOnly: process.env.HIKCLIP_PREPARATION_ONLY === '1' };
}
function checkBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) throw fail('配置字段无效。');
}
function normalizedDevice(body, existing) {
  checkBody(body, ['revision', 'name', 'ip', 'httpPort', 'rtspPort', 'username', 'password']);
  const next = { ...existing, ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'revision')) };
  for (const key of ['name', 'ip', 'username']) if (typeof next[key] !== 'string' || !next[key].trim() || next[key] !== next[key].trim() || next[key].length > 128 || /[\x00-\x1f\x7f]/.test(next[key])) throw fail('录像机名称、地址或用户名无效。');
  try { const endpoint = normalizeDeviceEndpoint(next); if (next.ip.includes(':') && isIP(next.ip) !== 6 && !next.ip.startsWith('[')) throw Error(); Object.assign(next, endpoint); } catch { throw fail('录像机地址只允许主机名或 IP，不要包含协议、端口或路径。'); }
  for (const [key, fallback] of [['httpPort', 80], ['rtspPort', 554]]) {
    next[key] ??= fallback;
    if (!Number.isInteger(next[key]) || next[key] < 1 || next[key] > 65535) throw fail('端口必须为 1–65535 的整数。');
  }
  const changed = existing && ['ip', 'httpPort', 'rtspPort', 'username'].some(k => next[k] !== (existing[k] ?? (k === 'httpPort' ? 80 : k === 'rtspPort' ? 554 : undefined)));
  if (existing && !body.password) { if (changed) throw fail('修改地址、端口或用户名时，请重新输入设备密码。'); next.password = existing.password; }
  if (typeof next.password !== 'string' || !next.password || next.password.length > 512 || /[\x00\r\n]/.test(next.password)) throw fail('请输入有效设备密码。');
  return Object.fromEntries(['name', 'ip', 'httpPort', 'rtspPort', 'username', 'password'].map(k => [k, next[k]]));
}
export function mountConsoleConfig(app, { isBusy = () => false, testDevice, snapshotDevice, onPlaybackChange = () => {}, canWrite = () => true } = {}) {
  app.use((req, res, next) => {
    const pathname = req.path.toLowerCase();
    if (!/^\/console\/api\/(?:config|cameras|mediamtx|dvrs(?:\/[^/]+(?:\/(?:test|snapshot))?)?)\/?$/.test(pathname)) return next();
    res.set('Cache-Control', 'no-store');
    if (!req[CONSOLE_CONFIG_OWNER]) return res.status(401).json({ success: false, error: '请从已登录的公网控制台进行配置。' });
    if (!['GET', 'HEAD'].includes(req.method)) return preparationGuard(req, res, () => canWrite() ? next() : res.status(503).json({ success: false, error: '恢复队列尚未就绪，暂不能修改配置。' }));
    next();
  });
  const snapshot = req => ({ ...configSnapshot(), csrfToken: req[CONSOLE_CONFIG_OWNER].csrfToken });
  const handler = fn => async (req, res) => {
    try {
      if (req.method !== 'GET') {
        if (req.body?.revision !== configSnapshot().revision) throw fail('配置已改变，请重新加载后再保存。', 409);
      }
      const result = await fn(req);
      res.json(result || snapshot(req));
    } catch (error) { res.status(error.status || 400).json({ success: false, error: error.status ? error.message : '配置操作失败，请检查配置内容或服务器文件权限。', ...(['DVR_AUTH_FAILED', 'DVR_PROBE_FAILED', 'DVR_SNAPSHOT_FAILED'].includes(error.code) ? { code: error.code } : {}), ...(error.forceSaveRequired ? { forceSaveRequired: true } : {}) }); }
  };
  app.get('/console/api/config', handler(async req => { await mediaChannelDiscovery.refresh(); return snapshot(req); }));
  let testing = false;
  const probe = async device => {
    if (testing) throw fail('已有设备检查正在进行，请稍后重试。', 409);
    testing = true;
    try { return await testDevice(device); }
    catch (error) { throw Object.assign(fail('连接测试失败，请检查设备网络、账号及 ISAPI 权限。', 502), { code: error.code === 'DVR_AUTH_FAILED' ? error.code : 'DVR_PROBE_FAILED' }); }
    finally { testing = false; }
  };
  app.post('/console/api/dvrs', handler(async req => {
    checkBody(req.body, ['revision', 'name', 'ip', 'httpPort', 'rtspPort', 'username', 'password', 'forceSave']);
    const { forceSave, ...draft } = req.body;
    if (forceSave !== undefined && typeof forceSave !== 'boolean') throw fail('强制保存选项无效。');
    const device = normalizedDevice(draft);
    let result;
    if (!forceSave) {
      try { result = await probe(device); }
      catch (error) { if (error.status === 502) error.forceSaveRequired = true; throw error; }
    }
    // Testing yields: never overwrite another owner's intervening configuration.
    if (req.body.revision !== configSnapshot().revision) throw fail('配置已改变，请重新加载后再保存。', 409);
    addDevice(device, { autoActivate: false });
    return { ...snapshot(req), ...(result ? { probe: result } : {}) };
  }));
  app.patch('/console/api/dvrs/:id', handler(req => {
    const existing = getAllDevices().devices.find(d => d.id === req.params.id); if (!existing) throw fail('录像机不存在。', 404);
    const next = normalizedDevice(req.body, existing);
    if (isBusy(existing.id) && ['ip','httpPort','rtspPort','username','password'].some(k => next[k] !== (existing[k] ?? (k === 'httpPort' ? 80 : k === 'rtspPort' ? 554 : undefined)))) throw fail('此录像机仍被运行中或待恢复任务引用，请等待任务结束。', 409);
    updateDevice(existing.id, next);
  }));
  app.delete('/console/api/dvrs/:id', handler(req => {
    checkBody(req.body, ['revision']);
    if (readCameras().some(c => c.deviceId === req.params.id)) throw fail('请先移除此录像机的摄像头映射。', 409);
    if (isBusy(req.params.id)) throw fail('此录像机仍被运行中或待恢复任务引用。', 409);
    if (!deleteDevice(req.params.id, { autoActivate: false })) throw fail('录像机不存在。', 404);
  }));
  app.put('/console/api/cameras', handler(req => {
    checkBody(req.body, ['revision', 'cameras']);
    if (!Array.isArray(req.body.cameras) || req.body.cameras.length > 512) throw fail('摄像头列表无效。');
    if (isBusy()) throw fail('导出或待恢复任务尚未结束，暂不能修改映射。', 409);
    saveCameras(req.body.cameras);
  }));
  app.put('/console/api/mediamtx', handler(req => {
    checkBody(req.body, ['revision', 'playbackUrl']); const playbackUrl = validatePlaybackUrl(req.body.playbackUrl);
    atomicWrite(configFile, { playbackUrl }); onPlaybackChange(playbackUrl);
  }));
  app.post('/console/api/dvrs/:id/test', handler(async req => {
    checkBody(req.body, ['revision']);
    const device = getAllDevices().devices.find(d => d.id === req.params.id); if (!device) throw fail('录像机不存在。', 404);
    return { success: true, ...(await probe(device)) };
  }));
  app.post('/console/api/dvrs/:id/snapshot', handler(async req => {
    checkBody(req.body, ['revision', 'channel']);
    if (typeof req.body.channel !== 'string' || !/^\d{1,8}$/.test(req.body.channel)) throw fail('请选择有效的 DVR 通道。');
    const device = getAllDevices().devices.find(d => d.id === req.params.id); if (!device) throw fail('录像机不存在。', 404);
    if (testing) throw fail('已有设备检查正在进行，请稍后重试。', 409);
    if (isBusy()) throw fail('导出或待恢复任务尚未结束，暂不能获取预览。', 409);
    testing = true;
    try { return { success: true, imageDataUrl: await snapshotDevice(device, req.body.channel) }; }
    catch (error) { throw Object.assign(fail('无法获取画面，请检查通道是否在线及设备抓图权限。', 502), { code: error.code === 'DVR_AUTH_FAILED' ? error.code : 'DVR_SNAPSHOT_FAILED' }); }
    finally { testing = false; }
  }));
}
