import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';
import { runRtspClipExport } from '../lib/rtsp-clip-export.js';
import { setProgressStatusHook } from '../lib/progress-reporter.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-video-only-')), outputDir = path.join(root, 'output');
  fs.mkdirSync(outputDir);
  t.after(() => { setProgressStatusHook(null); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, outputDir, options: { ip: 'fixture.invalid', user: 'fixture', pass: 'fixture', channel: '201',
    startTime: '20260101T100000Z', endTime: '20260101T100003Z', outputDir, taskId: 'offline-export', sseClients: [], concurrency: 1 } };
}

test('video-only pull reaches a real validated H264 MP4 and removes intermediate files', async t => {
  const f = fixture(t), raw = path.join(f.root, 'source.h264');
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=20',
    '-t', '3', '-c:v', 'libx264', '-threads', '1', '-g', '20', '-bf', '0', '-f', 'h264', '-y', raw]);
  const output = await runRtspClipExport({ ...f.options, pullSegment: async ({ outPath, audioOutPath }) => {
    fs.copyFileSync(raw, outPath); fs.writeFileSync(audioOutPath, '');
    return { frames: 60, audioFrames: 0, meta: { tsDeltaMode: 4500, endReason: 'closed', audio: { codec: null } } };
  } });
  const probe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,nb_frames,duration', '-of', 'json', output], { encoding: 'utf8' }));
  assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].codec_name, 'h264');
  assert.equal(Number(probe.streams[0].nb_frames), 60); assert.ok(Number(probe.streams[0].duration) >= 2.9);
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', output, '-f', 'null', '-']);
  assert.deepEqual(fs.readdirSync(f.outputDir), [path.basename(output)]);
});

test('advertised AAC with no received audio fails instead of silently publishing video-only', async t => {
  const f = fixture(t);
  await assert.rejects(runRtspClipExport({ ...f.options, pullSegment: async ({ outPath, audioOutPath }) => {
    fs.writeFileSync(outPath, Buffer.from([0, 0, 0, 1, 0x65])); fs.writeFileSync(audioOutPath, '');
    return { frames: 60, audioFrames: 0, meta: { audio: { codec: 'MPEG4-GENERIC' } } };
  } }), error => error.code === 'DVR_AUDIO_INCOMPLETE');
  assert.deepEqual(fs.readdirSync(f.outputDir), []);
});

test('unknown pull failures are generic in progress and promise, with temporary files cleaned', async t => {
  const f = fixture(t), messages = [];
  setProgressStatusHook((_task, _status, _progress, message) => messages.push(message));
  await assert.rejects(runRtspClipExport({ ...f.options, pullSegment: async ({ outPath, audioOutPath }) => {
    fs.writeFileSync(outPath, 'partial'); fs.writeFileSync(audioOutPath, 'partial');
    throw new Error('rtsp://private-user:private-password@fixture.invalid/SDP rawstderr');
  } }), error => error.code === 'DVR_EXPORT_FAILED' && !/private|rtsp:\/\/|SDP|rawstderr/.test(error.message));
  assert.doesNotMatch(JSON.stringify(messages), /private|rtsp:\/\/|SDP|rawstderr/);
  assert.deepEqual(fs.readdirSync(f.outputDir), []);
});
