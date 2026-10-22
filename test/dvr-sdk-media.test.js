/** Real offline media processing. No HCNetSDK binary or recorder is involved.
 * The simulated Python downloader copies an H264 + PCM A-law MOV fixture to the
 * SDK's .ps filename. FFmpeg cannot mux A-law into standard MPEG-PS; container
 * identification, conversion and full decoding below are real FFmpeg operations.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createSdkAdapter } from '../lib/dvr-sdk.js';
import { ffmpegPath, ffprobePath } from '../lib/ffmpeg-paths.js';

const run = promisify(execFile);
const device = { id: '1d134708-0e74-4ad5-b233-9f7349b9a6e6', ip: '192.0.2.1', username: 'offline-user', password: 'offline-password' };
const startTime = '20261001T213845Z', endTime = '20261001T213847Z';
const curlDigest = async (_device, _user, _password, uri) => {
  if (uri === '/ISAPI/Streaming/channels/201') return '<StreamingChannel><id>201</id><Video><videoInputChannelID>2</videoInputChannelID></Video></StreamingChannel>';
  assert.equal(uri, '/ISAPI/Security/adminAccesses');
  return '<AdminAccessProtocolList><AdminAccessProtocol><protocol>DEV_MANAGE</protocol><portNo>8000</portNo><enabled>true</enabled></AdminAccessProtocol></AdminAccessProtocolList>';
};
const probe = async file => JSON.parse((await run(ffprobePath, ['-v', 'error', '-count_frames', '-show_entries',
  'format=format_name,duration:stream=codec_name,codec_type,nb_read_frames,width,height', '-of', 'json', file], { timeout: 30_000 })).stdout);

test('real offline MOV H264/A-law fixture becomes fully decodable H264/AAC MP4 via SDK adapter', { timeout: 120_000 }, async t => {
  // These integration tests are optional only when runtime binaries are missing.
  for (const [binary, args] of [[ffmpegPath, ['-version']], [ffprobePath, ['-version']], ['python3', ['--version']]]) {
    try { await run(binary, args, { timeout: 10_000 }); }
    catch (error) {
      if (error.code === 'ENOENT') { t.skip(`${path.basename(binary)} is not installed`); return; }
      throw error;
    }
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-real-media-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'source.mov');
  await run(ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_alaw', '-f', 'mov', fixture], { timeout: 30_000 });
  const source = await probe(fixture);
  assert.match(source.format.format_name, /mov/);
  assert.deepEqual(source.streams.map(s => s.codec_name), ['h264', 'pcm_alaw']);
  const worker = path.join(root, 'offline-sdk-worker.py');
  await fs.writeFile(worker, `import json, pathlib, shutil, sys
config = json.load(sys.stdin)
assert config['inputChannel'] == 2 and config['port'] == 8000
assert config['start'] == '${startTime}' and config['end'] == '${endTime}'
output = pathlib.Path(config['output'])
assert output.parent.stat().st_mode & 0o077 == 0
assert not list(output.parent.iterdir())
shutil.copyfile(pathlib.Path(__file__).with_name('source.mov'), output)
print(json.dumps(dict(ok=True, code='completed', sdkCode=None, bytes=output.stat().st_size,
    sdkChannel=34, requestedStart=config['start'], requestedEnd=config['end'],
    osdTimes=['20261001T213843Z'])))
`, { mode: 0o600 });
  for (const preview of [false, true]) {
    await t.test(preview ? 'preview transcodes video and A-law audio' : 'export copies H264 and transcodes A-law audio', async () => {
      const calls = [];
      const adapter = createSdkAdapter({
        workerPath: worker, ffmpeg: ffmpegPath, ffprobe: ffprobePath,
        env: { PATH: process.env.PATH, HIKVISION_SDK_DIR: path.join(root, 'not-installed-sdk'), HIKVISION_SDK_DEVICE_IDS: device.id },
        spawn(binary, args, options) {
          assert.ok(!JSON.stringify(args).includes(device.password));
          assert.ok(!JSON.stringify(options).includes(device.password));
          calls.push({ binary, args });
          return spawn(binary, args, options);
        },
      });
      const outputFile = path.join(root, preview ? 'preview.mp4' : 'export.mp4');
      const result = await adapter.sdkDownloadMp4({ device, channel: '201', startTime, endTime,
        outputFile, curlDigest, preview });
      assert.equal(result.transport, 'hcnetsdk');
      assert.equal(result.timingAccuracy, 'unverified-keyframe');
      assert.equal(result.requestedStart, startTime);
      assert.equal(result.requestedEnd, endTime);
      assert.equal(result.sdkChannel, 34);
      assert.ok(result.actualDurationSeconds >= 2 && result.actualDurationSeconds < 2.5);
      assert.ok(!Object.hasOwn(result, 'osdTimes'));
      const media = await probe(outputFile);
      const video = media.streams.find(s => s.codec_type === 'video');
      const audio = media.streams.find(s => s.codec_type === 'audio');
      assert.equal(video.codec_name, 'h264');
      assert.equal(audio.codec_name, 'aac');
      assert.equal(Number(video.nb_read_frames), 20);
      assert.ok(Number(audio.nb_read_frames) > 0);
      assert.ok(video.width <= 1280 && video.height <= 720);
      // Decode every video and audio frame. Metadata/probe success alone is not
      // evidence that the produced streams are free of decode errors.
      await run(ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-i', outputFile,
        '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 30_000 });
      const conversion = calls.find(c => c.binary === ffmpegPath);
      assert.equal(conversion.args[conversion.args.indexOf('-c:v') + 1], preview ? 'libx264' : 'copy');
      assert.equal(conversion.args[conversion.args.indexOf('-c:a') + 1], 'aac');
      assert.ok(!(await fs.readdir(root)).some(name => name.startsWith('.hik-sdk-')));
    });
  }
});
