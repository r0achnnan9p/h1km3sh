import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applySdkRuntimeProfile, SDK_ARCHIVE_SHA256 } from '../lib/sdk-runtime-profile.js';
const id = '11111111-2222-4333-8444-555555555555';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'hik-sdk');
  fs.mkdirSync(path.join(sdk, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'lib/libhcnetsdk.so'), 'fixture');
  const manifest = { profile: 'hik-sdk-v1', platform: 'linux-x64', archiveSha256: SDK_ARCHIVE_SHA256, deviceIds: [id] };
  const save = () => fs.writeFileSync(path.join(sdk, 'manifest.json'), JSON.stringify(manifest));
  save();
  const env = { HIKVISION_SDK_DIR: '/unapproved/lib', HIKVISION_SDK_DEVICE_IDS: '*' };
  const run = (preparationOnly = '0') => applySdkRuntimeProfile({ releaseRoot: root, preparationOnly, env, platform: 'linux', arch: 'x64' });
  return { root, sdk, manifest, save, env, run };
}
test('commissioned profile binds exact release library and device UUID', t => {
  const f = fixture(t); f.run();
  assert.deepEqual(f.env, { HIKVISION_SDK_ENABLED: '1', HIKVISION_SDK_DIR: path.join(f.sdk, 'lib'), HIKVISION_SDK_DEVICE_IDS: id });
});
test('preparation clears inherited SDK paths and scope', t => {
  const f = fixture(t); f.env.HIKVISION_SDK_ENABLED = '1'; f.run('1');
  assert.deepEqual(f.env, { HIKVISION_SDK_ENABLED: '0' });
});
test('explicit disabled flag overrides installed profile', t => {
  const f = fixture(t); f.env.HIKVISION_SDK_ENABLED = '0'; f.run();
  assert.deepEqual(f.env, { HIKVISION_SDK_ENABLED: '0' });
});
test('missing profile cannot be enabled through environment', t => {
  const f = fixture(t); fs.rmSync(f.sdk, { recursive: true }); f.env.HIKVISION_SDK_ENABLED = '1'; f.run();
  assert.deepEqual(f.env, { HIKVISION_SDK_ENABLED: '0' });
});
for (const [name, mutate] of [
  ['wildcard', m => m.deviceIds = ['*']], ['address', m => m.deviceIds = ['192.0.2.23']],
  ['empty', m => m.deviceIds = []], ['duplicate', m => m.deviceIds = [id, id]],
  ['path override', m => m.libraryDir = '/tmp/lib'], ['wrong pin', m => m.archiveSha256 = '0'.repeat(64)],
  ['wrong platform', m => m.platform = 'win32-x64'], ['wrong profile', m => m.profile = 'hik-sdk-v2'],
]) test(`rejects invalid SDK manifest ${name}`, t => {
  const f = fixture(t); mutate(f.manifest); f.save(); assert.throws(() => f.run(), /Invalid Hikvision/);
});
for (const relative of ['manifest.json', 'lib/libhcnetsdk.so', 'lib']) {
  test(`rejects symlink at SDK ${relative}`, t => {
    const f = fixture(t); const target = path.join(f.sdk, relative), other = path.join(f.root, 'other');
    fs.renameSync(target, other); fs.symlinkSync(other, target);
    assert.throws(() => f.run(), /Invalid Hikvision/);
  });
}
test('offline archive packaging tests', () => {
  const r = spawnSync('python3', [new URL('./stage-hik-sdk-test.py', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
