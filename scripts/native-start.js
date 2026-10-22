/** Native new-CT profile. Starts in preparation mode until explicitly commissioned. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySdkRuntimeProfile } from '../lib/sdk-runtime-profile.js';
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Native staging requires Node.js 24');
for (const key of ['HIKVISION_DATA_DIR', 'HIKVISION_DOWNLOADS_DIR', 'HIKVISION_ARTIFACT_DIR', 'HIKVISION_ARCHIVE_DIR', 'HIKVISION_RUNTIME_FILE']) {
  if (!process.env[key] || !path.isAbsolute(process.env[key])) throw new Error(`${key} must be an explicit absolute path`);
}
// Protect the main API and disable scheduler; managed capability is opt-in below.
Object.assign(process.env, { NODE_ENV: 'production', PORT: '30001', HIKCLIP_BIND: '127.0.0.1',
  HIKCLIP_PUBLIC_PORT: '30002', HIKCLIP_PORT_FALLBACK: '0', HIKCLIP_SCHEDULER_ENABLED: '0' });
const preparationOnly = process.env.HIKCLIP_PREPARATION_ONLY ?? '1';
if (!['0', '1'].includes(preparationOnly)) throw new Error('HIKCLIP_PREPARATION_ONLY must be 0 or 1');
process.env.HIKCLIP_PREPARATION_ONLY = preparationOnly;
applySdkRuntimeProfile({ releaseRoot: fileURLToPath(new URL('../', import.meta.url)), preparationOnly });
// Commissioning alone does not authorize uploads. Only an explicit local opt-in
// enables admission, still subject to the live worker readiness checks.
process.env.HIKVISION_BILIUP_ENABLED = preparationOnly === '0' && process.env.HIKVISION_BILIUP_ENABLED === '1' ? '1' : '0';
// An approved release manifest opts into managed capabilities, never account
// authorization or queue execution. Settings still require explicit enablement.
const toolManifest = new URL('../upload-tools/manifest.json', import.meta.url);
const managedFlag = process.env.HIKCLIP_MANAGED_UPLOADS_ENABLED;
if (managedFlag !== undefined && !['0', '1'].includes(managedFlag)) throw new Error('HIKCLIP_MANAGED_UPLOADS_ENABLED must be 0 or 1');
let managedProfile = false;
if (fs.existsSync(toolManifest)) {
  const manifest = JSON.parse(fs.readFileSync(toolManifest, 'utf8'));
  managedProfile = manifest.profile === 'managed-uploads-v1' && manifest.platform === 'linux-x64';
  if (!managedProfile) throw new Error('Invalid managed uploader release profile');
}
process.env.HIKCLIP_MANAGED_UPLOADS_ENABLED = preparationOnly === '0' && managedProfile && managedFlag !== '0' ? '1' : '0';
const commissioningHint = ' Set HIKCLIP_PREPARATION_ONLY=0 only after authorized instance commissioning, before adding its own sources; never copy another deployment state.';
if (preparationOnly === '1') {
  // Preparation must never consume a copied DVR/MTX source, queue, or worker identity.
  // Application-created auth/runtime files may persist between staging releases.
  for (const file of ['devices.json', 'cameras.json']) {
    const target = path.join(process.env.HIKVISION_DATA_DIR, file);
    if (fs.existsSync(target)) {
      const data = JSON.parse(fs.readFileSync(target, 'utf8'));
      const entries = data[file === 'devices.json' ? 'devices' : 'cameras'];
      if (!Array.isArray(entries) || entries.length) throw new Error(`Preparation requires an empty ${file}.${commissioningHint}`);
    }
  }
  for (const relative of ['biliup_work', 'cloud189_work']) {
    const directory = path.join(process.env.HIKVISION_DOWNLOADS_DIR, relative);
    if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error(`Preparation forbids ${relative} state.${commissioningHint}`);
  }
  const recovery = path.join(process.env.HIKVISION_DATA_DIR, 'export-queue');
  if (fs.existsSync(recovery) && fs.readdirSync(recovery).some(name => name.endsWith('.json'))) throw new Error(`Preparation forbids copied export recovery records.${commissioningHint}`);
}
const release = fs.readFileSync(new URL('../.release-sha', import.meta.url), 'utf8').trim();
if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('Missing exact release SHA');
process.env.HIKCLIP_RELEASE_SHA = release;
await import('../server.js');
