/** Optional aliases/bindings over automatically discovered MediaMTX paths. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { resolveDataDir } from './data-dir.js';
import { getDeviceById } from './device-store.js';
import { mediaChannelDiscovery } from './media-channel-discovery.js';

const DATA_FILE = path.join(resolveDataDir(), 'cameras.json');
const FIELDS = new Set(['id', 'name', 'deviceId', 'channel', 'archivePath']);

export function getCameraDataFilePath() {
  return DATA_FILE;
}

export function validateCameras(cameras) {
  if (!Array.isArray(cameras)) throw new Error('摄像头配置必须包含 cameras 数组。');
  const aliases = new Set();
  return cameras.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).some((key) => !FIELDS.has(key))) {
      throw new Error('摄像头配置只允许映射字段，不能包含凭据。');
    }
    if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id) ||
        typeof raw.name !== 'string' || !raw.name.trim() || raw.name !== raw.name.trim()) {
      throw new Error('摄像头 id 或 name 格式无效。');
    }
    const bound = raw.deviceId !== undefined || raw.channel !== undefined;
    if (bound && (typeof raw.deviceId !== 'string' || !raw.deviceId.trim() || raw.deviceId !== raw.deviceId.trim() ||
        !['string', 'number'].includes(typeof raw.channel) || !/^\d{1,8}$/.test(String(raw.channel)))) {
      throw new Error('DVR 绑定必须同时提供有效的 deviceId 和 channel。');
    }
    // 名称与 ID 共用查找空间，防止中文别名或交叉 ID 产生歧义。
    const keys = new Set([raw.id, raw.name]);
    for (const key of keys) {
      if (aliases.has(key)) throw new Error('摄像头 ID 或名称重复，无法唯一解析。');
      aliases.add(key);
    }
    if (raw.archivePath !== undefined && (typeof raw.archivePath !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.archivePath))) {
      throw new Error('archivePath 必须是录像根目录下的单层目录名称。');
    }
    if (!bound && raw.archivePath === undefined) throw new Error('本地录像通道需要 MediaMTX 路径。');
    return { id: raw.id, name: raw.name, ...(bound ? { deviceId: raw.deviceId, channel: String(raw.channel) } : {}),
      ...(raw.archivePath !== undefined ? { archivePath: raw.archivePath } : {}) };
  });
}

export function readCameras() {
  let text;
  try {
    text = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('无法读取 cameras.json，请检查文件权限。');
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    // JSON 解析错误可能带出原文，不能把潜在凭据带进工具错误。
    throw new Error('cameras.json 不是有效 JSON，请修复配置。');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some((key) => key !== 'cameras')) {
    throw new Error('摄像头配置根对象只允许 cameras 字段。');
  }
  return validateCameras(config.cameras);
}

/** 返回面向 MCP 的目录；不包含设备地址、通道或凭据。 */
export function listCameras() {
  return cameraCatalog().map(({ id, name }) => ({ id, name }));
}

/** Saved IDs win over discovery: never silently remap an existing alias or cache key. */
export function cameraCatalog(saved = readCameras(), paths = mediaChannelDiscovery.paths()) {
  const result = [...saved], used = new Set(saved.flatMap(camera => [camera.id, camera.name]));
  const mapped = new Set(saved.map(camera => camera.archivePath || camera.id));
  for (const archivePath of [...new Set(paths)].sort()) {
    if (mapped.has(archivePath)) continue;
    let id = archivePath;
    if (used.has(id)) id = `mtx-${createHash('sha256').update(archivePath).digest('hex').slice(0, 32)}`;
    // In the exceptionally rare event that an administrator already uses this ID,
    // preserve that explicit mapping instead of introducing an ambiguous alias.
    if (used.has(id)) continue;
    let name = used.has(archivePath) ? `${archivePath}（MediaMTX）` : archivePath;
    if (used.has(name)) name = id;
    result.push({ id, name, archivePath }); used.add(id); used.add(name);
  }
  return result;
}

/** 内部查询映射；调用方不能把整个结果直接返回给 MCP。 */
export function getCamera(id) {
  return cameraCatalog().find((camera) => camera.id === id || camera.name === id) || null;
}

/** 服务端内部解析 DVR 凭据；不切换当前 Web 激活设备。 */
export function resolveCamera(alias) {
  const camera = getCamera(alias);
  if (!camera) throw new Error('摄像头不存在，请先查看 list_cameras。');
  if (!camera.deviceId) return { camera, device: null };
  const device = getDeviceById(camera.deviceId);
  if (!device) throw new Error('摄像头关联的 DVR 已不存在，请修复摄像头配置。');
  return { camera, device };
}

/** 原子替换完整目录；先验证全部引用，失败时保留原配置。 */
export function saveCameras(cameras) {
  readCameras(); // Never overwrite malformed existing configuration.
  const normalized = validateCameras(cameras);
  for (const camera of normalized) {
    if (camera.deviceId && !getDeviceById(camera.deviceId)) {
      throw new Error('摄像头关联的 DVR 不存在，请先在 Web 界面添加设备。');
    }
  }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temporary = `${DATA_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ cameras: normalized }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, DATA_FILE);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return listCameras();
}
