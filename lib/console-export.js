import { sdkEnabled } from './dvr-sdk.js';
import { wallRange } from './camera-time.js';
import { deviceEndpointIdentity } from './device-endpoint.js';
import crypto from 'node:crypto';
import { prepareCameraJob } from './camera-jobs.js';

/** Resolve console selections on the server; DVR channels do not need an archive alias. */
export function prepareConsoleExport(args, { getDevice, ...dependencies }) {
  if (!args || typeof args !== 'object') throw new Error('请选择回放来源和通道。');
  const source = args.source || 'mediamtx'; // Existing clients use the alias-based path.
  if (!['mediamtx', 'hikvision'].includes(source)) throw new Error('无效的回放来源。');
  if (source === 'mediamtx') return prepareCameraJob('clip', { ...args, mode: 'copy' }, { ...dependencies, forceArchive: true });
  const device = typeof args.deviceId === 'string' && args.deviceId ? getDevice(args.deviceId) : null;
  if (!device) throw new Error('未配置或未找到所选 DVR；请先添加并选择录像机。');
  if (sdkEnabled(device)) {
    const { startMs, endMs } = wallRange(args.start, args.end);
    if (endMs - startMs > 3600000) throw new Error('此录像机使用 SDK 按时段导出，每次最多 1 小时；请缩短时间范围。');
  }
  const channel = String(args.channel || '');
  if (!/^\d{1,8}$/.test(channel)) throw new Error('请选择有效的 DVR 通道。');
  // Stable, source-specific identity prevents cache/dedup collisions with MediaMTX aliases
  // or a different recorder that happens to have the same channel number.
  const key = crypto.createHash('sha256').update(`${device.id}|${deviceEndpointIdentity(device)}`).digest('hex').slice(0, 16);
  const camera = { id: `DVR-${key}-${channel}`, name: channel, deviceId: device.id, channel };
  const job = prepareCameraJob('clip', { ...args, camera: camera.id, mode: 'copy' }, {
    ...dependencies, forceDvr: true, resolveCamera: () => ({ camera, device }),
  });
  return { ...job, source: 'hikvision' };
}
