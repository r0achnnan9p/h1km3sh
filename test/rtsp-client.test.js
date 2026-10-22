import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AacDepacketizer,
  buildAdtsHeader,
  parseAudioSpecificConfig,
  parseSdpTracks,
} from '../lib/rtsp-client.js';

describe('AAC SDP 与 ADTS', () => {
  it('解析海康 config=1408 为 AAC-LC 16kHz 单声道', () => {
    assert.deepEqual(parseAudioSpecificConfig('1408'), {
      objectType: 2,
      sampleRateIndex: 8,
      sampleRate: 16000,
      channelConfig: 1,
    });
  });

  it('解析视频与 MPEG4-GENERIC 音频轨', () => {
    const tracks = parseSdpTracks([
      'v=0',
      'm=video 0 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'a=control:trackID=video',
      'm=audio 0 RTP/AVP 104',
      'a=rtpmap:104 MPEG4-GENERIC/32000',
      'a=control:trackID=audio',
      'a=fmtp:104 mode=AAC-hbr; config=1408;SizeLength=13; IndexLength=3; IndexDeltaLength=3;',
    ].join('\r\n'));
    assert.equal(tracks.video.codec, 'H264');
    assert.equal(tracks.audio.clockRate, 32000);
    assert.equal(tracks.audio.fmtp.config, '1408');
    assert.equal(tracks.audio.fmtp.sizelength, '13');
  });

  it('把单个 AAC-hbr AU 解包为可识别的 ADTS 帧', () => {
    const au = Buffer.from([1, 2, 3, 4, 5]);
    const rtp = Buffer.alloc(12 + 2 + 2 + au.length);
    rtp[0] = 0x80;
    rtp[1] = 0x80 | 104;
    rtp.writeUInt32BE(123456, 4);
    rtp.writeUInt16BE(16, 12); // AU-headers-length
    rtp.writeUInt16BE(au.length << 3, 14); // 13-bit size + 3-bit index
    au.copy(rtp, 16);

    const chunks = [];
    const timestamps = [];
    const config = parseAudioSpecificConfig('1408');
    const depack = new AacDepacketizer({
      onData: chunk => chunks.push(chunk),
      onAu: ts => timestamps.push(ts),
      sizeLength: 13,
      indexLength: 3,
      indexDeltaLength: 3,
      clockRate: 32000,
      config,
    });
    depack.feed(rtp);

    assert.deepEqual(timestamps, [123456]);
    assert.deepEqual(chunks[0], Buffer.concat([buildAdtsHeader(au.length, config), au]));
  });
});
