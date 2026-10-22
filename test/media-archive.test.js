import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMediaArchive, coverageSlices, segmentStart, runMedia } from '../lib/media-archive.js';
import { wallTime } from '../lib/camera-time.js';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';
import { artifactRoot, isArtifactPath } from '../lib/artifacts.js';

let root;
const previous = process.env.HIKVISION_ARTIFACT_DIR;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-archive-test-'));
  process.env.HIKVISION_ARTIFACT_DIR = path.join(root, 'artifacts');
});
after(() => {
  if (previous === undefined) delete process.env.HIKVISION_ARTIFACT_DIR;
  else process.env.HIKVISION_ARTIFACT_DIR = previous;
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('media-archive-test-'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('文件名解析微秒与跨日，拒绝无效日期', () => {
  assert.equal(segmentStart('2026-09-24_23-59-58-500000.mp4'), wallTime('2026-09-24 23:59:58') + 500);
  assert.equal(segmentStart('2026-02-30_20-00-00.mp4'), null);
  assert.equal(segmentStart('private.mp4'), null);
  assert.throws(() => wallTime('2026-09-24T20:00:00Z'));
});

test('完整覆盖、重叠消除、缺口与首尾不足', () => {
  const segments = [{ file: 'a', startMs: 0, endMs: 4000 }, { file: 'b', startMs: 3000, endMs: 7000 }];
  const slices = coverageSlices(segments, 1000, 6000);
  assert.deepEqual(slices.map(({ offset, duration }) => ({ offset, duration })), [{ offset: 1, duration: 3 }, { offset: 1, duration: 2 }]);
  assert.deepEqual(coverageSlices(segments, -1, 6000), []);
  assert.deepEqual(coverageSlices(segments, 1000, 8000), []);
  assert.deepEqual(coverageSlices([{ startMs: 0, endMs: 1000 }, { startMs: 1001, endMs: 3000 }], 0, 2000), []);
});

test('未配置目录时无本地录像，路径越界直接拒绝', async () => {
  const archive = createMediaArchive({ root });
  assert.equal((await archive.hasRecording({}, '2026-09-24 20:00', '2026-09-24 20:01')).exists, false);
  await assert.rejects(archive.hasRecording({ archivePath: '../private' }, '2026-09-24 20:00', '2026-09-24 20:01'), /无效/);
});

test('真实 ffmpeg 进度包含输出速率', async () => {
  const output = path.join(root, 'progress.mp4'), updates = [];
  await runMedia(ffmpegPath, ['-progress', 'pipe:1', '-nostats', '-v', 'error', '-y', '-re', '-f', 'lavfi', '-i',
    'testsrc2=s=320x180:r=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', output], {
    durationSeconds: 2,
    onProgress: (progress, speed) => updates.push({ progress, speed }),
  });
  assert.ok(updates.some(item => item.progress > 0), '应报告成片进度');
  assert.ok(updates.some(item => Number.isFinite(item.speed) && item.speed > 0), '应报告导出 Mbps 所需的字节速率');
});

test('真实 ffmpeg：跨午夜分片截图、时间标注拼图与精确裁剪', async () => {
  const directory = path.join(root, 'd1');
  fs.mkdirSync(directory);
  for (const [name, color] of [
    ['2026-09-24_23-59-58-500000.mp4', 'red'], ['2026-09-25_00-00-01-500000.mp4', 'blue'],
  ]) {
    await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=10`,
      '-t', '3', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', path.join(directory, name)]);
  }
  const archive = createMediaArchive({ root });
  const camera = { archivePath: 'd1' };
  const found = await archive.hasRecording(camera, '2026-09-24 23:59:59', '2026-09-25 00:00:04');
  assert.equal(found.exists, true);
  assert.equal(found.files.length, 2);
  assert.equal((await archive.hasRecording(camera, '2026-09-24 23:59:58', '2026-09-25 00:00:04')).exists, false);
  const shot = await archive.getSnapshot(camera, '2026-09-25 00:00:02');
  assert.ok(isArtifactPath(shot.relative));
  const sheet = await archive.createTimelineSheet(camera, { date: '2026-09-24', start: '23:59:59', interval: 1, count: 4 });
  assert.ok(fs.statSync(path.join(artifactRoot(), sheet.relative)).size > 1000);
  const clip = await archive.cutClip(camera, '2026-09-24 23:59:59', '2026-09-25 00:00:04');
  const { stdout } = await runMedia(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path.join(artifactRoot(), clip.relative)]);
  assert.ok(Math.abs(Number(JSON.parse(stdout).format.duration) - 5) < 0.15);
  await assert.rejects(archive.createTimelineSheet(camera, { date: '2026-09-24', start: '23:59:59', interval: 1, count: 37 }), /count/);
  await assert.rejects(archive.getSnapshot(camera, '2026-09-25 00:00:05'), /没有/);
  assert.deepEqual(fs.readdirSync(path.join(artifactRoot(), '.work')), []);
});

test('artifact 下载范围不包含临时文件与任意路径', () => {
  for (const value of ['.work/job-a/frame.png', '../devices.json', 'images/snapshot/../../devices.json', 'videos/clips/a.hikraw']) {
    assert.equal(isArtifactPath(value), false);
  }
});

test('真实跨分片 copy：保留原始 H264 包与 AAC，边界误差限于一个 GOP', async () => {
  const directory = path.join(root, 'copy');
  fs.mkdirSync(directory);
  const inputs = [];
  for (const [name, color] of [['2026-09-24_20-00-00.mp4', 'red'], ['2026-09-24_20-00-04.mp4', 'blue']]) {
    const file = path.join(directory, name); inputs.push(file);
    await runMedia(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=10`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-c:a', 'aac',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', file]);
  }
  const archive = createMediaArchive({ root });
  const result = await archive.cutClip({ archivePath: 'copy' }, '2026-09-24 20:00:01', '2026-09-24 20:00:07', { mode: 'copy' });
  const output = path.join(artifactRoot(), result.relative);
  const { stdout } = await runMedia(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', output]);
  const probe = JSON.parse(stdout);
  assert.deepEqual(probe.streams.map(s => s.codec_name), ['h264', 'aac']);
  assert.ok(Math.abs(Number(probe.format.duration) - 6) < 1.2);
  const hashes = async file => {
    const raw = `${file}.h264`;
    await runMedia(ffmpegPath, ['-v', 'error', '-y', '-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', raw]);
    const bytes = fs.readFileSync(raw), boundaries = [];
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) boundaries.push(i);
    }
    // MP4 concat 会在 IDR 前补 SPS/PPS；只比较真正的 I/P 图像 NAL。
    return boundaries.flatMap((start, index) => {
      let end = boundaries[index + 1] ?? bytes.length;
      while (end > start + 3 && bytes[end - 1] === 0) end--;
      const nal = bytes.subarray(start + 3, end), type = nal[0] & 31;
      return [1, 5].includes(type) ? [crypto.createHash('sha256').update(nal).digest('hex')] : [];
    });
  };
  const original = new Set((await Promise.all(inputs.map(hashes))).flat());
  const copied = await hashes(output);
  assert.ok(copied.length >= 50);
  assert.ok(copied.every(hash => original.has(hash)), '输出视频包必须逐字节来自原录像，不得转码');
});
