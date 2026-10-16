/**
 * RTSP 分段导出模块单元测试
 *
 * 覆盖纯函数逻辑：时间转换、分段、fps 推导、内容指纹对齐。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  compactToMs,
  msToCompact,
  splitClipSegments,
  deriveFpsFromFrameCounts,
  deriveFps,
  findOverlapCutoff,
  findVideoRtpOverlapCutoff,
  findAudioOverlapCutoff,
  isFrameCountComplete,
} from '../lib/rtsp-clip-export.js';
import { buildAdtsHeader } from '../lib/rtsp-client.js';

describe('compactToMs / msToCompact', () => {
  it('compact → ms → compact 往返一致', () => {
    const compact = '20260714T090000Z';
    const ms = compactToMs(compact);
    assert.equal(msToCompact(ms), compact);
  });

  it('compactToMs 解析正确的 UTC 时刻', () => {
    assert.equal(compactToMs('20260714T000000Z'), Date.parse('2026-07-14T00:00:00Z'));
  });
});

describe('splitClipSegments', () => {
  const t0 = compactToMs('20260714T090000Z');

  it('短片段（≤最小段长）不分段', () => {
    const segs = splitClipSegments(t0, t0 + 15 * 1000, 4);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].startMs, t0);
    assert.equal(segs[0].endMs, t0 + 15 * 1000);
  });

  it('30 秒片段按并发 2 分成 2 段且首尾相接', () => {
    const segs = splitClipSegments(t0, t0 + 30 * 1000, 2);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].startMs, t0);
    assert.equal(segs[0].endMs, segs[1].startMs);
    assert.equal(segs[1].endMs, t0 + 30 * 1000);
  });

  it('段数不超过并发上限', () => {
    const segs = splitClipSegments(t0, t0 + 3600 * 1000, 4);
    assert.equal(segs.length, 4);
  });

  it('所有段连续覆盖全区间', () => {
    const segs = splitClipSegments(t0, t0 + 601 * 1000, 3);
    for (let i = 1; i < segs.length; i++) {
      assert.equal(segs[i].startMs, segs[i - 1].endMs);
    }
    assert.equal(segs[0].startMs, t0);
    assert.equal(segs[segs.length - 1].endMs, t0 + 601 * 1000);
  });
});

describe('deriveFpsFromFrameCounts', () => {
  const t0 = compactToMs('20260714T090000Z');

  it('20fps 段（15s 窗口收 320 帧 = 16s 内容）唯一命中 20', () => {
    const pulled = [
      { startMs: t0, endMs: t0 + 15000, frames: 320 },
      { startMs: t0 + 15000, endMs: t0 + 30000, frames: 340 },
    ];
    assert.equal(deriveFpsFromFrameCounts(pulled), 20);
  });

  it('不完整段导致无唯一候选时返回 null', () => {
    const pulled = [
      { startMs: t0, endMs: t0 + 15000, frames: 245 }, // 12.25s@20fps < 窗口，无候选命中
    ];
    assert.equal(deriveFpsFromFrameCounts(pulled), null);
  });
});

describe('deriveFps 综合链', () => {
  const t0 = compactToMs('20260714T090000Z');

  it('RTP 时间戳有效时优先（4500 ticks → 20fps）', () => {
    const pulled = [
      { startMs: t0, endMs: t0 + 15000, frames: 320, meta: { tsDeltaMode: 4500 } },
    ];
    const r = deriveFps(pulled, { fps: 25, gopFrames: 50 });
    assert.equal(r.fps, 20);
    assert.equal(r.source, 'rtp');
  });

  it('RTP 损坏时用帧数推导', () => {
    const pulled = [
      { startMs: t0, endMs: t0 + 15000, frames: 320, meta: { tsDeltaMode: null } },
      { startMs: t0 + 15000, endMs: t0 + 30000, frames: 340, meta: { tsDeltaMode: null } },
    ];
    const r = deriveFps(pulled, { fps: 40, gopFrames: 40 });
    assert.equal(r.fps, 20);
    assert.equal(r.source, 'frame-count');
  });

  it('段不完整时用 GOP + ffprobe 修正值交叉（40帧 GOP、ffprobe 修正后 20）', () => {
    const pulled = [
      { startMs: t0, endMs: t0 + 15000, frames: 245, meta: { tsDeltaMode: null } },
    ];
    // probeStreamParams 已把 40 修正为 20；GOP 候选 {10, 20} 含 20 → 采纳
    const r = deriveFps(pulled, { fps: 20, gopFrames: 40 });
    assert.equal(r.fps, 20);
    assert.equal(r.source, 'gop+ffprobe');
  });
});

describe('findOverlapCutoff（内容指纹）', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'hik-test-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  function makeBuf(seed, len) {
    const buf = Buffer.alloc(len);
    // xorshift32：避免旧的线性低字节序列每 256 字节循环，导致不同 seed
    // 的测试数据实际上存在很长的字节级后缀/前缀重叠。
    let state = (seed * 0x9e3779b1) >>> 0;
    for (let i = 0; i < len; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      buf[i] = state & 0xff;
    }
    return buf;
  }

  it('段2开头与段1尾部重叠时返回正确截断点', () => {
    const unique1 = makeBuf(1, 100000);
    const overlap = makeBuf(2, 50000);
    const unique2 = makeBuf(3, 100000);

    const prev = join(dir, 'seg0.h264');
    const next = join(dir, 'seg1.h264');
    writeFileSync(prev, Buffer.concat([unique1, overlap]));
    writeFileSync(next, Buffer.concat([overlap, unique2]));

    const cutoff = findOverlapCutoff(prev, next);
    assert.equal(cutoff, unique1.length);
  });

  it('无重叠（录像缺口）时返回 null', () => {
    const prev = join(dir, 'gap0.h264');
    const next = join(dir, 'gap1.h264');
    writeFileSync(prev, makeBuf(10, 80000));
    writeFileSync(next, makeBuf(20, 80000));
    assert.equal(findOverlapCutoff(prev, next), null);
  });

  it('文件缺失时返回 null 而不抛异常', () => {
    assert.equal(findOverlapCutoff(join(dir, 'nope1'), join(dir, 'nope2')), null);
  });
});

describe('findAudioOverlapCutoff（AAC 接缝）', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'hik-aac-test-')); });
  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  const config = { objectType: 2, sampleRateIndex: 8, channelConfig: 1 };
  const frame = (id) => {
    const payload = Buffer.alloc(20, id);
    return Buffer.concat([buildAdtsHeader(payload.length, config), payload]);
  };

  it('RTP 时间戳和 AAC 内容都证明 3 帧重叠时裁掉前段尾部', () => {
    const prevPath = join(dir, 'prev.aac');
    const nextPath = join(dir, 'next.aac');
    writeFileSync(prevPath, Buffer.concat(Array.from({ length: 10 }, (_, i) => frame(i))));
    writeFileSync(nextPath, Buffer.concat(Array.from({ length: 8 }, (_, i) => frame(i + 7))));
    const cutoff = findAudioOverlapCutoff(
      prevPath,
      nextPath,
      { lastFrameTs: 9 * 1024, tsDeltaMode: 1024 },
      { firstFrameTs: 7 * 1024, tsDeltaMode: 1024 },
    );
    assert.equal(cutoff, 7 * 27);
  });

  it('只有时间戳重叠但内容不同，不执行危险裁剪', () => {
    const prevPath = join(dir, 'different-prev.aac');
    const nextPath = join(dir, 'different-next.aac');
    writeFileSync(prevPath, Buffer.concat([frame(1), frame(2), frame(3)]));
    writeFileSync(nextPath, Buffer.concat([frame(8), frame(9)]));
    assert.equal(findAudioOverlapCutoff(
      prevPath,
      nextPath,
      { lastFrameTs: 2048, tsDeltaMode: 1024 },
      { firstFrameTs: 1024, tsDeltaMode: 1024 },
    ), null);
  });
});

describe('findVideoRtpOverlapCutoff（视频接缝兜底）', () => {
  it('按 RTP 时间戳识别 3 帧重叠并返回前段第 7 帧末尾', () => {
    const cutoff = findVideoRtpOverlapCutoff(
      {
        lastFrameTs: 9 * 4500,
        tsDeltaMode: 4500,
        frameEndBytes: Array.from({ length: 10 }, (_, i) => (i + 1) * 100),
      },
      { firstFrameTs: 7 * 4500, tsDeltaMode: 4500 },
    );
    assert.equal(cutoff, 700);
  });

  it('下一段时间戳在前段末尾之后时不裁剪', () => {
    assert.equal(findVideoRtpOverlapCutoff(
      { lastFrameTs: 4500, tsDeltaMode: 4500, frameEndBytes: [100, 200] },
      { firstFrameTs: 9000, tsDeltaMode: 4500 },
    ), null);
  });
});

describe('isFrameCountComplete', () => {
  it('30 秒请求的 620 帧/20fps 视为完整', () => {
    assert.equal(isFrameCountComplete(620, 30, 20), true);
  });

  it('30 秒请求只有 490 帧/20fps 时判定不完整', () => {
    assert.equal(isFrameCountComplete(490, 30, 20), false);
  });

  it('允许最多 2 秒的边界误差', () => {
    assert.equal(isFrameCountComplete(560, 30, 20), true);
    assert.equal(isFrameCountComplete(559, 30, 20), false);
  });
});
