/**
 * MCP 工具处理器（lib/mcp-server.js）。
 *
 * 注入假 client，不需要真服务也不需要真录像机。重点验三件事：
 *   1. 设备密码绝不出现在任何返回值里
 *   2. 时间按本地墙钟转换，不做时区换算
 *   3. 导出前会确认那段真有录像，且方式按时长自动选
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers, TOOL_DEFINITIONS } from '../lib/mcp-server.js';

const DEVICE = {
  id: 'dev-1',
  name: '球房',
  ip: '192.0.2.200',
  username: 'admin',
  password: 'sup3r-s3cret-pw',
};

/** 记录所有调用的假 client，各方法可按需覆盖。 */
function makeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    resolveBaseUrl: async () => 'http://127.0.0.1:30001',
    request: async (path) => {
      calls.push(['request', path]);
      if (path === '/api/session') return { session: { channel: '101' } };
      throw new Error(`unexpected request ${path}`);
    },
    getActiveDevice: async () => DEVICE,
    listChannels: async () => ({
      channels: [
        { id: '101', name: '大厅', resolution: '3200x1800' },
        { id: '201', name: '二号台', resolution: '3200x1800' },
      ],
    }),
    listRecordings: async (device, args) => {
      calls.push(['listRecordings', args]);
      return {
        fileCount: 1,
        totalSize: 1024 ** 3,
        recordings: [{ startTime: '2026-08-07T20:00:00Z', endTime: '2026-08-07T22:30:00Z', size: 1024 ** 3 }],
      };
    },
    startExport: async (device, args) => {
      calls.push(['startExport', args]);
      return { taskId: 'task-abc', filename: 'out.mp4' };
    },
    getStatus: async () => ({ activeTasks: [] }),
    stopExport: async (taskId) => { calls.push(['stopExport', taskId]); return {}; },
    listOutputs: async () => ({ files: [] }),
    ...overrides,
  };
  return client;
}

/** 把所有工具的返回文本拼起来，用于统一做泄漏检查。 */
async function collectAllOutputs(handlers) {
  const texts = [];
  texts.push(await handlers.list_channels({}));
  texts.push(await handlers.list_recordings({ date: '2026-08-07' }));
  texts.push(await handlers.export_clip({ date: '2026-08-07', start: '20:00', end: '22:30' }));
  texts.push(await handlers.get_export_status({}));
  texts.push(await handlers.cancel_export({ taskId: 'task-abc' }));
  texts.push(await handlers.list_outputs({}));
  return texts.join('\n');
}

describe('凭据不外泄', () => {
  it('任何工具的返回文本都不含密码', async () => {
    const handlers = createToolHandlers(makeClient());
    const all = await collectAllOutputs(handlers);
    assert.ok(!all.includes(DEVICE.password), '返回值里出现了设备密码');
  });

  it('也不含用户名', async () => {
    const handlers = createToolHandlers(makeClient());
    const all = await collectAllOutputs(handlers);
    assert.ok(!all.includes(DEVICE.username), '返回值里出现了设备用户名');
  });

  it('设备名和 IP 可以说——那是定位设备用的，不是凭据', async () => {
    const handlers = createToolHandlers(makeClient());
    const text = await handlers.list_channels({});
    assert.match(text, /球房/);
    assert.match(text, /192\.0\.2\.200/);
  });
});

describe('export_clip', () => {
  it('把墙钟时间转成紧凑格式，不做时区换算', async () => {
    const client = makeClient();
    await createToolHandlers(client).export_clip({ date: '2026-08-07', start: '19:30', end: '22:30' });

    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.startTime, '20260807T193000Z');
    assert.equal(args.endTime, '20260807T223000Z');
  });

  it('2.5 小时自动选 mp4download', async () => {
    const client = makeClient();
    const text = await createToolHandlers(client).export_clip({ date: '2026-08-07', start: '20:00', end: '22:30' });

    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.method, 'mp4download');
    assert.match(text, /mp4download/);
  });

  it('10 分钟自动选 rtspclip', async () => {
    const client = makeClient();
    await createToolHandlers(client).export_clip({ date: '2026-08-07', start: '20:00', end: '20:10' });

    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.method, 'rtspclip');
  });

  it('显式指定的方式优先于自动选择', async () => {
    const client = makeClient();
    await createToolHandlers(client).export_clip({
      date: '2026-08-07', start: '20:00', end: '22:30', method: 'rtspclip',
    });

    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.method, 'rtspclip');
  });

  it('endDate 支持跨零点', async () => {
    const client = makeClient();
    await createToolHandlers(client).export_clip({
      date: '2026-08-07', start: '23:00', endDate: '2026-08-08', end: '00:30',
    });

    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.startTime, '20260807T230000Z');
    assert.equal(args.endTime, '20260808T003000Z');
  });

  it('结束早于开始时报错，并提示跨零点该怎么写', async () => {
    const handlers = createToolHandlers(makeClient());
    await assert.rejects(
      () => handlers.export_clip({ date: '2026-08-07', start: '22:30', end: '20:00' }),
      /结束时间必须晚于开始时间[\s\S]*endDate/
    );
  });

  it('那段没有录像时拒绝导出，而不是让它慢慢失败', async () => {
    const client = makeClient({
      listRecordings: async () => ({ fileCount: 0, totalSize: 0, recordings: [] }),
    });
    const handlers = createToolHandlers(client);

    await assert.rejects(
      () => handlers.export_clip({ date: '2026-08-07', start: '20:00', end: '22:30' }),
      /没有录像/
    );
    assert.ok(!client.calls.some((c) => c[0] === 'startExport'), '不该发起导出');
  });

  it('录像检索本身失败时照常导出，只把情况说出来', async () => {
    // 老固件 / track 不存在会让搜索报错，那不是「没有录像」的证据
    const client = makeClient({
      listRecordings: async () => { throw new Error('badXmlContent'); },
    });
    const text = await createToolHandlers(client).export_clip({
      date: '2026-08-07', start: '20:00', end: '22:30',
    });

    assert.ok(client.calls.some((c) => c[0] === 'startExport'), '应该仍然发起导出');
    assert.match(text, /badXmlContent/);
  });

  it('单飞守卫的 409 会原样冒上来', async () => {
    const client = makeClient({
      startExport: async () => { throw new Error('已有导出任务进行中（45%：下载中），请等它结束或先停止'); },
    });
    await assert.rejects(
      () => createToolHandlers(client).export_clip({ date: '2026-08-07', start: '20:00', end: '22:30' }),
      /已有导出任务进行中/
    );
  });
});

