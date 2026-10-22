/**
 * MCP 的 stdio 传输层：换行分隔的 JSON-RPC 2.0。
 *
 * 为什么不用官方 @modelcontextprotocol/sdk：它带 17 个依赖（hono / jose / ajv /
 * zod / OAuth 那一整套），而这里只需要 stdio 一种传输。本仓库运行时依赖只有 3 个，
 * 还要用 esbuild 把 server.js 打成 SEA 单文件——为一个几百行的协议壳子引入那么大
 * 一棵依赖树不划算，动态 require 还有打包炸掉的风险。协议面很小，手写反而可控。
 *
 * 一条铁律：**stdout 只能有 JSON-RPC 消息**，任何日志都必须走 stderr，
 * 否则会把协议流污染成解析错误。
 */

/** 认识的协议版本，新的在前。客户端报了其中之一就照它回，否则回我们最新的。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
};

/** 协商协议版本：认识客户端要的就用它，否则用我们支持的最新版。 */
export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * 把一行文本解析成 JSON-RPC 消息。返回 null 表示空行（忽略）。
 * 解析失败时抛出，由调用方回 parseError。
 */
export function parseMessage(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

/**
 * 协议处理核心：一进一出的纯函数式分发，不碰 stdio，方便直接测。
 *
 * @param {object} options
 * @param {{name:string, version:string}} options.serverInfo
 * @param {Array<object>} options.tools 工具定义（name / description / inputSchema）
 * @param {(name:string, args:object, context:object|undefined) => Promise<string>} options.callTool
 *        返回给模型看的文本；抛错会被转成 isError 结果而不是协议级错误。
 *        context 由传输层给出（HTTP 传输会带上本次请求的对外地址），stdio 没有
 * @param {(msg:string) => void} [options.log] 诊断输出（务必写 stderr）
 */
export function createMcpDispatcher({ serverInfo, tools, callTool, log = () => {}, resources = [], readResource, instructions }) {
  let initialized = false;

  async function handle(message, context) {
    // 通知（没有 id）不需要回复
    const isNotification = message.id === undefined || message.id === null;

    const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: message.id, result });
    const fail = (code, msg) => (isNotification ? null : { jsonrpc: '2.0', id: message.id, error: { code, message: msg } });

    switch (message.method) {
      case 'initialize': {
        initialized = true;
        return reply({
          protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
          capabilities: { tools: { listChanged: false }, ...(resources.length ? { resources: {} } : {}) },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({ tools });

      case 'resources/list':
        if (!resources.length) return fail(JSON_RPC_ERRORS.methodNotFound, '未提供资源');
        return reply({ resources });
      case 'resources/read':
        if (!resources.some((item) => item.uri === message.params?.uri) || !readResource) return fail(-32602, '未知资源');
        return reply({ contents: [await readResource(message.params.uri, context)] });

      case 'tools/call': {
        const name = message.params?.name;
        const args = message.params?.arguments || {};

        if (!tools.some((t) => t.name === name)) {
          return fail(JSON_RPC_ERRORS.invalidParams, `未知工具：${name}`);
        }

        try {
          const result = await callTool(name, args, context);
          return reply(typeof result === 'string'
            ? { content: [{ type: 'text', text: result }], isError: false }
            : { ...result, isError: false });
        } catch (err) {
          // 工具执行失败是「结果」而不是协议错误——要让模型看见原因并自己决定下一步
          log(`tool ${name} failed: ${err.message}`);
          return reply({ content: [{ type: 'text', text: `失败：${err.message}` }], isError: true });
        }
      }

      default:
        return fail(JSON_RPC_ERRORS.methodNotFound, `不支持的方法：${message.method}`);
    }
  }

  return {
    handle,
    get initialized() { return initialized; },
  };
}

/**
 * 把 dispatcher 接到 stdin/stdout 上，按行读、按行写。
 *
 * @returns {Promise<void>} stdin 结束时 resolve
 */
export function serveStdio(dispatcher, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    let buffer = '';
    // 串行处理：保证回复顺序与请求顺序一致，也避免并发跑同一个工具
    let chain = Promise.resolve();

    const send = (response) => {
      if (response) output.write(JSON.stringify(response) + '\n');
    };

    input.setEncoding('utf-8');

    input.on('data', (chunk) => {
      buffer += chunk;

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        chain = chain.then(async () => {
          let message;
          try {
            message = parseMessage(line);
          } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.parseError, message: 'Parse error' } });
            return;
          }
          if (!message) return;

          try {
            send(await dispatcher.handle(message));
          } catch (err) {
            send({
              jsonrpc: '2.0',
              id: message.id ?? null,
              error: { code: JSON_RPC_ERRORS.internalError, message: err.message },
            });
          }
        });
      }
    });

    input.on('end', () => { chain.then(resolve); });
    input.on('close', () => { chain.then(resolve); });
  });
}
