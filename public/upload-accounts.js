import { setButtonIcon } from './ui-primitives.js';
// Provider account linking is isolated from settings edits and task SSE updates.
// The browser never accepts provider passwords, arbitrary QR URLs or credentials.
const PROVIDERS = { bilibili: '哔哩哔哩', cloud189: '天翼云盘' };
const ACTIVE = new Set(['waiting_scan', 'waiting_confirmation', 'verifying']);
const COPY = {
  unknown: ['账号状态未知', '请重新检测账号状态。'],
  unverified: ['登录待验证', '已有登录信息，请重新检测。'],
  unavailable: ['连接暂不可用', '扫码组件未就绪，请部署后重新检测。'],
  disconnected: ['未连接', ''],
  waiting_scan: ['等待扫码', '请使用平台官方 App 扫描二维码。'],
  waiting_confirmation: ['请在手机上确认', '已扫描二维码，请在官方 App 内确认本次登录。'],
  verifying: ['正在验证连接', '正在核实平台登录结果。'],
  connected: ['账号已连接', ''],
  expired: ['二维码已过期', '请重新生成二维码。'],
  cancelled: ['连接已取消', '可重新扫码连接。'],
  needs_login: ['需要重新登录', '登录状态已失效，请重新扫码连接。'],
  error: ['连接未完成', '请重试或重新检测。'],
};
export function accountPresentation(account = {}) {
  account ||= {};
  const state = account.state === 'disconnected' && account.credentialsPresent ? 'unverified' : account.state;
  const [label, detail] = COPY[state] || COPY.unknown;
  return { label, detail, ready: account.state === 'connected', active: ACTIVE.has(account.state), unavailable: account.available === false || account.state === 'unavailable' };
}

