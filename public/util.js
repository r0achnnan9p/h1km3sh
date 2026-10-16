// Small shared helpers: time/size formatting + lightweight toast / confirm.

export const DAY_SECONDS = 86400;

export function secondsToTimeStr(seconds) {
  const s = Math.max(0, Math.min(DAY_SECONDS - 1, Math.floor(seconds)));
  const h = Math.floor(s / 3600).toString().padStart(2, '0');
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

export function timeStrToSeconds(timeStr) {
  const parts = (timeStr || '').split(':');
  return (parseInt(parts[0] || 0, 10) * 3600)
    + (parseInt(parts[1] || 0, 10) * 60)
    + parseInt(parts[2] || 0, 10);
}

// Compact Hikvision timestamp: "YYYY-MM-DD" + "HH:MM:SS" -> "YYYYMMDDTHHmmssZ"
export function formatHikTime(dateStr, timeStr) {
  return `${dateStr.replace(/-/g, '')}T${timeStr.replace(/:/g, '')}Z`;
}

// ISO like "2026-05-07T17:58:17Z" -> seconds within the day (wall-clock, no TZ math).
export function isoTimeToSeconds(iso) {
  const m = /T(\d{2}):(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

export function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// 字节/秒 → 带宽读数。传输层统一用字节/秒，只在这里 ×8 换成 bps，
// 方便和录像机标称的 Mbps 上限直接对照。
export function formatBitrate(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 Mbps';
  const bps = bytesPerSec * 8;
  if (bps < 1e6) return (bps / 1e3).toFixed(0) + ' Kbps';
  return (bps / 1e6).toFixed(1) + ' Mbps';
}

export function todayLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- HTML 转义 ---
// innerHTML 拼接动态数据（文件名/计划名/错误消息都可能是用户可控的）时必须先过这里，
// 否则一个叫 `x<img onerror=...>.mp4` 的文件就能在别人的页面上执行脚本。
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Toast ---

let toastContainer = null;

function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container'; toastContainer.setAttribute('role', 'status'); toastContainer.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

export function toast(message, type = 'info', duration = 3200) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  ensureToastContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// Keep keyboard focus within dialogs and restore it to their opener.
export function containDialogFocus(overlay) {
  const previous = document.activeElement;
  const siblings = [...document.body.children].filter(node => node !== overlay && !node.contains(overlay));
  const inertState = siblings.map(node => [node, node.inert]);
  siblings.forEach(node => { node.inert = true; });
  const onKey = event => {
    if (event.key !== 'Tab') return;
    const controls = [...overlay.querySelectorAll('button, input, select, textarea, [tabindex]')].filter(node => !node.disabled && node.tabIndex !== -1 && !node.hidden);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  overlay.addEventListener('keydown', onKey);
  return () => { overlay.removeEventListener('keydown', onKey); inertState.forEach(([node, value]) => { node.inert = value; }); if (previous?.isConnected) previous.focus(); };
}

export function confirmDialog(message, { confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div'); overlay.className = 'dialog-overlay';
    overlay.innerHTML = `<div class="dialog-content dialog-confirm" role="dialog" aria-modal="true" aria-label="确认操作"><p class="confirm-message"></p><div class="dialog-actions"><button class="btn btn-ghost" data-act="cancel"></button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok"></button></div></div>`;
    overlay.querySelector('.confirm-message').textContent = message;
    const cancel = overlay.querySelector('[data-act="cancel"]'), ok = overlay.querySelector('[data-act="ok"]');
    cancel.textContent = cancelText; ok.textContent = confirmText;
    document.body.appendChild(overlay); const releaseFocus = containDialogFocus(overlay);
    function close(result) { releaseFocus(); overlay.remove(); resolve(result); }
    cancel.addEventListener('click', () => close(false)); ok.addEventListener('click', () => close(true));
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); } });
    // Destructive confirmation starts on cancel; Enter only activates the focused button.
    (danger ? cancel : ok).focus();
  });
}

// Optional submit keeps failures in the editor without losing the user's name.
export function promptDialog(message, { defaultValue = '', confirmText = '确定', cancelText = '取消', placeholder = '', submit } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div'); overlay.className = 'dialog-overlay';
    overlay.innerHTML = `<div class="dialog-content dialog-prompt" role="dialog" aria-modal="true" aria-label="编辑名称"><label class="confirm-message" for="prompt-value"></label><input id="prompt-value" type="text" class="prompt-input mono" spellcheck="false"><p class="dialog-error" role="alert"></p><div class="dialog-actions"><button class="btn btn-ghost" data-act="cancel"></button><button class="btn btn-primary" data-act="ok"></button></div></div>`;
    overlay.querySelector('.confirm-message').textContent = message;
    const cancel = overlay.querySelector('[data-act="cancel"]'), ok = overlay.querySelector('[data-act="ok"]'), input = overlay.querySelector('input'), error = overlay.querySelector('.dialog-error');
    cancel.textContent = cancelText; ok.textContent = confirmText; input.value = defaultValue; input.placeholder = placeholder;
    document.body.appendChild(overlay); const releaseFocus = containDialogFocus(overlay);
    let pending = false, discardRequested = false;
    function close(result) { releaseFocus(); overlay.remove(); resolve(result); }
    function cancelEdit() {
      if (pending) return;
      if (input.value !== defaultValue && !discardRequested) { discardRequested = true; error.textContent = '有未保存的修改，再次取消将放弃修改。'; cancel.textContent = '放弃修改'; return; }
      close(null);
    }
    async function save() {
      if (pending) return;
      const value = input.value.trim(); if (!value) { error.textContent = '请输入名称。'; input.focus(); return; }
      pending = true; ok.disabled = cancel.disabled = input.disabled = true; ok.textContent = '正在保存…'; error.textContent = '';
      try { if (submit) await submit(value); close(value); }
      catch (failure) { error.textContent = failure.message || '保存失败，请重试。'; pending = false; ok.disabled = cancel.disabled = input.disabled = false; ok.textContent = confirmText; input.focus(); }
    }
    cancel.addEventListener('click', cancelEdit); ok.addEventListener('click', save);
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
      else if (event.key === 'Enter' && !event.isComposing && event.target === input) { event.preventDefault(); save(); }
    });
    input.focus(); input.select();
  });
}
