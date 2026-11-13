import { iconSvg } from './ui-primitives.js';
// Shared in-page controls. Native dialog supplies focus trapping and inert background;
// closing is explicit so touching outside a sheet never discards an edit.
export let activeDialog = null;
const CLOSE_ICON = iconSvg('clear');
let nextDialogId = 0;
let requestActiveDismissal = null;

// Route changes and platform close requests go through the same draft/pending guard.
export function dismissActiveDialog(onDiscard) {
  return !activeDialog?.open || requestActiveDismissal(onDiscard);
}
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
// The same explicit choice protects a native sheet and the desktop settings pane.
export function createDiscardGuard(dialog, actions, error) {
  let prompt = null;
  function reset() {
    if (!prompt) return;
    prompt.remove(); prompt = null;
    actions.hidden = false; error.textContent = '';
    if (dialog.tagName === 'DIALOG') dialog.setAttribute('closedby', 'closerequest');
  }
  return {
    reset,
    get showing() { return Boolean(prompt); },
    ask(onDiscard) {
      if (prompt) return;
      const editor = document.activeElement;
      error.id ||= `discard-warning-${++nextDialogId}`;
      error.textContent = '有未保存的修改。要放弃这些修改吗？';
      prompt = document.createElement('div'); prompt.className = 'dialog-actions';
      const keep = addButton(prompt, '继续编辑', 'quiet-button', () => {
        reset();
        if (dialog.contains(editor)) editor.focus({ preventScroll: true });
        else dialog.querySelector('input:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
      });
      keep.setAttribute('aria-describedby', error.id);
      addButton(prompt, '放弃修改', 'danger-button', () => {
        reset(); onDiscard();
      });
      actions.hidden = true; dialog.append(prompt);
      if (dialog.tagName === 'DIALOG') dialog.setAttribute('closedby', 'none');
      keep.focus({ preventScroll: true });
    },
  };
}
export function openDialog(title, description = '', { trackChanges = true, initialDirty = false } = {}) {
  activeDialog?.close();
  const previous = document.activeElement;
  const dialog = document.createElement('dialog'); dialog.className = 'app-dialog';
  const titleId = `dialog-title-${++nextDialogId}`;
  dialog.setAttribute('aria-labelledby', titleId);
  const head = document.createElement('div'); head.className = 'dialog-head';
  const heading = document.createElement('h2'); heading.id = titleId; heading.textContent = title; heading.tabIndex = -1;
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.className = 'icon-button dialog-close'; closeButton.title = '关闭'; closeButton.innerHTML = CLOSE_ICON; closeButton.setAttribute('aria-label', '关闭');
  head.append(heading, closeButton);
  const content = document.createElement('div'); content.className = 'dialog-body';
  const copy = document.createElement('p'); copy.className = 'dialog-description'; copy.textContent = description; copy.hidden = !description; content.append(copy);
  if (description) { copy.id = `${titleId}-description`; dialog.setAttribute('aria-describedby', copy.id); }
  const error = document.createElement('p'); error.className = 'dialog-error'; error.setAttribute('role', 'alert');
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  dialog.append(head, content, error, actions); document.body.append(dialog);
  let pending = false, dirty = Boolean(initialDirty);
  const disabledBeforePending = new Map();
  const discard = createDiscardGuard(dialog, actions, error);
  function requestDismissal(onDiscard) {
    if (pending) return false;
    if (!dirty) { dialog.close(); return true; }
    discard.ask(() => {
      if (pending) return;
      dialog.close(); onDiscard?.();
    });
    return false;
  }
  dialog.addEventListener('input', () => {
    if (trackChanges) { dirty = true; discard.reset(); }
  });
  closeButton.addEventListener('click', () => requestDismissal());
  // Only a deliberate pull on the title area dismisses a phone sheet. Scrolling
  // the form never dismisses it, and repeated pulls never discard a draft.
  let pull = null;
  head.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary || closeButton.contains(event.target) || !window.matchMedia('(max-width: 600px)').matches) return;
    pull = { id: event.pointerId, x: event.clientX, y: event.clientY };
    head.setPointerCapture(event.pointerId);
  });
  head.addEventListener('pointerup', event => {
    if (pull?.id !== event.pointerId) return;
    const vertical = event.clientY - pull.y, horizontal = Math.abs(event.clientX - pull.x);
    pull = null;
    if (vertical >= 64 && vertical > horizontal * 2) requestDismissal();
  });
  head.addEventListener('lostpointercapture', () => { pull = null; });
  dialog.addEventListener('cancel', event => { if (event.target !== dialog) return; event.preventDefault(); requestDismissal(); });
  const releaseBackground = lockDialogBackground(dialog);
  const detachViewport = fitDialogViewport(dialog);
  dialog.addEventListener('close', () => {
    detachViewport(); dialog.remove(); releaseBackground();
    if (activeDialog !== dialog) return;
    activeDialog = null;
    requestActiveDismissal = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    else document.querySelector('[data-view][aria-current="page"]')?.focus({ preventScroll: true });
  });
  activeDialog = dialog;
  requestActiveDismissal = requestDismissal;
  try { dialog.showModal(); heading.focus({ preventScroll: true }); }
  catch (error) {
    detachViewport(); dialog.remove(); releaseBackground();
    if (activeDialog === dialog) { activeDialog = null; requestActiveDismissal = null; }
    throw error;
  }
  return {
    dialog, content, error, actions, close: () => dialog.close(), requestClose: requestDismissal,
    setPending(value) {
      pending = value;
      dialog.setAttribute('aria-busy', String(value));
      dialog.setAttribute('closedby', pending || discard.showing ? 'none' : 'closerequest');
      for (const node of dialog.querySelectorAll('button, input, select, textarea')) {
        if (pending) {
          if (!disabledBeforePending.has(node)) disabledBeforePending.set(node, node.disabled);
          node.disabled = true;
        } else if (disabledBeforePending.has(node)) {
          node.disabled = disabledBeforePending.get(node);
        }
      }
      if (!pending) disabledBeforePending.clear();
    },
  };
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
      const content = dialog.querySelector('.dialog-body');
      if (!content?.contains(focused)) return;
      const field = focused.getBoundingClientRect(), box = content.getBoundingClientRect();
      if (field.bottom > box.bottom - 12) content.scrollTop += field.bottom - box.bottom + 12;
      else if (field.top < box.top + 12) content.scrollTop -= box.top + 12 - field.top;
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
/**
 * Enter submits only after IME composition has ended. Safari on macOS can
 * dispatch the candidate-selection Enter after compositionend, when
 * isComposing is already false, so keep a short grace period for that key.
 */
