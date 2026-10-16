/**
 * 人话时间 ↔ 海康紧凑时间（lib/hik-time.js）。
 *
 * 最要紧的一条：全程不做时区换算。"19:30" 就是 NVR 面板上的 19:30，
 * 转出来必须是 T193000Z，不能因为跑在 UTC+8 就变成 T113000Z。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate,
  parseClock,
  toCompact,
  compactToDisplay,
  compactToMs,
  msToCompact,
  durationSeconds,
  localDateStr,
  localClockStr,
  localSecondsOfDay,
  shiftDate,
} from '../lib/hik-time.js';

describe('toCompact', () => {
  it('把日期和时间拼成海康紧凑格式', () => {
    assert.equal(toCompact('2026-08-07', '19:30'), '20260807T193000Z');
    assert.equal(toCompact('2026-08-07', '22:30'), '20260807T223000Z');
  });

  it('接受带秒的时间', () => {
    assert.equal(toCompact('2026-08-07', '20:00:15'), '20260807T200015Z');
  });

  it('接受单位数小时', () => {
    assert.equal(toCompact('2026-01-02', '9:05'), '20260102T090500Z');
  });

  it('不做任何时区换算——贴 Z 只是格式要求', () => {
    // 这条是整个项目的时间语义前提，改坏了会让所有导出偏移若干小时
    const compact = toCompact('2026-08-07', '19:30');
    assert.equal(compact.slice(9, 15), '193000');
  });

  it('午夜和一天最后一秒都能表达', () => {
    assert.equal(toCompact('2026-08-07', '00:00'), '20260807T000000Z');
    assert.equal(toCompact('2026-08-07', '23:59:59'), '20260807T235959Z');
  });
});

describe('parseDate', () => {
  it('解析合法日期', () => {
    assert.deepEqual(parseDate('2026-08-07'), { year: 2026, month: 8, day: 7 });
  });

  it('拒绝格式不对的', () => {
    assert.throws(() => parseDate('2026/08/07'), /YYYY-MM-DD/);
    assert.throws(() => parseDate('26-8-7'), /YYYY-MM-DD/);
    assert.throws(() => parseDate(''), /YYYY-MM-DD/);
    assert.throws(() => parseDate(undefined), /YYYY-MM-DD/);
  });

  it('拒绝日历上不存在的日期', () => {
    assert.throws(() => parseDate('2026-02-30'), /日期不存在/);
    assert.throws(() => parseDate('2026-13-01'), /日期不存在/);
  });

  it('闰年 2 月 29 日是合法的', () => {
    assert.deepEqual(parseDate('2028-02-29'), { year: 2028, month: 2, day: 29 });
    assert.throws(() => parseDate('2026-02-29'), /日期不存在/);
  });
});

describe('parseClock', () => {
  it('返回当天第几秒', () => {
    assert.equal(parseClock('00:00'), 0);
    assert.equal(parseClock('19:30'), 19 * 3600 + 30 * 60);
    assert.equal(parseClock('23:59:59'), 86399);
  });

  it('拒绝越界和坏格式', () => {
    assert.throws(() => parseClock('24:00'), /超出范围/);
    assert.throws(() => parseClock('19:60'), /超出范围/);
    assert.throws(() => parseClock('19:30:60'), /超出范围/);
    assert.throws(() => parseClock('1930'), /HH:MM/);
    assert.throws(() => parseClock(''), /HH:MM/);
  });
});

describe('compactToMs / msToCompact', () => {
  it('往返无损', () => {
    const compact = '20260807T193000Z';
    assert.equal(msToCompact(compactToMs(compact)), compact);
  });

  it('按 UTC 解析墙上时钟（数轴坐标，不是真实时刻）', () => {
    assert.equal(compactToMs('20260807T193000Z'), Date.parse('2026-08-07T19:30:00Z'));
  });
});

describe('durationSeconds', () => {
  it('算出墙钟时长', () => {
    assert.equal(durationSeconds('20260807T200000Z', '20260807T223000Z'), 2.5 * 3600);
    assert.equal(durationSeconds('20260807T193000Z', '20260807T223000Z'), 3 * 3600);
  });

  it('跨天也对', () => {
    assert.equal(durationSeconds('20260807T233000Z', '20260808T003000Z'), 3600);
  });

  it('倒序返回负数，交给调用方判断', () => {
    assert.equal(durationSeconds('20260807T223000Z', '20260807T200000Z'), -2.5 * 3600);
  });

  it('解析不了就抛错', () => {
    assert.throws(() => durationSeconds('garbage', '20260807T200000Z'), /无法解析时间范围/);
  });
});

describe('compactToDisplay', () => {
  it('转成人看的格式', () => {
    assert.equal(compactToDisplay('20260807T193000Z'), '2026-08-07 19:30:00');
  });

  it('不认识的输入原样返回，不要在展示层抛错', () => {
    assert.equal(compactToDisplay('nonsense'), 'nonsense');
    assert.equal(compactToDisplay(''), '');
  });
});

describe('本地时间取值', () => {
  it('localDateStr / localClockStr 用本地字段，补零', () => {
    const now = new Date(2026, 0, 2, 9, 5, 30);
    assert.equal(localDateStr(now), '2026-01-02');
    assert.equal(localClockStr(now), '09:05');
  });

  it('localSecondsOfDay 含秒', () => {
    assert.equal(localSecondsOfDay(new Date(2026, 7, 7, 23, 0, 0)), 23 * 3600);
    assert.equal(localSecondsOfDay(new Date(2026, 7, 7, 0, 0, 0)), 0);
  });
});

describe('shiftDate', () => {
  it('前后挪天数', () => {
    assert.equal(shiftDate('2026-08-07', -1), '2026-08-06');
    assert.equal(shiftDate('2026-08-07', 1), '2026-08-08');
    assert.equal(shiftDate('2026-08-07', -7), '2026-07-31');
  });

  it('跨月跨年', () => {
    assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
    assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  });

  it('跨闰日', () => {
    assert.equal(shiftDate('2028-03-01', -1), '2028-02-29');
  });

  it('挪 0 天是恒等', () => {
    assert.equal(shiftDate('2026-08-07', 0), '2026-08-07');
  });
});