export function createUploadAccounts({ document = globalThis.document, request, resolveUrl = value => value, openDialog, onConnected = () => {}, onNotice = () => {}, onReauthenticate = () => {}, schedule = setTimeout, cancelSchedule = clearTimeout } = {}) {
  const mounts = new Map(), operations = new Map(), cancelledAttempts = new Set(); let csrfToken = '', refreshId = 0, lifecycle = 0, dialog = null, reauthRequired = false;
  const endpoint = provider => `/console/api/upload-accounts/${provider}`;
  const write = async (provider, action, values = {}) => {
    try { return await request(`${endpoint(provider)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(values), ...(globalThis.AbortSignal?.timeout ? { signal: AbortSignal.timeout(10000) } : {}) }); }
    catch (error) { if (error.code === 'SESSION_REAUTH_REQUIRED') { setReauthRequired(true); error.message = '连接上传账号前，请重新登录一次。现有控制台会话仍可正常使用，未保存的平台设置会保留。'; } throw error; }
  };
  const button = (parent, text, className, action) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.className = className; node.addEventListener('click', action); parent.append(node); return node;
  };
  for (const [provider, name] of Object.entries(PROVIDERS)) {
    const root = document.getElementById(`upload-account-${provider}`); if (!root) continue;
    const head = document.createElement('div'); head.className = 'account-connection-head';
    const state = document.createElement('strong'); state.textContent = '检测账号连接…'; state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    head.append(state);
    const detail = document.createElement('p'); detail.className = 'setting-help'; detail.textContent = ''; detail.setAttribute('role', 'status');
    const actions = document.createElement('div'); actions.className = 'account-actions';
    const connect = button(actions, '连接账号', 'secondary-button', () => show(provider)); connect.disabled = true;
    const verify = setButtonIcon(button(actions, '', 'quiet-button ui-icon-button', () => verifyAccount(provider)), 'refresh', '重新检测账号');
    const disconnect = button(actions, '断开账号', 'quiet-button', () => disconnectAccount(provider)); disconnect.hidden = true;
    const reauth = document.createElement('div'); reauth.className = 'account-reauth'; reauth.hidden = true;
    const reauthCopy = document.createElement('p'); reauthCopy.textContent = '重新登录一次后可管理上传账号。';
    reauth.append(reauthCopy); const reauthButton = button(reauth, '前往重新登录', 'secondary-button', onReauthenticate);
    root.append(head, detail, actions, reauth); mounts.set(provider, { root, state, detail, connect, verify, name, disconnect, reauth, reauthButton, account: null });
  }
  function setReauthRequired(value) {
    reauthRequired = value === true;
    for (const mount of mounts.values()) {
      mount.reauth.hidden = !reauthRequired;
      if (mount.account) render(mount.account);
      else if (reauthRequired) { mount.state.textContent = '需重新登录控制台'; mount.detail.textContent = ''; mount.connect.disabled = mount.verify.disabled = mount.disconnect.disabled = true; }
    }
  }
  function render(account) {
    const mount = mounts.get(account?.provider); if (!mount) return;
    mount.account = account; const presentation = accountPresentation(account);
    mount.state.textContent = reauthRequired ? '需重新登录控制台' : presentation.label;
    mount.detail.textContent = reauthRequired ? '' : presentation.detail;
    mount.state.classList.toggle('ready', !reauthRequired && presentation.ready);
    mount.connect.disabled = presentation.unavailable || reauthRequired;
    mount.connect.textContent = presentation.ready || account.credentialsPresent ? '重新连接' : presentation.active ? '查看连接' : '连接账号';
    mount.disconnect.hidden = !(account.credentialsPresent || presentation.ready);
    mount.disconnect.disabled = presentation.active || reauthRequired;
    mount.verify.disabled = reauthRequired || presentation.active || operations.has(account.provider);
  }
  async function refresh() {
    const id = ++refreshId;
    try {
      const data = await request('/console/api/upload-accounts');
      if (id !== refreshId) return;
      csrfToken = data.csrfToken || csrfToken; setReauthRequired(data.reauthRequired === true);
      for (const account of data.accounts || []) render(account);
    } catch (error) {
      if (id !== refreshId) return;
      if (error.status === 401 || error.code === 'SESSION_REAUTH_REQUIRED') setReauthRequired(true);
      for (const mount of mounts.values()) {
        mount.state.classList.toggle('ready', false);
        mount.state.textContent = reauthRequired ? '需重新登录控制台' : '账号状态未知';
        mount.detail.textContent = reauthRequired ? '' : error.status === 404 ? '账号接口不可用，请更新服务后重新检测。' : '暂时无法读取，请重新检测。';
      }
      throw error;
    }
  }
  async function verifyAccount(provider) {
    const mount = mounts.get(provider); if (!mount || mount.verify.disabled) return;
    mount.verify.disabled = true; mount.verify.setAttribute('aria-busy', 'true'); setButtonIcon(mount.verify, 'refresh', '正在检测账号'); const epoch = lifecycle;
    try {
      if (!csrfToken) await refresh();
      const data = await write(provider, 'verify');
      if (epoch !== lifecycle) { await cancelAttempt({ provider, attemptId: data.account?.attempt?.id }); return; }
      const result = await settleOperation(provider, data.account);
      if (result) { render(result); if (result.state === 'connected') await Promise.resolve(onConnected(provider, { accountChanged: false })).catch(() => {}); }
    } catch (error) { mount.detail.textContent = error.message || '检测失败，请重试。'; }
    finally { mount.verify.disabled = reauthRequired; mount.verify.setAttribute('aria-busy', 'false'); setButtonIcon(mount.verify, 'refresh', '重新检测账号'); }
  }
  function disconnectAccount(provider) {
    const sheet = openDialog(`断开${PROVIDERS[provider]}账号？`, '将删除此服务器保存的该平台登录令牌，断开后无法继续上传。已有排队任务不会自动转给重新连接的账号，需要重新提交。已上传到平台的文件不会删除。', { trackChanges: false });
    button(sheet.actions, '保留连接', 'quiet-button', () => sheet.close());
    const confirm = button(sheet.actions, '断开并删除登录', 'danger-button', async () => {
      if (confirm.disabled) return; sheet.setPending(true); sheet.error.textContent = ''; const epoch = lifecycle;
      try {
        const data = await write(provider, 'disconnect');
        if (epoch !== lifecycle) { await cancelAttempt({ provider, attemptId: data.account?.attempt?.id }); sheet.close(); return; }
        const result = await settleOperation(provider, data.account);
        if (!result) { sheet.close(); return; }
        render(result);
        if (result.state !== 'disconnected') throw new Error(accountPresentation(result).detail);
        await Promise.resolve(onConnected(provider, { accountChanged: true })).catch(() => {}); sheet.close(); onNotice('账号已断开，服务器登录令牌已删除。');
      }
      catch (error) { sheet.setPending(false); sheet.error.textContent = error.message || '断开失败，请重试。'; }
    });
  }
  function settleOperation(provider, account) {
    if (!account || account.provider !== provider || !COPY[account.state]) return Promise.reject(new Error('服务器尚未确认账号状态，请重新检测。'));
    render(account);
    if (!ACTIVE.has(account?.state)) return Promise.resolve(account);
    if (!account.attempt?.id) return Promise.reject(new Error('操作状态缺少确认信息，请重新检测。'));
    return new Promise((resolve, reject) => {
      const operation = { provider, attemptId: account.attempt.id, expiresAt: Date.parse(account.attempt.expiresAt) || Date.now() + 300000, timer: null, closed: false, terminal: false, cancelSent: false, finish: () => resolve(null) };
      operations.set(provider, operation);
      const finish = (result, error) => {
        operation.closed = true; operation.terminal = true; cancelSchedule(operation.timer);
        if (operations.get(provider) === operation) operations.delete(provider);
        if (error) reject(error); else resolve(result);
      };
      const poll = async () => {
        if (operation.closed) return;
        if (Date.now() >= operation.expiresAt) { finish(null, new Error('操作确认已超时，请重新检测账号状态。')); return; }
        try {
          const data = await request(`${endpoint(provider)}/status?attemptId=${encodeURIComponent(operation.attemptId)}`);
          if (operation.closed) return;
          if (!data.account || data.account.provider !== provider || !COPY[data.account.state]) { finish(null, new Error('服务器尚未确认操作结果，请重新检测。')); return; }
          render(data.account);
          if (!ACTIVE.has(data.account?.state)) { finish(data.account); return; }
        } catch (error) {
          if (operation.closed) return;
          if ([401, 404, 410].includes(error.status)) { finish(null, error); return; }
          const mount = mounts.get(provider); if (mount) mount.detail.textContent = '暂时无法同步，正在重新检查操作结果…';
        }
        operation.timer = schedule(poll, 1500);
      };
      operation.timer = schedule(poll, 1500);
    });
  }
  async function cancelAttempt(session) {
    if (!session.attemptId || session.terminal || session.cancelSent || cancelledAttempts.has(session.attemptId)) return;
    session.cancelSent = true; cancelledAttempts.add(session.attemptId);
    try { const data = await write(session.provider, 'cancel', { attemptId: session.attemptId }); if (dialog === session || !dialog) render(data.account); }
    catch { /* Closing stays local; a session-bound attempt also expires on the server. */ }
  }
  function show(provider) {
    const mount = mounts.get(provider); if (!mount || accountPresentation(mount.account).unavailable || reauthRequired) return;
    // Opening another dialog closes the old one and cancels only its own attempt.
    const replacing = Boolean(mount.account?.credentialsPresent);
    const description = '扫码并在官方 App 确认后，登录令牌会保存到此服务器，用于你提交的上传任务，可随时断开。此页面不会接收平台密码。完成连接且配置就绪后即可提交上传；已有排队任务不会自动转给重新连接的账号，需要重新提交。' + (replacing ? '\n本次连接将替换服务器已有的该平台登录，请确认后再生成二维码。' : '');
    const sheet = openDialog(`连接${PROVIDERS[provider]}`, description, { trackChanges: false });
    const session = { provider, sheet, operation: 'connect', attemptId: null, expiresAt: null, closed: false, terminal: false, cancelSent: false, timer: null, qrUrl: '', requestId: 0 };
    dialog = session; sheet.dialog.classList.add('account-dialog');
    const visual = document.createElement('div'); visual.className = 'account-qr';
    const image = document.createElement('img'); image.alt = `${PROVIDERS[provider]}登录二维码`; image.hidden = true;
    const placeholder = document.createElement('p'); placeholder.textContent = '准备好手机后，再生成登录二维码'; visual.append(image, placeholder);
    const state = document.createElement('p'); state.className = 'account-scan-state'; state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
    const detail = document.createElement('p'); detail.className = 'setting-help';
    sheet.content.append(visual, state, detail);
    const close = button(sheet.actions, '取消', 'quiet-button', () => sheet.close());
    const start = button(sheet.actions, replacing ? '确认替换并生成二维码' : '生成登录二维码', 'primary-button', begin);
    sheet.dialog.addEventListener('close', () => {
      session.closed = true; session.requestId++; cancelSchedule(session.timer);
      if (dialog === session) dialog = null;
      void cancelAttempt(session);
    });
    image.addEventListener('error', () => {
      if (session.closed || session.terminal) return;
      image.hidden = true; placeholder.hidden = false; placeholder.textContent = '二维码尚未就绪，正在重新读取…'; session.qrUrl = '';
    });
    function update(account) {
      if (session.closed || dialog !== session) return;
      render(account); const presentation = accountPresentation(account);
      if (account.attempt?.id) session.attemptId = account.attempt.id;
      if (account.attempt?.operation) session.operation = account.attempt.operation;
      if (account.attempt?.expiresAt) session.expiresAt = Date.parse(account.attempt.expiresAt);
      session.terminal = !presentation.active;
      state.textContent = presentation.label; detail.textContent = presentation.detail;
      const showQr = account.attempt?.qrReady && ['waiting_scan', 'waiting_confirmation'].includes(account.state);
      image.hidden = !showQr; placeholder.hidden = Boolean(showQr);
      if (showQr) {
        const url = resolveUrl(`${endpoint(provider)}/qr?attemptId=${encodeURIComponent(session.attemptId)}`);
        if (session.qrUrl !== url) { session.qrUrl = url; image.src = url; }
      } else { image.removeAttribute('src'); session.qrUrl = ''; placeholder.textContent = presentation.ready ? '连接成功' : account.state === 'verifying' ? '正在验证登录状态…' : presentation.detail; }
      start.hidden = presentation.active || presentation.ready;
      start.disabled = false; start.textContent = '重新生成二维码';
      close.textContent = presentation.ready ? '完成' : presentation.active ? '取消连接' : '关闭';
      if (presentation.ready) { const accountChanged = session.operation !== 'verify'; if (accountChanged) detail.textContent = '账号已连接。配置就绪后即可提交上传；原排队任务需要重新提交。'; void Promise.resolve(onConnected(provider, { accountChanged })).catch(() => {}); }
      if (presentation.active) session.timer = schedule(poll, 1500);
    }
    async function poll() {
      if (session.closed || session.terminal || !session.attemptId) return;
      if (session.expiresAt && Date.now() >= session.expiresAt) { update({ provider, available: true, state: 'expired', attempt: null }); return; }
      const id = ++session.requestId;
      try {
        const data = await request(`${endpoint(provider)}/status?attemptId=${encodeURIComponent(session.attemptId)}`);
        if (!session.closed && id === session.requestId) { sheet.error.textContent = ''; update(data.account); }
      } catch (error) {
        if (session.closed || id !== session.requestId) return;
        sheet.error.textContent = error.status === 401 ? '登录状态已过期，请重新登录控制台。' : '暂时无法同步连接状态，正在重试。';
        if (error.status === 401 || error.status === 410 || error.status === 404) {
          session.terminal = true; image.hidden = true; image.removeAttribute('src'); placeholder.hidden = false; placeholder.textContent = '本次连接已结束'; start.hidden = false; start.disabled = error.status === 401; start.textContent = '重新生成二维码';
        } else session.timer = schedule(poll, 2500);
      }
    }
    async function begin() {
      if (start.disabled || session.closed) return;
      cancelSchedule(session.timer); start.disabled = true; start.textContent = '正在生成…'; sheet.error.textContent = ''; state.textContent = '正在准备安全连接';
      session.terminal = false; session.cancelSent = false;
      const id = ++session.requestId;
      try {
        if (!csrfToken) await refresh();
        const data = await write(provider, 'start', replacing ? { replace: true } : {});
        session.attemptId = data.account?.attempt?.id || null;
        if (session.closed || id !== session.requestId) { await cancelAttempt(session); return; }
        update(data.account);
      } catch (error) {
        if (session.closed || id !== session.requestId) return;
        session.terminal = true; sheet.error.textContent = error.message || '无法生成二维码，请重试。'; state.textContent = '连接未开始'; start.disabled = reauthRequired; start.textContent = '重试连接';
        if (error.code === 'SESSION_REAUTH_REQUIRED' && !session.reauthButton) session.reauthButton = button(sheet.actions, '前往重新登录', 'primary-button', onReauthenticate);
      }
    }
    if (mount.account?.attempt?.id && ACTIVE.has(mount.account.state)) update(mount.account);
  }
  async function stop() {
    refreshId++; lifecycle++; const pending = [];
    for (const operation of operations.values()) {
      operation.closed = true; cancelSchedule(operation.timer); pending.push(cancelAttempt(operation)); operation.finish();
    }
    operations.clear();
    const session = dialog;
    if (session) {
      session.closed = true; session.requestId++; cancelSchedule(session.timer); dialog = null;
      // Dispatch cancellation before logout revokes the session; close is idempotent.
      pending.push(cancelAttempt(session)); session.sheet.close();
    }
    await Promise.allSettled(pending);
  }

  return { refresh, stop, show, verifyAccount };
}
