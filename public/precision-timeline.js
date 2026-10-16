import { precisionDelta, precisionSpan } from './precision-scrub.js';

// Pointer ownership is local; the caller owns recording time, playback and I/O.
export function createPrecisionTimeline({ element, getTime, getBounds, getContext, onStart, onMove, onCommit, onCancel, onError = () => {} }) {
  let gesture = null, pendingCommit = null, sequence = 0;
  const clamp = value => { const { start, end } = getBounds(); return Math.max(start, Math.min(end, value)); };
  function release(current) { if (element.hasPointerCapture?.(current.id)) element.releasePointerCapture(current.id); }
  function cancel({ restore = true } = {}) {
    sequence++;
    const previous = gesture || pendingCommit; gesture = null; pendingCommit = null;
    if (!previous) return;
    release(previous); onCancel({ restore: restore && getContext() === previous.context, time: previous.original });
  }
  function down(event) {
    if (gesture || event.isPrimary === false || event.button != null && event.button !== 0) return;
    const rect = element.getBoundingClientRect(); if (!(rect.width > 0)) return;
    const time = getTime(); if (!Number.isFinite(time)) return;
    if (pendingCommit) cancel({ restore: false });
    sequence++;
    const { start } = getBounds();
    const pressedTime = clamp(start + (event.clientX - rect.left) / rect.width * 86_400_000);
    gesture = { id: event.pointerId, context: getContext(), original: time, time, pressedTime, horizontal: false,
      x: event.clientX, startX: event.clientX, y: event.clientY, left: rect.left,
      width: rect.width, scale: rect.width / (element.clientWidth || rect.width), moved: false };
    try { element.setPointerCapture?.(event.pointerId); } catch { gesture = null; return; }
    onStart(); event.preventDefault();
    // 尚未区分点按与纵向拉远时，先保留当前时间，避免纵向精调发生跳变。
    onMove({ time: Math.floor(time / 1000) * 1000, span: 86_400_000, distance: 0 });
  }
  function move(event) {
    const current = gesture; if (!current || current.id !== event.pointerId) return;
    if (getContext() !== current.context) { cancel({ restore: false }); return; }
    const distance = Math.abs(event.clientY - current.y) / current.scale;
    current.moved ||= Math.hypot(event.clientX - current.startX, event.clientY - current.y) >= 6 * current.scale;
    if (!current.moved) return;
    if (!current.horizontal && Math.abs(event.clientX - current.startX) >= 6 * current.scale) {
      current.horizontal = true;
      // 先拉远再横移围绕原位置精调；直接横拖则从按下位置粗选。
      current.time = distance > 24 ? current.original : current.pressedTime;
      current.x = current.startX;
    }
    if (current.horizontal) {
      current.time = clamp(current.time + precisionDelta(event.clientX - current.x, current.width, distance));
      current.x = event.clientX;
    }
    onMove({ time: Math.floor(current.time / 1000) * 1000, span: precisionSpan(distance), distance }); event.preventDefault();
  }
  function up(event) {
    const current = gesture; if (!current || current.id !== event.pointerId) return;
    if (getContext() !== current.context) { cancel({ restore: false }); return; }
    // Never read release coordinates after a drag. A tap uses the initial press.
    const { start, end } = getBounds();
    const raw = current.moved ? current.time : current.pressedTime;
    const time = Math.max(start, Math.min(end, Math.floor(raw / 1000) * 1000));
    if (!current.moved) onMove({ time, span: 86_400_000, distance: 0 });
    gesture = null; pendingCommit = current; release(current); event.preventDefault();
    const version = sequence;
    Promise.resolve().then(() => {
      if (version !== sequence) return;
      pendingCommit = null;
      if (getContext() !== current.context) { onCancel({ restore: false, time: current.original }); return; }
      return onCommit(time);
    }).catch(onError);
  }
  const abort = event => { if (gesture?.id === event.pointerId) cancel(); };
  const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', abort], ['lostpointercapture', abort]];
  for (const [name, handler] of listeners) element.addEventListener(name, handler);
  return { cancel, destroy() { cancel(); for (const [name, handler] of listeners) element.removeEventListener(name, handler); } };
}
