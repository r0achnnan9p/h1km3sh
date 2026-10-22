/** Bounded read-only ISAPI checks. Never includes subprocess stderr or credentials in errors. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import xml2js from 'xml2js';
import { deviceHttpOrigin } from './device-endpoint.js';
const run = promisify(execFile);
export async function probeDevice(device, { runImpl = run } = {}) {
  const started = Date.now();
  async function get(endpoint) {
    const remaining = 10_000 - (Date.now() - started);
    if (remaining < 1) throw new Error('Device test failed');
    try {
      const { stdout } = await runImpl('curl', ['--silent', '--show-error', '--fail', '--digest', '--user', `${device.username}:${device.password}`,
        '--connect-timeout', '3', '--max-time', String(remaining / 1000), '--max-filesize', '1048576', '--proto', '=http,https', `${deviceHttpOrigin(device)}${endpoint}`], { timeout: remaining + 100, maxBuffer: 1048576 });
      return await new xml2js.Parser({ explicitArray: false }).parseStringPromise(stdout);
    } catch (error) { throw Object.assign(new Error('Device test failed'), { code: /(?:returned error:|HTTP[^\n]*)\s*401\b/.test(String(error?.stderr || '')) ? 'DVR_AUTH_FAILED' : 'DVR_PROBE_FAILED' }); }
  }
  const info = (await get('/ISAPI/System/deviceInfo')).DeviceInfo;
  const listing = (await get('/ISAPI/Streaming/channels')).StreamingChannelList;
  if (!info || !listing) throw new Error('Device test failed');
  const raw = listing.StreamingChannel;
  const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128) : '';
  const channels = (raw ? Array.isArray(raw) ? raw : [raw] : []).slice(0, 512).flatMap(c => /^\d{1,8}$/.test(String(c?.id || '')) ? [{ id: String(c.id), name: clean(c.channelName) || String(c.id) }] : []);
  return { deviceInfo: { name: clean(info.deviceName), model: clean(info.model) }, channels };
}

/** A single current JPEG, not a playback session or continuous stream. */
export async function snapshotDevice(device, channel, { runImpl = run } = {}) {
  if (typeof channel !== 'string' || !/^\d{1,8}$/.test(channel)) throw new Error('Invalid device channel');
  try {
    const { stdout } = await runImpl('curl', ['--silent', '--show-error', '--fail', '--digest', '--user', `${device.username}:${device.password}`,
      '--connect-timeout', '3', '--max-time', '8', '--max-filesize', '4194304', '--proto', '=http,https',
      `${deviceHttpOrigin(device)}/ISAPI/Streaming/channels/${channel}/picture`], { timeout: 8100, maxBuffer: 4194304, encoding: 'buffer' });
    // Never send an upstream HTML/XML error page or another active content type.
    if (!Buffer.isBuffer(stdout) || stdout.length < 4 || stdout.length > 4194304 || stdout[0] !== 0xff || stdout[1] !== 0xd8 || stdout.at(-2) !== 0xff || stdout.at(-1) !== 0xd9) throw new Error('Invalid snapshot');
    return `data:image/jpeg;base64,${stdout.toString('base64')}`;
  } catch (error) { throw Object.assign(new Error('Device snapshot failed'), { code: /(?:returned error:|HTTP[^\n]*)\s*401\b/.test(String(error?.stderr || '')) ? 'DVR_AUTH_FAILED' : 'DVR_SNAPSHOT_FAILED' }); }
}
