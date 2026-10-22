import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareMatchJob } from '../lib/match-job.js';
import { createMediaJobStore, mediaJobPage } from '../lib/media-job-store.js';
import { signDownload, verifyDownload } from '../lib/mcp-security.js';

test('指定 D2 只出一份，指定 D1/D2 才出两份；本地镜头先交付，不自动上传', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'match-job-')), previous = process.env.HIKVISION_ARTIFACT_DIR;
  process.env.HIKVISION_ARTIFACT_DIR = path.join(root, 'artifacts');
  try {
    const calls = [], downloadsDir = path.join(root, 'downloads'); fs.mkdirSync(downloadsDir);
    const args = { start: '2026-09-24 20:20', end: '2026-09-24 22:22', matchup: '天行者 队内' };
    const deps = { downloadsDir, resolveCamera: id => ({ camera: { id, archivePath: id }, device: { id: 'dvr', ip: '192.0.2.1' } }),
      archive: { hasRecording: async c => ({ exists: c.id === 'D2' }), cutClip: async (c, start, end, options) => {
        calls.push(c.id); fs.writeFileSync(options.outputFile, 'local'); return options.outputFile;
      } }, startHikvision: async () => { calls.push('D1'); const file = path.join(root, 'dvr.mp4'); fs.writeFileSync(file, 'dvr'); return file; } };
    const signal = new AbortController().signal;
    const one = await prepareMatchJob({ ...args, cameras: ['D2'] }, deps).execute({ signal, reservation: {} });
    assert.deepEqual(one.files.map(f => f.filename), ['天行者 队内 D2 2026-09-24.mp4']);
    fs.unlinkSync(path.join(downloadsDir, one.files[0].filename)); calls.length = 0;
    const two = await prepareMatchJob({ ...args, cameras: ['D1', 'D2'] }, deps).execute({ signal, reservation: {} });
    assert.deepEqual(calls, ['D2', 'D1']);
    assert.deepEqual(two.files.map(f => f.filename).sort(), ['天行者 队内 D1 2026-09-24.mp4', '天行者 队内 D2 2026-09-24.mp4']);
    assert.throws(() => prepareMatchJob({ ...args, cameras: ['D2', 'D2'] }, deps), /重复/);
  } finally {
    if (previous === undefined) delete process.env.HIKVISION_ARTIFACT_DIR; else process.env.HIKVISION_ARTIFACT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('任务持久化排除控制器和凭据，重启后中断状态不能谎称完成', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-'));
  try {
    const store = createMediaJobStore(root), taskId = '12345678-1234-1234-1234-123456789abc';
    store.save({ taskId, status: 'downloading', controller: {}, password: 'private', files: [] });
    assert.ok(!fs.readFileSync(path.join(root, `${taskId}.json`), 'utf8').includes('private'));
    assert.equal(store.read(taskId).status, 'error');
    store.save({ taskId, status: 'completed', files: [{ filename: '天行者 队内 D2.mp4' }] });
    assert.equal(createMediaJobStore(root).read(taskId).files.length, 1);
    assert.throws(() => store.read('../secret'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('只复用起止、镜头、模式和大小都匹配的已落盘文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reuse-'));
  try {
    const store = createMediaJobStore(path.join(root, 'jobs'));
    const file = { sourceIdentity: 'a'.repeat(64), filename: '天行者 队内 D2 2026-09-27.mp4', camera: 'D2', start: '2026-09-27 20:20:00', end: '2026-09-27 22:22:00', mode: 'copy', size: 5, artifactUrl: '/artifacts/videos/clips/12345678-1234-1234-1234-123456789abc.mp4' };
    fs.writeFileSync(path.join(root, file.filename), 'video');
    store.save({ taskId: '12345678-1234-1234-1234-123456789abc', status: 'downloading', files: [file] });
    assert.deepEqual(store.findFile(file, root), file, '整个任务仍在运行，已完成的单个文件也可复用');
    assert.deepEqual(store.findByRange(file, root), file, '未指定对阵名的单镜头请求也能找到已完成文件');
    assert.equal(store.findFile({ ...file, end: '2026-09-27 22:23:00' }, root), null);
    assert.equal(store.findFile({ ...file, mode: 'precise' }, root), null);
    fs.writeFileSync(path.join(root, file.filename), 'altered');
    assert.equal(store.findFile(file, root), null);
    assert.equal(store.findByRange(file, root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('自动结果页签名绑定任务，查询格式不扩大访问范围，页面自动查询不需要聊天催促', () => {
  const token = 'test-secret'.repeat(4), pathname = '/media-jobs/12345678-1234-1234-1234-123456789abc';
  const signed = signDownload(pathname, { token });
  assert.equal(verifyDownload(`${signed}&format=json`, { token }), true);
  assert.equal(verifyDownload(signed.replace('123456789abc', '123456789abd'), { token }), false);
  assert.ok(mediaJobPage().includes('setTimeout(refresh,3000)'));
  assert.ok(!mediaJobPage().includes('<img'));
});

test('DVR 限速时可切换全速回放，本地覆盖仍优先且非法方式拒绝', async () => {
  const { prepareCameraJob } = await import('../lib/camera-jobs.js');
  let local = false;
  const deps = { resolveCamera: () => ({ camera: { id: 'D1' }, device: { id: 'dvr', ip: '192.0.2.1' } }), archive: { hasRecording: async () => ({ exists: local }) }, startHikvision: async () => {} };
  const args = { camera: 'D1', start: '2026-09-24 20:20:00', end: '2026-09-24 22:22:00' };
  assert.equal((await prepareCameraJob('clip', args, deps).plan({})).method, 'mp4download');
  assert.equal((await prepareCameraJob('clip', { ...args, dvrMethod: 'rtspclip' }, deps).plan({})).method, 'rtspclip');
  local = true;
  assert.equal((await prepareCameraJob('clip', { ...args, dvrMethod: 'rtspclip' }, deps).plan({})).source, 'mediamtx');
  assert.throws(() => prepareCameraJob('clip', { ...args, dvrMethod: 'other' }, deps), /无效 DVR/);
});

for (const outcome of ['success', 'cancel', 'collision']) {
  const cancel = outcome !== 'success', collision = outcome === 'collision';
  test(`跨文件系统成品复制：${{ success: '异步完成后才交付', cancel: '取消等复制结束并清理自有成品', collision: '取消绝不删除 EXCL 冲突的旧成品' }[outcome]}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'match-final-copy-'));
    const previous = process.env.HIKVISION_ARTIFACT_DIR;
    process.env.HIKVISION_ARTIFACT_DIR = path.join(root, 'artifacts');
    const actualCopy = fs.promises.copyFile.bind(fs.promises);
    let startCopy, finishCopy;
    const started = new Promise(resolve => { startCopy = resolve; });
    const gate = new Promise(resolve => { finishCopy = resolve; });
    const controller = new AbortController(), delivered = [];
    let settled = false, execution;
    t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); });
    t.mock.method(fs, 'copyFileSync', () => assert.fail('cross-device delivery must not block the event loop'));
    t.mock.method(fs.promises, 'copyFile', async (source, destination, flags) => {
      assert.equal(flags, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE, 'existing output must remain protected while allowing filesystem cloning');
      startCopy();
      await gate;
      await actualCopy(source, destination, flags);
    });
    try {
      const downloadsDir = path.join(root, 'downloads');
      fs.mkdirSync(downloadsDir);
      const job = prepareMatchJob({ cameras: ['D1'], matchup: 'fixture', start: '2026-01-01 10:00', end: '2026-01-01 10:01' }, {
        downloadsDir, resolveCamera: id => ({ camera: { id }, device: { id: 'dvr', ip: '192.0.2.1' } }),
        archive: {
          hasRecording: async () => ({ exists: true }),
          cutClip: async (_camera, _start, _end, { outputFile }) => { fs.writeFileSync(outputFile, 'fixture'); return outputFile; },
        },
      });
      if (collision) fs.writeFileSync(path.join(downloadsDir, job.filenames[0]), 'existing');
      execution = job.execute({ signal: controller.signal, reservation: {}, onFile: file => delivered.push(file) });
      execution.then(() => { settled = true; }, () => { settled = true; });
      await Promise.race([started, execution.then(() => assert.fail('copy was not awaited'))]);
      if (cancel) controller.abort();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'job must retain ownership while the copy is in flight');
      assert.deepEqual(delivered, []);
      assert.equal(fs.readdirSync(path.join(root, 'artifacts', '.work')).length, 1, 'temporary work cannot be cleaned before the copy settles');
      finishCopy();
      if (cancel) {
        await assert.rejects(execution, collision ? { code: 'EEXIST' } : /任务已取消/);
        assert.deepEqual(delivered, []);
        if (collision) assert.equal(fs.readFileSync(path.join(downloadsDir, job.filenames[0]), 'utf8'), 'existing');
        else assert.deepEqual(fs.readdirSync(downloadsDir), [], 'cancelled named output is removed');
        assert.deepEqual(fs.readdirSync(path.join(root, 'artifacts', 'videos', 'clips')), [], 'cancelled artifact is removed');
      } else {
        const result = await execution;
        assert.equal(delivered.length, 1);
        assert.equal(result.files.length, 1);
        assert.equal(fs.readFileSync(path.join(downloadsDir, result.files[0].filename), 'utf8'), 'fixture');
      }
      assert.deepEqual(fs.readdirSync(path.join(root, 'artifacts', '.work')), []);
    } finally {
      finishCopy();
      await execution?.catch(() => {});
      if (previous === undefined) delete process.env.HIKVISION_ARTIFACT_DIR; else process.env.HIKVISION_ARTIFACT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