describe('通道解析', () => {
  it('显式指定优先', async () => {
    const client = makeClient();
    await createToolHandlers(client).export_clip({
      date: '2026-08-07', start: '20:00', end: '22:30', channel: '201',
    });
    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.channel, '201');
  });

  it('没指定就用界面上次选的通道', async () => {
    const client = makeClient();
    await createToolHandlers(client).export_clip({ date: '2026-08-07', start: '20:00', end: '22:30' });
    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.channel, '101');
  });

  it('session 读不到就退到设备的第一个通道', async () => {
    const client = makeClient({
      request: async () => { throw new Error('no session'); },
    });
    await createToolHandlers(client).export_clip({ date: '2026-08-07', start: '20:00', end: '22:30' });
    const [, args] = client.calls.find((c) => c[0] === 'startExport');
    assert.equal(args.channel, '101');
  });

  it('设备一个通道都没有时报错', async () => {
    const client = makeClient({
      request: async () => ({ session: {} }),
      listChannels: async () => ({ channels: [] }),
    });
    await assert.rejects(
      () => createToolHandlers(client).export_clip({ date: '2026-08-07', start: '20:00', end: '22:30' }),
      /没有返回任何通道/
    );
  });
});

describe('其余工具', () => {
  it('没有激活设备时给出可操作的提示', async () => {
    const client = makeClient({
      getActiveDevice: async () => { throw new Error('还没有配置录像机。请先在 Web 界面顶栏点「+」添加设备并激活。'); },
    });
    await assert.rejects(() => createToolHandlers(client).list_channels({}), /还没有配置录像机/);
  });

  it('get_export_status 指定不存在的 taskId 时说明可能已被清理', async () => {
    const text = await createToolHandlers(makeClient()).get_export_status({ taskId: 'ghost' });
    assert.match(text, /list_outputs/);
  });

  it('get_export_status 列出进行中的任务', async () => {
    const client = makeClient({
      getStatus: async () => ({
        activeTasks: [{ taskId: 't1', status: 'downloading', progress: 42, message: '下载中' }],
      }),
    });
    const text = await createToolHandlers(client).get_export_status({});
    assert.match(text, /t1/);
    assert.match(text, /42%/);
  });

  it('list_outputs 空目录时有明确说法', async () => {
    const text = await createToolHandlers(makeClient()).list_outputs({});
    assert.match(text, /还没有导出过/);
  });

  const outputsClient = () => makeClient({
    listOutputs: async () => ({
      files: [{
        filename: 'a.mp4', size: 2 * 1024 ** 3,
        startTime: '2026-08-07T20:00:00Z', endTime: '2026-08-07T22:30:00Z',
        url: '/downloads/a.mp4',
      }],
    }),
  });

  it('list_outputs 带上完整下载地址', async () => {
    const text = await createToolHandlers(outputsClient()).list_outputs({});
    assert.match(text, /http:\/\/127\.0\.0\.1:30001\/downloads\/a\.mp4/);
    assert.match(text, /2\.00 GB/);
  });

  it('HTTP 传输给了对外地址时用它拼下载链接', async () => {
    // 端点跑在服务进程里，client 指向 127.0.0.1；直接拿它拼的话
    // 远程调用方收到的链接指向的是它自己的机器
    const text = await createToolHandlers(outputsClient()).list_outputs(
      {},
      { publicBaseUrl: 'http://box:30001' }
    );
    assert.match(text, /http:\/\/box:30001\/downloads\/a\.mp4/);
    assert.ok(!text.includes('127.0.0.1'));
  });

  it('cancel_export 缺 taskId 时报错', async () => {
    await assert.rejects(() => createToolHandlers(makeClient()).cancel_export({}), /taskId/);
  });
});

describe('工具定义', () => {
  it('每个工具都有处理器，没有多余的处理器', () => {
    const handlers = createToolHandlers(makeClient());
    const defined = TOOL_DEFINITIONS.map((t) => t.name).sort();
    assert.deepEqual(Object.keys(handlers).sort(), defined);
  });

  it('每个工具都有非空描述和 object 类型的 inputSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.description?.length > 10, `${tool.name} 缺描述`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema 类型不对`);
    }
  });

  it('export_clip 必填 start 和 end', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'export_clip');
    assert.deepEqual(tool.inputSchema.required, ['start', 'end']);
  });

  it('export_clip 的描述里写明不要拼接成品', () => {
    // 这是有意的设计取舍，得让模型知道，否则它会自作主张去拼
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'export_clip');
    assert.match(tool.description, /不要试图把两段成品拼起来/);
  });
});