export function bindEnterConfirm(input, confirm, { now = Date.now, grace = 120 } = {}) {
  let composing = false, compositionEndedAt = -Infinity;
  const start = () => { composing = true; };
  const end = event => { composing = false; compositionEndedAt = event?.timeStamp ?? now(); };
  const keydown = event => {
    if (event.key !== 'Enter') return;
    if (event.isComposing || event.keyCode === 229 || composing || Math.abs((event.timeStamp ?? now()) - compositionEndedAt) < grace) return;
    event.preventDefault();
    confirm(event);
  };
  input.addEventListener('compositionstart', start);
  input.addEventListener('compositionend', end);
  input.addEventListener('keydown', keydown);
  return () => {
    input.removeEventListener?.('compositionstart', start);
    input.removeEventListener?.('compositionend', end);
    input.removeEventListener?.('keydown', keydown);
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
  let cursor = new Date(`${isCalendarDate(value) ? value : today()}T12:00:00Z`);
  const dayButtons = new Map();
  function moveMonth(delta) {
    const lastDay = new Date(cursor);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + delta + 1, 0);
    cursor.setUTCMonth(cursor.getUTCMonth() + delta, Math.min(cursor.getUTCDate(), lastDay.getUTCDate()));
  }
  const bar = document.createElement('div'); bar.className = 'calendar-heading';
  const prev = addButton(bar, '‹', 'quiet-button', () => { moveMonth(-1); draw(); }); prev.setAttribute('aria-label', '上个月');
  const label = document.createElement('strong'); label.setAttribute('aria-live', 'polite'); bar.append(label);
  const next = addButton(bar, '›', 'quiet-button', () => { moveMonth(1); draw(); }); next.setAttribute('aria-label', '下个月');
  const weekdays = document.createElement('div'); weekdays.className = 'calendar-weekdays'; weekdays.setAttribute('aria-hidden', 'true');
  for (const name of ['一', '二', '三', '四', '五', '六', '日']) { const cell = document.createElement('span'); cell.textContent = name; weekdays.append(cell); }
  const grid = document.createElement('div'); grid.className = 'calendar-grid'; grid.setAttribute('role', 'grid');
  wrap.append(bar, weekdays, grid, error);

  function choose(date) {
    date = date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    if (!isCalendarDate(date)) { error.textContent = '请输入有效日期，例如 20260930 或 2026-09-30。'; return; }
    error.textContent = ''; input.value = date; cursor = new Date(`${date}T12:00:00Z`);
    draw(); onSelect(date);
  }
  function draw() {
    const month = new Date(cursor); month.setUTCDate(1);
    const monthKey = month.toISOString().slice(0, 7);
    label.textContent = `${month.getUTCFullYear()} 年 ${month.getUTCMonth() + 1} 月`;
    prev.disabled = monthKey === '0000-01'; next.disabled = monthKey === '9999-12';
    grid.setAttribute('aria-label', label.textContent);
    grid.setAttribute('aria-colcount', '7');
    grid.replaceChildren(); dayButtons.clear();
    const firstColumn = (month.getUTCDay() + 6) % 7;
    month.setUTCMonth(month.getUTCMonth() + 1, 0);
    const todayValue = today();
    let row;
    for (let index = 0; index < firstColumn + month.getUTCDate(); index++) {
      if (index % 7 === 0) {
        row = document.createElement('div'); row.setAttribute('role', 'row'); grid.append(row);
      }
      const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); row.append(cell);
      const day = index - firstColumn + 1;
      if (day < 1) continue;
      const date = `${monthKey}-${String(day).padStart(2, '0')}`;
      const selected = date === input.value;
      const button = addButton(cell, String(day), `calendar-day${selected ? ' selected' : ''}${date === todayValue ? ' today' : ''}`, () => choose(date));
      cell.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-label', date);
      if (date === todayValue) button.setAttribute('aria-current', 'date');
      button.tabIndex = day === cursor.getUTCDate() ? 0 : -1;
      dayButtons.set(date, button);
    }
  }
  addButton(wrap, '今天', 'quiet-button', () => choose(today()));
  input.addEventListener('change', () => choose(input.value));
  bindEnterConfirm(input, () => choose(input.value));
  grid.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const date = event.target.getAttribute('aria-label');
    if (event.target !== dayButtons.get(date)) return;
    const weekday = (cursor.getUTCDay() + 6) % 7;
    const days = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
    if (event.key === 'PageUp' || event.key === 'PageDown') moveMonth(event.key === 'PageUp' ? -1 : 1);
    else if (Object.hasOwn(days, event.key)) cursor.setUTCDate(cursor.getUTCDate() + days[event.key]);
    else return;
    // The date input accepts exactly four-digit years.
    const target = cursor.toISOString().slice(0, 10);
    if (!isCalendarDate(target)) { cursor = new Date(`${date}T12:00:00Z`); return; }
    event.preventDefault();
    if (!dayButtons.has(target)) draw();
    else { event.target.tabIndex = -1; dayButtons.get(target).tabIndex = 0; }
    dayButtons.get(target).focus();
  });
  grid.addEventListener('focusin', event => {
    const date = event.target.getAttribute('aria-label');
    if (event.target !== dayButtons.get(date)) return;
    const previous = dayButtons.get(cursor.toISOString().slice(0, 10));
    if (previous) previous.tabIndex = -1;
    cursor = new Date(`${date}T12:00:00Z`); event.target.tabIndex = 0;
  });
  draw(); return wrap;
}
export function openCalendar({ value, today, onSelect, description = '点按日期立即选择，也可以直接输入。' }) {
  const sheet = openDialog('选择日期', description);
  mountCalendar(sheet.content, { value, today, onSelect: date => {
    // Closing the focused text field can synchronously dispatch change after Enter.
    if (!sheet.dialog.open) return;
    sheet.close(); onSelect(date);
  } });
}

export function enhanceDateInput(input, { today, description } = {}) {
  input.hidden = true; input.tabIndex = -1;
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'control-trigger'; trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-label', input.getAttribute('aria-label') || '选择日期');
  const sync = () => { trigger.textContent = `${input.value || '选择日期'} ▾`; trigger.disabled = input.disabled; };
  trigger.addEventListener('click', () => openCalendar({ value: input.value, today, description, onSelect: value => { input.value = value; sync(); input.dispatchEvent(new Event('change', { bubbles: true })); } }));
  input.after(trigger); input.addEventListener('change', sync); input.addEventListener('controlsync', sync); sync(); return trigger;
}
