/** 自用单用户 OAuth：PKCE、短期一次性 code、轮换 refresh token；重启后需重新授权。 */
import express from 'express';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { bearerValid, publicBaseUrl } from './mcp-security.js';
import fs from 'node:fs';
import path from 'node:path';
import { standaloneTheme } from './standalone-ui.js';

const randomToken = () => randomBytes(32).toString('base64url');
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const consentStyles = `${standaloneTheme}
  main {
    display: grid; align-items: center; width: min(100%, 33rem); min-height: 100svh; margin: auto;
    padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  }
  .consent { background: var(--surface); border: 1px solid var(--line); border-radius: 20px; padding: clamp(1.25rem, 5vw, 2.5rem); }
  .brand { color: var(--accent); font: 700 14px/1.5 var(--mono); letter-spacing: .04em; }
  h1 { margin: .75rem 0 .5rem; font-size: clamp(1.45rem, 5vw, 2rem); line-height: 1.25; }
  p { color: var(--muted); }
  dl { margin: 1.5rem 0; padding: 1rem 0; border-block: 1px solid var(--line); }
  dt { color: var(--muted); font-size: .875rem; }
  dd { margin-top: .25rem; font: 600 1rem/1.5 var(--mono); overflow-wrap: anywhere; }
  form, label { display: grid; gap: .5rem; }
  input, button { min-height: 48px; width: 100%; border-radius: 12px; padding: .625rem .875rem; }
  input { color: var(--text); background: var(--bg); border: 1px solid var(--line); }
  button { border: 0; margin-top: .5rem; font-weight: 700; color: var(--on-accent); background: var(--accent); cursor: pointer; }
`;
const styleHash = createHash('sha256').update(consentStyles).digest('base64');
// Hash only the static stylesheet. The validated callback origin is needed for the POST redirect.
const consentPolicy = (redirect) => `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self'${redirect ? ' ' + new URL(redirect).origin : ''}; frame-ancestors 'none'; base-uri 'none'`;
function consentPage(title, description, content = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>${title} · H1kM3sh</title><style>${consentStyles}</style></head>
    <body><main><section class="consent" aria-labelledby="title">
      <p class="brand">H1kM3sh</p><h1 id="title">${title}</h1><p>${description}</p>${content}
    </section></main></body></html>`;
}
function consentError(res, status, title, description) {
  return res.status(status).set('Cache-Control', 'no-store').set('Content-Security-Policy', consentPolicy())
    .type('html').send(consentPage(title, description));
}
export const isOAuthPath = (value) => [
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/authorize', '/oauth/token',
].includes(value);

export function createCameraOAuth({ baseUrl, loginToken, now = Date.now, stateFile } = {}) {
  if (!baseUrl || !loginToken) throw new Error('OAuth 需要公网地址和访问密码。');
  baseUrl = publicBaseUrl(baseUrl);
  const authorizePath = `${new URL(baseUrl).pathname.replace(/\/+$/, '')}/oauth/authorize`;
  const resource = `${baseUrl}/mcp`;
  const clients = new Map(), codes = new Map(), access = new Map(), refresh = new Map();
  const attempts = new Map();
  const binding = createHash('sha256').update(baseUrl + '\n' + loginToken).digest('hex');
  // 授权状态只保存到服务端私密文件；换域名或访问密码时自动失效。
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved.binding === binding) {
        for (const [name, map] of [['clients', clients], ['access', access], ['refresh', refresh]]) {
          if (!Array.isArray(saved[name]) || saved[name].length > 1000) throw new Error();
          for (const [key, value] of saved[name]) {
            if (typeof key !== 'string' || !value || !Number.isFinite(value.expires)) throw new Error();
            if (value.expires > now()) map.set(key, value);
          }
        }
      }
    } catch { throw new Error('OAuth 状态文件无效，请检查服务端配置。'); }
  }
  function persist() {
    if (!stateFile) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ binding, clients: [...clients], access: [...access], refresh: [...refresh] }), { mode: 0o600 });
      fs.renameSync(temporary, stateFile);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function prune() {
    for (const map of [clients, codes, access, refresh, attempts]) {
      for (const [key, item] of map) if (item.expires <= now()) map.delete(key);
    }
  }
  function register(body) {
    prune();
    if (clients.size >= 1000) throw new Error('注册数量已达上限。');
    if (!Array.isArray(body?.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 10 ||
        (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none')) throw new Error('无效的客户端注册。');
    for (const value of body.redirect_uris) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.length > 2048) throw new Error('回调地址必须是 HTTPS。');
    }
    const id = randomUUID();
    clients.set(id, { redirects: [...body.redirect_uris], expires: now() + 30 * 86400000 });
    persist();
    return { client_id: id, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }
  function authorize(params, recover = false) {
    prune();
    let client = clients.get(params.client_id);
    // 旧版本重启丢失 DCR 注册时，仍需所有授权校验与主人密码，才允许恢复这一个回调。
    if (!client && recover && /^[a-f0-9-]{36}$/.test(params.client_id || '')) {
      const redirect = new URL(params.redirect_uri);
      if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash || params.redirect_uri.length > 2048) throw new Error('无效回调。');
      client = { redirects: [params.redirect_uri] };
    }
    if (!client || !client.redirects.includes(params.redirect_uri) || params.response_type !== 'code' ||
        params.code_challenge_method !== 'S256' || !/^[a-zA-Z0-9_-]{43}$/.test(params.code_challenge || '') ||
        (params.resource && params.resource !== resource) || String(params.state || '').length > 2048) throw new Error('无效的授权请求。');
    const scope = params.scope || 'camera';
    if (typeof scope !== 'string' || scope.split(' ').some((value) => !['camera', 'offline_access'].includes(value))) throw new Error('无效的权限范围。');
    return { clientId: params.client_id, redirect: params.redirect_uri, challenge: params.code_challenge,
      state: params.state || '', scope, expires: now() + 60000 };
  }
  function issue(grant) {
    if (access.size >= 1000 || refresh.size >= 1000) throw new Error('授权数量已达上限。');
    const accessToken = randomToken(), refreshToken = randomToken();
    access.set(accessToken, { clientId: grant.clientId, scope: grant.scope, expires: now() + 3600000 });
    refresh.set(refreshToken, { clientId: grant.clientId, scope: grant.scope, expires: now() + 30 * 86400000 });
    persist();
    return { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: refreshToken, scope: grant.scope };
  }
  function exchange(params) {
    prune();
    if (params.resource && params.resource !== resource) throw new Error('invalid_target');
    if (params.grant_type === 'authorization_code') {
      const grant = codes.get(params.code);
      if (!grant || grant.clientId !== params.client_id || grant.redirect !== params.redirect_uri ||
          !/^[a-zA-Z0-9._~-]{43,128}$/.test(params.code_verifier || '') ||
          createHash('sha256').update(params.code_verifier).digest('base64url') !== grant.challenge) throw new Error('invalid_grant');
      codes.delete(params.code);
      return issue(grant);
    }
    if (params.grant_type === 'refresh_token') {
      const grant = refresh.get(params.refresh_token);
      if (!grant || grant.clientId !== params.client_id) throw new Error('invalid_grant');
      refresh.delete(params.refresh_token);
      return issue(grant);
    }
    throw new Error('unsupported_grant_type');
  }
  function verifyAccess(token) {
    prune();
    return Boolean(access.get(token)?.scope.split(' ').includes('camera'));
  }
  function approve(params, password) {
    const grant = authorize(params, true);
    if (!bearerValid(`Bearer ${password || ''}`, loginToken)) throw new Error('访问密码错误。');
    if (!clients.has(grant.clientId)) {
      if (clients.size >= 1000) throw new Error('注册数量已达上限。');
      clients.set(grant.clientId, { redirects: [grant.redirect], expires: now() + 30 * 86400000 });
      persist();
    }
    if (codes.size >= 1000) throw new Error('授权数量已达上限。');
    const code = randomToken(); codes.set(code, grant);
    const redirect = new URL(grant.redirect);
    redirect.searchParams.set('code', code);
    if (grant.state) redirect.searchParams.set('state', grant.state);
    return redirect.toString();
  }
  function mount(app) {
    app.use('/oauth', express.urlencoded({ extended: false, limit: '16kb' }));
    for (const endpoint of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      app.get(endpoint, (req, res) => res.json({ resource, authorization_servers: [baseUrl], scopes_supported: ['camera'], bearer_methods_supported: ['header'] }));
    }
    app.get('/.well-known/oauth-authorization-server', (req, res) => res.json({ issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`, token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: ['camera', 'offline_access'] }));
    app.post('/oauth/register', (req, res) => {
      try { res.status(201).json(register(req.body)); }
      catch { res.status(400).json({ error: 'invalid_client_metadata' }); }
    });
    app.get('/oauth/authorize', (req, res) => {
      try {
        const grant = authorize(req.query, true);
        const fields = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
        const hidden = fields.filter((key) => typeof req.query[key] === 'string').map((key) => `<input type="hidden" name="${key}" value="${escapeHtml(req.query[key])}">`).join('');
        res.set('Cache-Control', 'no-store').set('Content-Security-Policy', consentPolicy(grant.redirect))
          .type('html').send(consentPage('授权摄像头访问', '允许此客户端查看摄像头画面并生成录像。', `
            <dl><dt>授权完成后返回</dt><dd>${escapeHtml(new URL(grant.redirect).origin)}</dd></dl>
            <form method="post" action="${escapeHtml(authorizePath)}">${hidden}
              <label>访问密码<input name="password" type="password" required autocomplete="current-password"></label>
              <button type="submit">同意并连接</button>
            </form>`));
      } catch { consentError(res, 400, '授权请求无效', '请返回客户端，重新发起连接。'); }
    });
    app.post('/oauth/authorize', (req, res) => {
      prune();
      const key = req.ip, attempt = attempts.get(key) || { count: 0, expires: now() + 60000 };
      attempt.count++; attempts.set(key, attempt);
      if (attempt.count > 20 || attempts.size > 1000) return consentError(res, 429, '请求过多', '请稍后返回客户端，重新发起连接。');
      try {
        const redirect = approve(req.body, req.body.password);
        res.set('Cache-Control', 'no-store').set('Content-Security-Policy', consentPolicy(redirect)).redirect(303, redirect);
      }
      catch { consentError(res, 400, '授权失败', '请核对访问密码，然后返回客户端重新连接。'); }
    });
    app.post('/oauth/token', (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json(exchange(req.body)); }
      catch { res.status(400).json({ error: 'invalid_grant' }); }
    });
  }
  return { mount, register, authorize, approve, exchange, verifyAccess, resource };
}

