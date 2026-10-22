/** Release-local SDK opt-in. Never derive device scope from a name or IP. */
import fs from 'node:fs';
import path from 'node:path';

export const SDK_ARCHIVE_SHA256 = '964bd4d4e470aa6865c2c50d8c149753452a1853a070cbd435f91fb19c1e6d35';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => { throw new Error('Invalid Hikvision SDK release profile'); };

export function applySdkRuntimeProfile({ releaseRoot, preparationOnly, env = process.env, platform = process.platform, arch = process.arch }) {
  if (!path.isAbsolute(releaseRoot) || !['0', '1'].includes(preparationOnly)) invalid();
  const flag = env.HIKVISION_SDK_ENABLED;
  if (flag !== undefined && !['0', '1'].includes(flag)) invalid();
  // Inherited paths and scopes can never bypass a reviewed release profile.
  delete env.HIKVISION_SDK_DIR;
  delete env.HIKVISION_SDK_DEVICE_IDS;
  env.HIKVISION_SDK_ENABLED = '0';
  const sdkRoot = path.join(releaseRoot, 'hik-sdk');
  let sdkStat;
  try { sdkStat = fs.lstatSync(sdkRoot); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!sdkStat.isDirectory() || sdkStat.isSymbolicLink()) invalid();
  const manifestPath = path.join(sdkRoot, 'manifest.json');
  if (!fs.lstatSync(manifestPath).isFile()) invalid();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(',') !== 'archiveSha256,deviceIds,platform,profile'
    || manifest.profile !== 'hik-sdk-v1' || manifest.platform !== 'linux-x64'
    || manifest.archiveSha256 !== SDK_ARCHIVE_SHA256
    || !Array.isArray(manifest.deviceIds) || !manifest.deviceIds.length || manifest.deviceIds.length > 64
    || manifest.deviceIds.some(id => typeof id !== 'string' || !UUID.test(id))
    || new Set(manifest.deviceIds).size !== manifest.deviceIds.length) invalid();
  const libraryPath = path.join(sdkRoot, 'lib');
  if (!fs.lstatSync(libraryPath).isDirectory()
    || fs.realpathSync(libraryPath) !== path.join(fs.realpathSync(releaseRoot), 'hik-sdk', 'lib')
    || !fs.lstatSync(path.join(libraryPath, 'libhcnetsdk.so')).isFile()) invalid();
  if (preparationOnly !== '0' || flag === '0') return;
  if (platform !== 'linux' || arch !== 'x64') invalid();
  env.HIKVISION_SDK_DIR = libraryPath;
  env.HIKVISION_SDK_DEVICE_IDS = manifest.deviceIds.join(',');
  env.HIKVISION_SDK_ENABLED = '1';
}
