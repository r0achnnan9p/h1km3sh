import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
for (const file of ['managed-upload-tools-test.py', 'managed-cloud189-worker-test.py']) {
  test(`managed uploader offline checks: ${file}`, { skip: process.platform === 'win32' }, () => {
    const run = spawnSync('python3', [new URL(file, import.meta.url).pathname], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  });
}
