/**
 * MCP 的 JSON-RPC / stdio 传输层（lib/mcp-stdio.js）。
 *
 * 最要命的两件事：stdout 不能混进非协议内容，以及工具执行失败必须回成
 * isError 结果而不是协议级 error——后者会让客户端认为服务端坏了，
 * 而不是让模型看见「这次调用失败了，原因是……」并自己决定下一步。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import {
  createMcpDispatcher,
  serveStdio,
  negotiateProtocolVersion,
  parseMessage,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSON_RPC_ERRORS,
} from '../lib/mcp-stdio.js';

const TOOLS = [
  { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
  { name: 'boom', description: 'boom', inputSchema: { type: 'object', properties: {} } },
  { name: 'ctx', description: 'ctx', inputSchema: { type: 'object', properties: {} } },
];

function makeDispatcher(overrides = {}) {
  return createMcpDispatcher({
    serverInfo: { name: 'test', version: '0.0.1' },
    tools: TOOLS,
    callTool: async (name, args, context) => {
      if (name === 'boom') throw new Error('炸了');
      if (name === 'ctx') return `ctx:${JSON.stringify(context ?? null)}`;
      return `echo:${JSON.stringify(args)}`;
    },
    ...overrides,
  });
}

describe('negotiateProtocolVersion', () => {
  it('认识客户端要的版本就照它回', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      assert.equal(negotiateProtocolVersion(version), version);
    }
  });

  it('不认识就回我们支持的最新版', () => {
    assert.equal(negotiateProtocolVersion('1999-01-01'), SUPPORTED_PROTOCOL_VERSIONS[0]);
    assert.equal(negotiateProtocolVersion(undefined), SUPPORTED_PROTOCOL_VERSIONS[0]);
  });
});

describe('parseMessage', () => {
  it('空行返回 null', () => {
    assert.equal(parseMessage(''), null);
    assert.equal(parseMessage('   \t '), null);
  });

  it('坏 JSON 抛错，交给调用方回 parseError', () => {
    assert.throws(() => parseMessage('{nope'));
  });
});

describe('dispatcher', () => {
  it('initialize 回协议版本、能力和服务端信息', async () => {
    const res = await makeDispatcher().handle({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    assert.equal(res.result.protocolVersion, '2025-06-18');
    assert.equal(res.result.serverInfo.name, 'test');
    assert.ok(res.result.capabilities.tools);
  });

  it('通知（无 id）不产生回复', async () => {
    assert.equal(await makeDispatcher().handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(await makeDispatcher().handle({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
  });

  it('tools/list 返回全部工具', async () => {
    const res = await makeDispatcher().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(res.result.tools.map((t) => t.name), ['echo', 'boom', 'ctx']);
  });

  it('ping 回空对象', async () => {
    const res = await makeDispatcher().handle({ jsonrpc: '2.0', id: 3, method: 'ping' });
    assert.deepEqual(res.result, {});
  });

  it('tools/call 把工具文本包成 content', async () => {
    const res = await makeDispatcher().handle({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'echo', arguments: { a: 1 } },
    });
    assert.equal(res.result.isError, false);
    assert.equal(res.result.content[0].type, 'text');
    assert.match(res.result.content[0].text, /"a":1/);
  });

  it('工具抛错时回 isError 结果而不是协议 error', async () => {
    const res = await makeDispatcher().handle({
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' },
    });
    assert.equal(res.error, undefined);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /炸了/);
  });

  it('未知工具是协议级 invalidParams', async () => {
    const res = await makeDispatcher().handle({
      jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ghost' },
    });
    assert.equal(res.error.code, JSON_RPC_ERRORS.invalidParams);
  });

  it('未知方法回 methodNotFound', async () => {
    const res = await makeDispatcher().handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
    assert.equal(res.error.code, JSON_RPC_ERRORS.methodNotFound);
  });

  it('把传输层给的 context 透传给工具', async () => {
    const res = await makeDispatcher().handle(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ctx' } },
      { publicBaseUrl: 'http://box:30001' }
    );
    assert.match(res.result.content[0].text, /box:30001/);
  });

  it('stdio 没有 context 时工具收到 undefined', async () => {
    const res = await makeDispatcher().handle({
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'ctx' },
    });
    assert.equal(res.result.content[0].text, 'ctx:null');
  });

  it('tools/call 省略 arguments 时按空对象处理', async () => {
    const res = await makeDispatcher().handle({
      jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo' },
    });
    assert.match(res.result.content[0].text, /echo:\{\}/);
  });
});

describe('serveStdio', () => {
  async function run(lines) {
    const input = Readable.from([lines.join('\n') + '\n']);
    const chunks = [];
    const output = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    });
    await serveStdio(makeDispatcher(), { input, output });
    return chunks.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('逐行读写，每个请求一行回复', async () => {
    const responses = await run([
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ]);
    assert.equal(responses.length, 2);
    assert.deepEqual(responses.map((r) => r.id), [1, 2]);
  });

  it('通知不产生输出行', async () => {
    const responses = await run([
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    ]);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 1);
  });

  it('坏 JSON 回 parseError 且不影响后续消息', async () => {
    const responses = await run([
      'this is not json',
      '{"jsonrpc":"2.0","id":9,"method":"ping"}',
    ]);
    assert.equal(responses[0].error.code, JSON_RPC_ERRORS.parseError);
    assert.equal(responses[0].id, null);
    assert.equal(responses[1].id, 9);
  });

  it('回复顺序与请求顺序一致（串行处理）', async () => {
    const ids = [1, 2, 3, 4, 5];
    const responses = await run(ids.map((id) => `{"jsonrpc":"2.0","id":${id},"method":"ping"}`));
    assert.deepEqual(responses.map((r) => r.id), ids);
  });

  it('每条输出都是单独一行的合法 JSON', async () => {
    const input = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']);
    const chunks = [];
    const output = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    });
    await serveStdio(makeDispatcher(), { input, output });

    const raw = chunks.join('');
    assert.ok(raw.endsWith('\n'), '每条消息必须以换行结尾');
    assert.equal(raw.trim().split('\n').length, 1);
    assert.doesNotThrow(() => JSON.parse(raw.trim()));
  });
});
