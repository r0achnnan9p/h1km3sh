/** Validated DVR endpoints. Legacy host:port means HTTP only, never RTSP. */
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export function normalizePort(value, fallback, label = 'port') {
  if (value === undefined) return fallback;
  if (!((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value)))) throw new Error(`Invalid ${label}`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(`Invalid ${label}`);
  return port;
}

export function normalizeDeviceEndpoint(input) {
  const value = typeof input === 'string' ? { ip: input } : input;
  if (!value || typeof value.ip !== 'string' || !value.ip || /[\s/@?#\\%]/.test(value.ip)) throw new Error('Invalid DVR address');
  let ip = value.ip, legacyPort;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(ip);
  if (bracketed) {
    if (isIP(bracketed[1]) !== 6) throw new Error('Invalid DVR address');
    ip = bracketed[1]; legacyPort = bracketed[2];
  } else if (isIP(ip) !== 6 && ip.includes(':')) {
    const match = /^([^:]+):(\d+)$/.exec(ip);
    if (!match) throw new Error('Invalid DVR address');
    ip = match[1]; legacyPort = match[2];
  }
  if (!isIP(ip) && !(ip.length <= 253 && ip.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))) throw new Error('Invalid DVR address');
  const httpPort = normalizePort(value.httpPort === undefined ? legacyPort : value.httpPort, 80, 'HTTP port');
  if (legacyPort !== undefined && value.httpPort !== undefined && Number(legacyPort) !== httpPort) throw new Error('Conflicting HTTP ports');
  return { ip: ip.toLowerCase(), httpPort, rtspPort: normalizePort(value.rtspPort, 554, 'RTSP port') };
}
const host = ip => isIP(ip) === 6 ? `[${ip}]` : ip;
export function deviceHttpOrigin(value) {
  const endpoint = normalizeDeviceEndpoint(value);
  return `http://${host(endpoint.ip)}${endpoint.httpPort === 80 ? '' : `:${endpoint.httpPort}`}`;
}
export function deviceRtspAuthority(value) {
  const endpoint = normalizeDeviceEndpoint(value);
  return `${host(endpoint.ip)}:${endpoint.rtspPort}`;
}
export function deviceEndpointIdentity(value) {
  const endpoint = normalizeDeviceEndpoint(value);
  return `${host(endpoint.ip)}|${endpoint.httpPort}|${endpoint.rtspPort}`;
}
export function deviceCacheKey(value) {
  return createHash('sha256').update(`${value.deviceId || value.id || ''}|${deviceEndpointIdentity(value)}`).digest('hex').slice(0, 24);
}
