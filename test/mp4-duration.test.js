import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMp4DurationSeconds } from '../lib/mp4-duration.js';

function box(type, payload, { large = false } = {}) {
  const header = Buffer.alloc(large ? 16 : 8);
  if (large) {
    header.writeUInt32BE(1, 0); header.write(type, 4, 4, 'latin1'); header.writeBigUInt64BE(BigInt(payload.length + 16), 8);
  } else {
    header.writeUInt32BE(payload.length + 8, 0); header.write(type, 4, 4, 'latin1');
  }
  return Buffer.concat([header, payload]);
}

function mvhd(timescale, duration, version = 0) {
  if (version === 1) {
    const payload = Buffer.alloc(32);
    payload[0] = 1; payload.writeUInt32BE(timescale, 20); payload.writeBigUInt64BE(BigInt(duration), 24);
    return box('mvhd', payload);
  }
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 12); payload.writeUInt32BE(duration, 16);
  return box('mvhd', payload);
}

function moov(timescale, duration, version = 0, prefix = Buffer.alloc(0)) {
  return box('moov', Buffer.concat([prefix, mvhd(timescale, duration, version)]));
}

function unknownVersionMvhd(version) {
  const payload = Buffer.alloc(100);
  payload[0] = version; payload.writeUInt32BE(1000, 12); payload.writeUInt32BE(42000, 16);
  return box('mvhd', payload);
}

function withFile(buffer, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-duration-'));
  const file = path.join(directory, 'sample.mp4');
  try {
    fs.writeFileSync(file, buffer);
    return run(file);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const ftyp = box('ftyp', Buffer.from('isom0000isomiso2mp41', 'latin1'));
const mdat = box('mdat', Buffer.alloc(4096, 7));

test('读取 mvhd 时长，兼容 faststart 与非 faststart 的 moov 位置', () => {
  withFile(Buffer.concat([ftyp, moov(1000, 120000), mdat]), file => {
    assert.equal(readMp4DurationSeconds(file), 120);
  });
  withFile(Buffer.concat([ftyp, mdat, moov(1000, 90500)]), file => {
    assert.equal(readMp4DurationSeconds(file), 90.5);
  });
});

test('支持 64 位 box 尺寸和 mvhd v1，并跳过 mvhd 前的子 box', () => {
  const free = box('free', Buffer.alloc(16));
  withFile(Buffer.concat([ftyp, box('mdat', Buffer.alloc(1024), { large: true }), moov(1000, 3600500, 1, free)]), file => {
    assert.equal(readMp4DurationSeconds(file), 3600.5);
  });
});

test('未支持的 mvhd 版本返回 null，不按 v0 猜测 42 秒', () => {
  for (const version of [2, 255]) {
    withFile(Buffer.concat([ftyp, box('moov', unknownVersionMvhd(version))]), file => {
      assert.equal(readMp4DurationSeconds(file), null);
    });
  }
});

test('损坏文件、未知 v0 时长和缺失 mvhd 返回 null 而不是假时长', () => {
  withFile(Buffer.from('not-an-mp4'), file => assert.equal(readMp4DurationSeconds(file), null));
  withFile(Buffer.concat([ftyp, moov(1000, 0xffffffff)]), file => assert.equal(readMp4DurationSeconds(file), null));
  withFile(Buffer.concat([ftyp, box('moov', box('free', Buffer.alloc(8)))]), file => assert.equal(readMp4DurationSeconds(file), null));
  withFile(Buffer.concat([ftyp, moov(0, 1000)]), file => assert.equal(readMp4DurationSeconds(file), null));
});
