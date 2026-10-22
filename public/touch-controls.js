import { iconSvg } from './ui-primitives.js';
// Shared in-page controls. Native dialog supplies focus trapping and inert background;
// closing is explicit so touching outside a sheet never discards an edit.
export let activeDialog = null;
const CLOSE_ICON = iconSvg('clear');
// Keep the document fixed while any native dialog is open, including replacements.
const backgroundDialogs = new Set();
let backgroundScroll = null;
function lockDialogBackground(dialog) {
  const root = document.documentElement;
  if (!root?.classList || !window.scrollTo) return () => {};
  if (!backgroundDialogs.size) {
    backgroundScroll = { x: window.scrollX, y: window.scrollY, top: root.style.getPropertyValue('--dialog-page-top'), locked: root.classList.contains('dialog-scroll-locked') };
    root.style.setProperty('--dialog-page-top', `${-backgroundScroll.y}px`);
    root.classList.add('dialog-scroll-locked');
  }
  backgroundDialogs.add(dialog);
  return () => {
    if (!backgroundDialogs.delete(dialog) || backgroundDialogs.size) return;
    const saved = backgroundScroll; backgroundScroll = null;
    if (!saved.locked) root.classList.remove('dialog-scroll-locked');
    if (saved.top) root.style.setProperty('--dialog-page-top', saved.top); else root.style.removeProperty('--dialog-page-top');
    window.scrollTo(saved.x, saved.y);
  };
}
const dateStart = date => new Date(`${date}T00:00:00+08:00`).getTime();
function addButton(parent, label, className, action) { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.addEventListener('click', action); parent.append(button); return button; }
export function openDialog(title, description = '', { trackChanges = true, initialDirty = false } = {}) {
  activeDialog?.close();
  const previous = document.activeElement;
  const dialog = document.createElement('dialog'); dialog.className = 'app-dialog';
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  const head = document.createElement('div'); head.className = 'dialog-head';
  const heading = document.createElement('h2'); heading.id = 'dialog-title'; heading.textContent = title; heading.tabIndex = -1;
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'icon-button dialog-close'; closeButton.title = '关闭'; closeButton.innerHTML = CLOSE_ICON; closeButton.setAttribute('aria-label', '关闭');
  head.append(heading, closeButton);
  const content = document.createElement('div'); content.className = 'dialog-body';
  const copy = document.createElement('p'); copy.className = 'dialog-description'; copy.textContent = description; copy.hidden = !description; content.append(copy);
  const error = document.createElement('p'); error.className = 'dialog-error'; error.setAttribute('role', 'alert');
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  dialog.append(head, content, error, actions); document.body.append(dialog);
  let pending = false, dirty = Boolean(initialDirty), discardRequested = false; const disabledBeforePending = new Map();
  const close = () => {
    if (pending) return;
    if (dirty && !discardRequested) { discardRequested = true; error.textContent = '有未保存的修改，再次关闭将放弃修改。'; closeButton.textContent = '放弃'; return; }
    dialog.close();
  };
  dialog.addEventListener('input', () => { if (!trackChanges) return; dirty = true; discardRequested = false; closeButton.innerHTML = CLOSE_ICON; });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { if (event.target !== dialog) return; event.preventDefault(); close(); });
  const releaseBackground = lockDialogBackground(dialog);
  const detachViewport = fitDialogViewport(dialog);
  dialog.addEventListener('close', () => {
    detachViewport(); dialog.remove(); releaseBackground();
    if (activeDialog !== dialog) return;
    activeDialog = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    else document.querySelector('[data-view][aria-current="page"]')?.focus({ preventScroll: true });
  });
  activeDialog = dialog;
  try { dialog.showModal(); heading.focus({ preventScroll: true }); }
  catch (error) { detachViewport(); dialog.remove(); releaseBackground(); if (activeDialog === dialog) activeDialog = null; throw error; }
  return { dialog, content, error, actions, close: () => dialog.close(), setPending(value) { pending = value; dialog.setAttribute('aria-busy', String(value)); dialog.querySelectorAll('button, input').forEach(node => { if (value) { if (!disabledBeforePending.has(node)) disabledBeforePending.set(node, node.disabled); node.disabled = true; } else { node.disabled = disabledBeforePending.get(node) ?? node.disabled; } }); if (!value) disabledBeforePending.clear(); } };
}
// iOS Safari keeps layout viewport height when its keyboard opens. Anchor sheets
// to the *visual* viewport instead, and keep focus handling in the original tap.
export function fitDialogViewport(dialog) {
  const viewport = window.visualViewport;
  let frame = null, closed = false;
  const update = () => {
    frame = null;
    if (closed) return;
    const top = viewport?.offsetTop ?? 0;
    const height = Math.max(0, Math.min(window.innerHeight, top + (viewport?.height ?? window.innerHeight)) - top);
    const bottom = Math.max(0, window.innerHeight - height - top);
    dialog.style.setProperty('--dialog-viewport-height', `${height}px`);
    dialog.style.setProperty('--dialog-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    dialog.style.setProperty('--dialog-keyboard-inset', `${bottom}px`);
    const focused = document.activeElement;
    if (focused && dialog.contains(focused) && focused.matches('input, textarea, select')) {
      const field = focused.getBoundingClientRect(), box = dialog.getBoundingClientRect();
      const actions = dialog.querySelector('.dialog-actions');
      const floor = actions ? Math.min(box.bottom, actions.getBoundingClientRect().top) : box.bottom;
      if (field.bottom > floor - 12) dialog.scrollTop += field.bottom - floor + 12;
      else if (field.top < box.top + 12) dialog.scrollTop -= box.top + 12 - field.top;
    }
  };
  const schedule = () => { if (frame === null && !closed) frame = requestAnimationFrame(update); };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  dialog.addEventListener('focusin', schedule);
  update();
  return () => {
    closed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    dialog.removeEventListener('focusin', schedule);
  };
}
export function labelledInput(parent, label, value, { placeholder = '', maxLength = 255 } = {}) {
  const wrap = document.createElement('label'); wrap.className = 'field';
  const text = document.createElement('span'); text.textContent = label;
  const input = document.createElement('input'); input.type = 'text'; input.value = value; input.placeholder = placeholder; input.maxLength = maxLength;
  wrap.append(text, input); parent.append(wrap); return input;
}
export function mp4Basename(value) { return value.replace(/(?:\.mp4)+$/i, ''); }
export function normalizeMp4Name(value) {
  const name = mp4Basename(value.trim());
  if (!name || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('请输入文件名，不要包含路径或控制字符。');
  return `${name}.mp4`;
}
export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function formatTimeDigits(value, caret = value.length) {
  if (!/^[0-9:\s]*$/.test(value) || value.replace(/\D/g, '').length > 6) return { value, caret };
  const parts = value.trim().split(':');
  if (parts.length > 1 && (parts.length > 3 || parts.slice(0, -1).some(part => part.length !== 2) || (parts.length === 3 && parts.at(-1).length > 2))) return { value, caret };
  const digits = value.replace(/\D/g, '');
  const count = Math.min(digits.length, value.slice(0, caret).replace(/\D/g, '').length);
  const formatted = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)].filter(Boolean).join(':');
  return { value: formatted, caret: count + (count > 2 ? 1 : 0) + (count > 4 ? 1 : 0) };
}
export function enhanceTimeInput(input) {
  input.inputMode = 'numeric'; input.autocomplete = 'off'; input.setAttribute('aria-description', '直接输入四位或六位数字，例如 201530 自动变为 20:15:30');
  input.addEventListener('input', event => {
    if (event.isComposing) return;
    const formatted = formatTimeDigits(input.value, input.selectionStart ?? input.value.length);
    input.value = formatted.value; input.setSelectionRange(formatted.caret, formatted.caret);
  });
  input.addEventListener('beforeinput', event => {
    const start = input.selectionStart, end = input.selectionEnd;
    if (start !== end) return;
    const back = event.inputType === 'deleteContentBackward', forward = event.inputType === 'deleteContentForward';
    if (back && input.value[start - 1] === ':' || forward && input.value[start] === ':') {
      event.preventDefault();
      const from = back ? Math.max(0, start - 2) : start + 1, to = from + 1;
      const formatted = formatTimeDigits(input.value.slice(0, from) + input.value.slice(to), from);
      input.value = formatted.value; input.setSelectionRange(formatted.caret, formatted.caret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  return input;
}
export function rangeTimeMs(value, date, allowMidnight = false) {
  const text = /^\d{4}(?:\d{2})?$/.test(value.trim()) ? formatTimeDigits(value.trim()).value : value.trim();
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) throw new Error('请输入完整时间：4 位或 6 位数字，例如 201530（20:15:30）。');
  const [hour, minute, second] = match.slice(1).map(part => Number(part || 0));
  if (minute > 59 || second > 59 || hour > 23 && !(allowMidnight && hour === 24 && minute === 0 && second === 0)) throw new Error('请输入有效时间；结束时间可用 24:00 表示当天结束。');
  return dateStart(date) + (hour * 3600 + minute * 60 + second) * 1000;
}
export function enhanceSelect(select) {
  select.hidden = true; select.tabIndex = -1;
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'control-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-label', select.getAttribute('aria-label') || '选择');
  select.after(trigger);
  const sync = () => { trigger.textContent = `${select.selectedOptions[0]?.textContent || '请选择'} ▾`; trigger.disabled = select.disabled; };
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });
  select.addEventListener('change', sync); select.addEventListener('controlsync', sync); sync();
  trigger.addEventListener('click', () => {
    const sheet = openDialog(select.getAttribute('aria-label') || '请选择');
    const list = document.createElement('div'); list.className = 'choice-list'; sheet.content.append(list);
    for (const option of select.options) {
      const button = addButton(list, `${option.textContent}${option.selected ? ' ✓' : ''}`, 'choice-option', () => {
        select.value = option.value; sync(); sheet.close(); select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      button.disabled = option.disabled; button.setAttribute('aria-pressed', String(option.selected));
    }
    (list.querySelector('[aria-pressed="true"]') || list.querySelector('button:not(:disabled)'))?.focus();
  });
}
export function mountCalendar(parent, { value, today, onSelect }) {
  const wrap = document.createElement('div'); wrap.className = 'calendar-control'; parent.append(wrap);
  const input = labelledInput(wrap, '日期', value, { placeholder: '20260930 或 2026-09-30', maxLength: 10 });
  input.inputMode = 'numeric';
  input.setAttribute('aria-description', '可直接输入八位数字，例如 20260930，也支持 2026-09-30。');
  const error = document.createElement('p'); error.className = 'dialog-error'; error.setAttribute('role', 'alert');
  let month = new Date(`${value}T12:00:00Z`); if (!Number.isFinite(month.getTime())) month = new Date();
  month.setUTCDate(1);
  const bar = document.createElement('div'); bar.className = 'calendar-heading';
  const prev = addButton(bar, '‹', 'quiet-button', () => { month.setUTCMonth(month.getUTCMonth() - 1); draw(); }); prev.setAttribute('aria-label', '上个月');
  const label = document.createElement('strong'); bar.append(label);
  const next = addButton(bar, '›', 'quiet-button', () => { month.setUTCMonth(month.getUTCMonth() + 1); draw(); }); next.setAttribute('aria-label', '下个月');
  const weekdays = document.createElement('div'); weekdays.className = 'calendar-weekdays'; weekdays.setAttribute('aria-hidden', 'true');
  for (const name of ['一', '二', '三', '四', '五', '六', '日']) { const cell = document.createElement('span'); cell.textContent = name; weekdays.append(cell); }
  const grid = document.createElement('div'); grid.className = 'calendar-grid';
  wrap.append(bar, weekdays, grid, error);
  const choose = value => {
    value = value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (!isCalendarDate(value)) { error.textContent = '请输入有效日期，例如 20260930 或 2026-09-30。'; return; }
    error.textContent = ''; input.value = value; month = new Date(`${value.slice(0, 7)}-01T12:00:00Z`); draw(); onSelect(value);
  };
  function draw() {
    label.textContent = `${month.getUTCFullYear()} 年 ${month.getUTCMonth() + 1} 月`; grid.replaceChildren();
    const start = (month.getUTCDay() + 6) % 7, total = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    for (let i = 0; i < start; i++) grid.append(document.createElement('span'));
    for (let day = 1; day <= total; day++) {
      const value = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const button = addButton(grid, String(day), `calendar-day${value === input.value ? ' selected' : ''}${value === today() ? ' today' : ''}`, () => choose(value));
      button.setAttribute('aria-label', value); button.setAttribute('aria-pressed', String(value === input.value));
    }
  }
  addButton(wrap, '今天', 'quiet-button', () => choose(today()));
  input.addEventListener('change', () => choose(input.value));
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); choose(input.value); } });
  grid.addEventListener('keydown', event => { const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]; if (!delta) return; const days = [...grid.querySelectorAll('button')], index = days.indexOf(event.target); if (index < 0) return; event.preventDefault(); days[Math.max(0, Math.min(days.length - 1, index + delta))].focus(); });
  draw(); return wrap;
}
export function openCalendar({ value, today, onSelect, description = '点按日期立即选择，也可以直接输入。' }) {
  const sheet = openDialog('选择日期', description);
  mountCalendar(sheet.content, { value, today, onSelect: value => { sheet.close(); onSelect(value); } });
}

export function enhanceDateInput(input, { today, description } = {}) {
  input.hidden = true; input.tabIndex = -1;
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'control-trigger'; trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-label', input.getAttribute('aria-label') || '选择日期');
  const sync = () => { trigger.textContent = `${input.value || '选择日期'} ▾`; trigger.disabled = input.disabled; };
  trigger.addEventListener('click', () => openCalendar({ value: input.value, today, description, onSelect: value => { input.value = value; sync(); input.dispatchEvent(new Event('change', { bubbles: true })); } }));
  input.after(trigger); input.addEventListener('change', sync); input.addEventListener('controlsync', sync); sync(); return trigger;
}
