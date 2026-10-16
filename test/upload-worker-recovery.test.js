import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const script of ['biliup-worker-test.py', 'upload-worker-recovery-test.py']) {
  test(`offline host upload worker checks: ${script}`, { skip: process.platform === 'win32' ? 'Host workers use POSIX advisory locks' : false }, () => {
    const result = spawnSync('python3', [path.join(root, 'test', script)], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
