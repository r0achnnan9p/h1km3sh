/** Credential-free provenance for editable camera/DVR/archive mappings. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { deviceEndpointIdentity } from './device-endpoint.js';

export function cameraSourceIdentity(camera, device, config = {}) {
  let archiveRoot = config.archiveRoot ? path.resolve(String(config.archiveRoot)) : '';
  if (archiveRoot) { try { archiveRoot = fs.realpathSync(archiveRoot); } catch {} }
  let playbackUrl = config.playbackUrl || '';
  if (playbackUrl) {
    const url = new URL(playbackUrl);
    // Credentials are not source identity and must never enter saved metadata.
    url.username = ''; url.password = ''; playbackUrl = url.toString();
  }
  const source = {
    version: 1, camera: String(camera.id || ''), deviceId: String(device?.id || ''),
    endpoint: device ? deviceEndpointIdentity(device) : '', channel: String(camera.channel || ''),
    archivePath: String(camera.archivePath || ''), archiveRoot, playbackUrl,
  };
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
export function validSourceIdentity(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
