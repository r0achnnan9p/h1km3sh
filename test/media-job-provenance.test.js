import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMediaJobStore } from '../lib/media-job-store.js';

test('completed copy provenance persists across restart, including completed files in a partial batch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-job-provenance-'));
  try {
    const store = createMediaJobStore(root);
    const alias = { source: { relativePath: 'camera_0123456789abcdef/source.mp4', identity: { ino: 10 } },
      target: { relativePath: 'friendly.mp4', identity: { ino: 20 } } };
    store.save({ taskId: '11111111-1111-1111-1111-111111111111', kind: 'clip', status: 'completed', outputAlias: alias });
    store.save({ taskId: '22222222-2222-2222-2222-222222222222', kind: 'batch', status: 'error', files: [{ outputAlias: alias }] });
    store.save({ taskId: '33333333-3333-3333-3333-333333333333', kind: 'clip', status: 'error', outputAlias: alias });
    store.save({ taskId: '44444444-4444-4444-4444-444444444444', kind: 'clip', status: 'completed', filename: 'historical.mp4', size: 11 });
    fs.writeFileSync(path.join(root, '55555555-5555-5555-5555-555555555555.json'), '{broken');
    assert.deepEqual(createMediaJobStore(root).outputAliases(), [alias, alias]);
    assert.deepEqual(createMediaJobStore(root).read('11111111-1111-1111-1111-111111111111').outputAlias, alias);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
