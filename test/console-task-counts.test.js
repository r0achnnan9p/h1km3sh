import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createCloud189Queue } from '../lib/cloud189-queue.js';
import { createUploadQueue } from '../lib/match-workflow.js';
for (const [provider, createQueue, folder] of [['cloud189', createCloud189Queue, 'cloud189_work'], ['bilibili', createUploadQueue, 'biliup_work']]) {
  test(provider + ' count includes more than 50 active uploads, old active jobs hidden by history and completion to zero', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-count-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, folder, 'jobs'); fs.mkdirSync(directory, { recursive: true });
    const file = index => path.join(directory, '00000000-0000-0000-0000-' + String(index).padStart(12, '0') + '.json');
    for (let i = 0; i < 51; i++) fs.writeFileSync(file(i), JSON.stringify({ id: i, filename: i + '.mp4', status: 'queued', createdAt: '2000-01-01' }));
    const queue = createQueue(root); assert.equal(queue.activeCount(), 51); assert.equal(queue.list({ limit: 50 }).length, 50);
    for (let i = 51; i < 121; i++) fs.writeFileSync(file(i), JSON.stringify({ id: i, filename: i + '.mp4', status: 'completed', createdAt: '2026-10-06' }));
    assert.ok(queue.list({ limit: 50 }).every(job => job.status === 'completed')); assert.equal(queue.activeCount(), 51);
    for (let i = 0; i < 51; i++) fs.writeFileSync(file(i), JSON.stringify({ id: i, status: 'completed' }));
    assert.equal(queue.activeCount(), 0);
    fs.writeFileSync(file(999), JSON.stringify({ status: 'uploading', archivedAt: '2026-10-06' })); fs.writeFileSync(file(998), '{bad'); assert.equal(queue.activeCount(), 0);
  });
}
test('bootstrap and task/SSE snapshot expose complete counts without changing history arrays', () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const context = { getAllDevices: () => ({}), activeTasks: new Map(), exportQueue: { owns: () => false }, uploadQueue: { activeCount: () => 51 }, cloud189Queue: { activeCount: () => 23 }, consoleUploadJobs: () => [{ status: 'completed' }], readConsoleSettings: () => ({}), consoleIntegrations: () => ({}), configSnapshot: () => ({ revision: 'r1' }), statusPasswordStore: { isManaged: () => false }, consoleCameras: () => [], consoleDvrDevices: () => [], consoleOutputs: () => [] };
  vm.createContext(context); vm.runInContext(source.slice(source.indexOf('function getDashboardStatus()'), source.indexOf("app.post('/api/bilibili/prepare'")), context);
  vm.runInContext(source.slice(source.indexOf('function consoleBootstrap()'), source.indexOf('const dvrHttpSamplePrivateRoot')), context);
  for (const payload of [context.getDashboardStatus(), context.consoleBootstrap()]) { assert.equal(payload.activeTaskCount, 74); assert.equal(payload.exportActiveTaskCount, 0); assert.equal(payload.uploadActiveTaskCount, 74); assert.equal(payload.uploads.length, 1); assert.equal(payload.tasks.length, 0); }
  assert.match(source, /res\.json\(\{ success: true, \.\.\.getDashboardStatus\(\)/);
});
