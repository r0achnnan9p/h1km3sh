import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUploadQueue } from '../lib/match-workflow.js';
import { createCloud189Queue } from '../lib/cloud189-queue.js';
test('managed enqueue binds server generation and rejects a draft after account replacement', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-binding-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.writeFileSync(path.join(root, 'test.mp4'), 'video');
  let generation = 'a'.repeat(32);
  const bili = createUploadQueue(root, { getConnectionGeneration: () => generation }), cloud = createCloud189Queue(root, { getConnectionGeneration: () => generation });
  const draft = bili.prepare({ filename: 'test.mp4', title: 'test', tid: 249, tags: ['足球'], onlySelf: true });
  assert.equal(draft.connectionGeneration, generation);
  assert.equal(cloud.enqueue({ filename: 'test.mp4', targetPath: '/足球' }).connectionGeneration, generation);
  generation = 'b'.repeat(32); assert.throws(() => bili.submit(draft.id, true), /账号连接已改变/);
  generation = null; assert.throws(() => cloud.enqueue({ filename: 'test.mp4', targetPath: '/足球' }), /重新连接/);
});
test('worker generation guards block old, absent and invalid bindings before network recovery', () => {
  const run = spawnSync('python3', [new URL('./upload-connection-binding-test.py', import.meta.url).pathname], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
