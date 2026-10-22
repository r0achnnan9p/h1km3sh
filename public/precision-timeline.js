const DAY_MS = 86_400_000;

// One captured ruler: the full day selects an absolute time, local windows move
// beneath a fixed centre. The caller owns media, marks and recording I/O.
export function createPrecisionTimeline({ element, getTime, getBounds, getSpan = () => DAY_MS, getContext, onStart, onMove, onCommit, onCancel, onError = () => {} }) {
  let gesture = null, pendingCommit = null, sequence = 0, destroyed = false;
  const snap = value => {
    const { start, end } = getBounds();
    return Math.max(Math.ceil(start / 1000) * 1000, Math.min(Math.floor(end / 1000) * 1000, Math.round(value / 1000) * 1000));
  };
  const currentContext = current => getContext() === current.context && getSpan() === current.span;
  function release(current) { if (element.hasPointerCapture?.(current.id)) element.releasePointerCapture(current.id); }
  function cancel({ restore = true } = {}) {
    sequence++;
    const previous = gesture || pendingCommit; gesture = null; pendingCommit = null;
    if (!previous) return;
    release(previous);
    if (previous.started) onCancel({ restore: restore && currentContext(previous), time: previous.original });
  }
  function preview(current, raw) {
    if (!current.started) { current.started = true; onStart(); }
    current.time = snap(raw);
    onMove({ time: current.time, span: current.span });
  }
  function down(event) {
    if (destroyed || gesture || event.isPrimary === false || event.button != null && event.button !== 0) return;
    const rect = element.getBoundingClientRect(), span = getSpan(), time = getTime();
    if (!(rect.width > 0) || !Number.isFinite(span) || span <= 0 || !Number.isFinite(time) || !Number.isFinite(event.clientX)) return;
    const { start, end } = getBounds();
    const relative = span !== DAY_MS;
    const touched = relative ? time - span / 2 + (event.clientX - rect.left) / rect.width * span : start + (event.clientX - rect.left) / rect.width * DAY_MS;
    // Empty padding keeps the needle centred at midnight/now, but is not a
    // second date or future recording that a user can select.
    if (relative && (touched < start || touched > end)) return;
    if (pendingCommit) cancel({ restore: false });
    sequence++;
    gesture = { id: event.pointerId, context: getContext(), original: time, time: snap(time), span, relative,
      x: event.clientX, y: event.clientY, left: rect.left, width: rect.width,
      scale: rect.width / (element.clientWidth || rect.width), pressedTime: snap(touched), moved: false, started: false };
    try { element.setPointerCapture?.(event.pointerId); } catch { gesture = null; return; }
    event.preventDefault();
  }
  function move(event) {
    const current = gesture; if (!current || current.id !== event.pointerId || !Number.isFinite(event.clientX)) return;
    if (!currentContext(current)) { cancel({ restore: false }); return; }
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.moved) {
      // Vertical movement no longer changes scale or selects another time.
      if (Math.abs(dy) >= 8 * current.scale && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
      if (Math.abs(dx) < 6 * current.scale) return;
      current.moved = true;
    }
    // Always use total displacement from this grab. Rounding each event's small
    // delta would discard slow movement, and a new grab must not jump to its x.
    const raw = current.relative ? current.original - dx * current.span / current.width
      : getBounds().start + (event.clientX - current.left) / current.width * DAY_MS;
    preview(current, raw); event.preventDefault();
  }
  function up(event) {
    const current = gesture; if (!current || current.id !== event.pointerId) return;
    if (!currentContext(current)) { cancel({ restore: false }); return; }
    if (!current.moved) {
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      if (Math.abs(dy) >= 8 * current.scale && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
    }
    // A local tap is only a grip, never an absolute jump. A day tap uses the
    // initial press; every drag commits exactly its last visible whole second.
    if (!current.moved && current.relative) { gesture = null; release(current); event.preventDefault(); return; }
    if (!current.moved) preview(current, current.pressedTime);
    const time = current.time;
    gesture = null; pendingCommit = current; release(current); event.preventDefault();
    const version = sequence;
    Promise.resolve().then(() => {
      if (destroyed || version !== sequence) return;
      pendingCommit = null;
      if (!currentContext(current)) { onCancel({ restore: false, time: current.original }); return; }
      return onCommit(time);
    }).catch(onError);
  }
  const abort = event => { if (gesture?.id === event.pointerId) cancel(); };
  const listeners = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', abort], ['lostpointercapture', abort]];
  for (const [name, handler] of listeners) element.addEventListener(name, handler);
  return { cancel, destroy() { if (destroyed) return; cancel(); destroyed = true; for (const [name, handler] of listeners) element.removeEventListener(name, handler); } };
}
