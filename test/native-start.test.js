import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function launch(t, seed = () => {}, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['scripts', 'lib', 'data', 'downloads', 'archive']) fs.mkdirSync(path.join(root, name));
  fs.copyFileSync(new URL('../scripts/native-start.js', import.meta.url), path.join(root, 'scripts/native-start.js'));
  fs.copyFileSync(new URL('../lib/sdk-runtime-profile.js', import.meta.url), path.join(root, 'lib/sdk-runtime-profile.js'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, '.release-sha'), 'a'.repeat(40));
  fs.writeFileSync(path.join(root, 'server.js'), "console.log(JSON.stringify({ host: process.env.HIKCLIP_BIND, publicPort: process.env.HIKCLIP_PUBLIC_PORT, fallback: process.env.HIKCLIP_PORT_FALLBACK, scheduler: process.env.HIKCLIP_SCHEDULER_ENABLED, upload: process.env.HIKVISION_BILIUP_ENABLED, sha: process.env.HIKCLIP_RELEASE_SHA, preparation: process.env.HIKCLIP_PREPARATION_ONLY }))");
  seed(root);
  return spawnSync(process.execPath, ['scripts/native-start.js'], { cwd: root, encoding: 'utf8', env: { ...process.env,
    HIKVISION_DATA_DIR: path.join(root, 'data'), HIKVISION_DOWNLOADS_DIR: path.join(root, 'downloads'),
    HIKVISION_ARTIFACT_DIR: path.join(root, 'data/artifacts'), HIKVISION_ARCHIVE_DIR: path.join(root, 'archive'),
    HIKVISION_RUNTIME_FILE: path.join(root, 'data/runtime.json'), HIKCLIP_BIND: '0.0.0.0', HIKCLIP_PORT_FALLBACK: '1',
    HIKCLIP_SCHEDULER_ENABLED: '1', HIKVISION_BILIUP_ENABLED: undefined, ...extraEnv } });
}
test('native preparation launcher overrides unsafe environment values', t => {
  const result = launch(t, root => fs.writeFileSync(path.join(root, 'data/devices.json'), '{"devices":[]}'), { HIKVISION_BILIUP_ENABLED: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { host: '127.0.0.1', publicPort: '30002', fallback: '0', scheduler: '0', upload: '0', sha: 'a'.repeat(40), preparation: '1' });
});
for (const [name, seed, error] of [
  ['device config', root => fs.writeFileSync(path.join(root, 'data/devices.json'), '{"devices":[{}]}'), /empty devices/],
  ['camera config', root => fs.writeFileSync(path.join(root, 'data/cameras.json'), '{"cameras":[{}]}'), /empty cameras/],
  ['recovery records', root => { fs.mkdirSync(path.join(root, 'data/export-queue')); fs.writeFileSync(path.join(root, 'data/export-queue/job.json'), '{}'); }, /export recovery/],
  ['upload worker state', root => { fs.mkdirSync(path.join(root, 'downloads/cloud189_work')); fs.writeFileSync(path.join(root, 'downloads/cloud189_work/worker-status.json'), '{}'); }, /cloud189_work state/],
]) test(`native preparation rejects copied ${name}`, t => {
  const result = launch(t, seed); assert.equal(result.status, 1); assert.match(result.stderr, error);
});

test('explicit commissioned profile accepts its own state without relaxing native safety controls', t => {
  const result = launch(t, root => {
    fs.writeFileSync(path.join(root, 'data/devices.json'), '{"devices":[{}]}');
    fs.mkdirSync(path.join(root, 'data/export-queue'));
    fs.writeFileSync(path.join(root, 'data/export-queue/job.json'), '{}');
  }, { HIKCLIP_PREPARATION_ONLY: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { host: '127.0.0.1', publicPort: '30002', fallback: '0', scheduler: '0', upload: '0', sha: 'a'.repeat(40), preparation: '0' });
});
test('native profile rejects ambiguous preparation flag', t => {
  const result = launch(t, () => {}, { HIKCLIP_PREPARATION_ONLY: 'yes' });
  assert.equal(result.status, 1); assert.match(result.stderr, /must be 0 or 1/);
});

for (const [flag, expected] of [[undefined, '0'], ['', '0'], ['0', '0'], ['1', '1'], ['true', '0'], ['yes', '0'], [' 1 ', '0']]) {
  test(`commissioned profile requires exact upload opt-in: ${JSON.stringify(flag)}`, t => {
    const result = launch(t, () => {}, { HIKCLIP_PREPARATION_ONLY: '0', HIKVISION_BILIUP_ENABLED: flag });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { host: '127.0.0.1', publicPort: '30002', fallback: '0', scheduler: '0', upload: expected,
      sha: 'a'.repeat(40), preparation: '0' });
  });
}

test('managed uploader capability requires an installed explicit profile and commissioning', t => {
  function profile(root) {
    fs.mkdirSync(path.join(root, 'upload-tools'));
    fs.writeFileSync(path.join(root, 'upload-tools/manifest.json'), JSON.stringify({ profile: 'managed-uploads-v1', platform: 'linux-x64' }));
    fs.writeFileSync(path.join(root, 'server.js'), 'console.log(process.env.HIKCLIP_MANAGED_UPLOADS_ENABLED)');
  }
  assert.equal(launch(t, profile).stdout.trim(), '0');
  assert.equal(launch(t, profile, { HIKCLIP_PREPARATION_ONLY: '0' }).stdout.trim(), '1');
  assert.equal(launch(t, profile, { HIKCLIP_PREPARATION_ONLY: '0', HIKCLIP_MANAGED_UPLOADS_ENABLED: '0' }).stdout.trim(), '0');
  const invalid = launch(t, profile, { HIKCLIP_MANAGED_UPLOADS_ENABLED: 'yes' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /must be 0 or 1/);
});

test('native preparation clears inherited SDK activation before server import', t => {
  const result = launch(t, root => {
    fs.writeFileSync(path.join(root, 'server.js'), 'console.log(JSON.stringify({ enabled: process.env.HIKVISION_SDK_ENABLED, dir: process.env.HIKVISION_SDK_DIR, ids: process.env.HIKVISION_SDK_DEVICE_IDS }))');
  }, { HIKVISION_SDK_ENABLED: '1', HIKVISION_SDK_DIR: '/unapproved/lib', HIKVISION_SDK_DEVICE_IDS: '*' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { enabled: '0' });
});
