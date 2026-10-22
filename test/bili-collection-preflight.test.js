import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('Bili read-only ownership/collection preflight blocks upload before any remote submission', () => {
  const run = spawnSync('python3', [new URL('./bili-collection-preflight-test.py', import.meta.url).pathname], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
