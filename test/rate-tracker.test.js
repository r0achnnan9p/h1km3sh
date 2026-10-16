import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRateTracker } from '../lib/rate-tracker.js';

describe('createRateTracker', () => {
  it('样本不足时速率为 0', () => {
    const t = createRateTracker();
    assert.equal(t.update(1000, 0), 0);
    assert.equal(t.rate(), 0);
  });

  it('按累计字节差与时间差算出字节/秒', () => {
    const t = createRateTracker();
    t.update(0, 0);
    assert.equal(t.update(2_000_000, 2000), 1_000_000);
  });

  it('计数器归零（切换文件）不会算出负速率', () => {
    const t = createRateTracker({ windowMs: 60_000 });
    t.update(0, 0);
    t.update(1_000_000, 1000);
    // 下一个文件从 0 重新计起
    const rate = t.update(500_000, 2000);
    assert.ok(rate > 0, `切文件后速率应为正，实际 ${rate}`);
    // 累计应为 1.0MB + 0.5MB = 1.5MB / 2s
    assert.equal(rate, 750_000);
  });

  it('滑动窗口只保留窗口内样本，旧数据不拖慢读数', () => {
    const t = createRateTracker({ windowMs: 1000 });
    t.update(0, 0);
    t.update(100, 5000);      // 一段极慢的历史
    t.update(1_000_100, 5500); // 窗口内突然提速
    assert.ok(t.rate() > 1_000_000, `应反映近期速率，实际 ${t.rate()}`);
  });

  it('至少保留两个样本，窗口过期也能算', () => {
    const t = createRateTracker({ windowMs: 100 });
    t.update(0, 0);
    const rate = t.update(1000, 10_000);
    assert.equal(rate, 100);
  });

  it('非数值输入按 0 处理', () => {
    const t = createRateTracker();
    t.update(undefined, 0);
    assert.equal(t.update(null, 1000), 0);
  });
});
