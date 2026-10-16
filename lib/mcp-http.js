/**
 * MCP 的 HTTP 传输（Streamable HTTP），挂在常驻服务的 Express 上。
 *
 * 给「没法执行本地命令」的客户端用——网页版、手机、别人的电脑。能跑本地命令的
 * 客户端仍然推荐 stdio（`server.js mcp`），少一个长期敞着的端点。
 *
 * 无状态实现：不发 Mcp-Session-Id，不提供服务端主动推送的 SSE 流（`GET` 回 405，
 * 这是规范要求的表态方式）。工具全是「请求—响应」，用不上这两样。
 *
 * 分发逻辑与 stdio 完全共用（lib/mcp-server.js 的 createHikclipDispatcher），
 * 传输层只负责收发。
 */

import { createBearerAuth } from './mcp-security.js';

/** 环回地址的 origin，浏览器里从本机页面发起的算自己人。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Origin 校验，防 DNS rebinding —— MCP 规范对 HTTP 传输的明确要求。
 *
 * 本服务绑 0.0.0.0 且**没有鉴权**，`app.use(cors())` 又放行所有来源。没有这道校验的话，
 * 你在浏览器里打开的任意网页都能 fetch 到 http://box:30001/mcp 并读到响应，
 * 等于把录像机操作权交给了任何一个你访问过的站点。
 *
 * 真正的 MCP 客户端不是浏览器，不会带 Origin，所以这道校验对它们透明。
 *
 * @param {string|undefined} origin 请求的 Origin 头
 * @param {string|undefined} host 请求的 Host 头（同源判断用）
 */
export function isOriginAllowed(origin, host) {
  if (!origin) return true; // 非浏览器客户端，放行

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false; // 包括 "null"（sandboxed iframe）在内的非法值
  }

  if (LOOPBACK_HOSTS.has(originUrl.hostname)) return true;

  // 同源：Origin 的 host（含端口）和请求的 Host 一致
  return Boolean(host) && originUrl.host === host;
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * 造一个 Express handler。抽出来是为了能脱离真服务直接测。
 *
 * @param {{handle:(msg:object)=>Promise<object|null>}} dispatcher
 */
export function createMcpHttpHandler(dispatcher, { publicBaseUrl } = {}) {
  return async function handleMcpPost(req, res) {
    if (!isOriginAllowed(req.get('origin'), req.get('host'))) {
      return res.status(403).json(jsonRpcError(null, -32600, 'Origin not allowed'));
    }

    const body = req.body;
    const isBatch = Array.isArray(body);
    const messages = isBatch ? body : [body];

    if (!messages.length || messages.some((m) => !m || typeof m !== 'object')) {
      return res.status(400).json(jsonRpcError(null, -32600, 'Invalid Request'));
    }

    // 把调用方实际用来访问本服务的地址传下去。端点跑在服务进程里，工具用的
    // client 指向 127.0.0.1，不这样做的话 list_outputs 回的下载链接会指向
    // 调用方自己的机器。
    const context = { publicBaseUrl: publicBaseUrl || `${req.protocol}://${req.get('host')}` };

    const responses = [];
    for (const message of messages) {
      try {
        const response = await dispatcher.handle(message, context);
        if (response) responses.push(response);
      } catch (err) {
        responses.push(jsonRpcError(message.id, -32603, err.message));
      }
    }

    // 整批都是通知/响应（没有需要回复的请求）时按规范回 202
    if (!responses.length) return res.status(202).end();

    res.json(isBatch ? responses : responses[0]);
  };
}

/**
 * 把 MCP HTTP 端点挂到 Express 上。
 *
 * @param {object} app Express app
 * @param {object} dispatcher
 * @param {string} [path]
 */
export function mountMcpHttp(app, dispatcher, path = '/mcp', { token = '', publicBaseUrl, verifyAccess, resourceMetadata } = {}) {
  app.all(path, createBearerAuth(token, { verifyAccess, resourceMetadata }));
  app.post(path, createMcpHttpHandler(dispatcher, { publicBaseUrl }));

  // 规范：服务端不提供主动推送的 SSE 流时，GET 必须回 405
  app.get(path, (req, res) => {
    res.set('Allow', 'POST').status(405).json(jsonRpcError(null, -32600, 'SSE stream not supported'));
  });

  // 无会话，没有什么可终止的
  app.delete(path, (req, res) => {
    res.set('Allow', 'POST').status(405).json(jsonRpcError(null, -32600, 'Sessions not supported'));
  });

  return path;
}
