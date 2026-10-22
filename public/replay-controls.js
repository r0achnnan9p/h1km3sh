/**
 * Local presentation state for the replay panel. The caller owns media, marks,
 * DOM focus and event routing; neither mode changes nor idle hiding seek video.
 * Enable only auto-hiding in landscape/fullscreen; manual taps work in any layout.
 *
 * Capture pointerdown/up and click before their ordinary actions. When a pointer
 * method returns true, preventDefault + stopImmediatePropagation: the first tap
 * on hidden controls only wakes them. Keyboard clicks (detail 0) remain usable.
 */
export function createReplayControls({
  onVisibilityChange = () => {},
  onModeChange = () => {},
  canHide = () => true,
  delay = 2500,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  if (!Number.isFinite(delay) || delay <= 0) throw new TypeError('Replay idle delay must be finite and positive.');
  let enabled = false, visible = true, manuallyHidden = false, mode = 'select', destroyed = false;
  let timer = null, timerGeneration = 0, suppressedPointer = null, surfaceTap = null;
  const holds = new Set(), pointers = new Set();

  function cancelTimer() {
    timerGeneration++;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function setVisible(next) {
    if (visible === next) return false;
    visible = next;
    onVisibilityChange(visible);
    return true;
  }
  function schedule() {
    cancelTimer();
    if (destroyed || !enabled || !visible || holds.size || pointers.size) return;
    const generation = timerGeneration;
    timer = setTimer(() => {
      if (destroyed || generation !== timerGeneration) return;
      timer = null;
      if (!enabled || holds.size || pointers.size) return;
      // Media pause and select mode are deliberately not guards. The caller
      // checks current drag, modal and keyboard/editable-focus state here.
      if (canHide()) setVisible(false);
      else schedule();
    }, delay);
  }
  function show() {
    if (destroyed) return false;
    manuallyHidden = false;
    const changed = setVisible(true);
    schedule();
    return changed;
  }
  function hide() {
    if (destroyed || !visible || holds.size || pointers.size || !canHide()) return false;
    cancelTimer();
    manuallyHidden = true;
    return setVisible(false);
  }
  function setEnabled(next) {
    if (destroyed || enabled === Boolean(next)) return false;
    enabled = Boolean(next);
    show();
    return true;
  }
  function setMode(next) {
    if (destroyed) return false;
    if (next !== 'watch' && next !== 'select') throw new TypeError('Replay mode must be watch or select.');
    if (mode === next) return false;
    mode = next;
    onModeChange(mode);
    show();
    return true;
  }
  function hold(key = 'interaction') {
    if (destroyed) return false;
    const added = !holds.has(key);
    holds.add(key);
    show();
    return added;
  }
  function release(key = 'interaction') {
    if (destroyed || !holds.delete(key)) return false;
    show();
    return true;
  }
  function samePointer(event, pointerId) {
    // Safari can deliver a MouseEvent without pointerId after the pointer events.
    return !event.pointerId || event.pointerId <= 0 || pointerId <= 0 || event.pointerId === pointerId;
  }
  function pointerDown(event = {}, { surface = false } = {}) {
    const { pointerId = 0, button = 0, isPrimary = true } = event;
    if (destroyed) return false;
    if (button !== 0 || !isPrimary) { surfaceTap = null; return false; }
    if (pointers.has(pointerId)) return suppressedPointer === pointerId;
    // A fresh gesture must never inherit a previous cancelled/omitted click.
    if (!pointers.size) suppressedPointer = null;
    const wakeOnly = !visible;
    pointers.add(pointerId);
    surfaceTap = !wakeOnly && surface && pointers.size === 1 && canHide()
      && [event.clientX, event.clientY, event.timeStamp].every(Number.isFinite)
      ? { pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, released: false } : null;
    if (wakeOnly) suppressedPointer = pointerId;
    show();
    return wakeOnly;
  }
  function pointerMove(event = {}) {
    if (destroyed) return;
    if (surfaceTap?.pointerId === event.pointerId
      && Math.hypot(event.clientX - surfaceTap.x, event.clientY - surfaceTap.y) > 8) surfaceTap = null;
    // Mouse movement may reveal timed-out controls, but cannot pre-empt the
    // next explicit wake tap after a user manually hides them.
    if (event.pointerType === 'mouse' && (visible || enabled && !manuallyHidden)) show();
  }
  function pointerUp(event = {}, { surface = false } = {}) {
    const { pointerId = 0, type } = event;
    if (destroyed) return false;
    if (surfaceTap?.pointerId === pointerId) {
      const elapsed = event.timeStamp - surfaceTap.at;
      const moved = Math.hypot(event.clientX - surfaceTap.x, event.clientY - surfaceTap.y);
      if (type === 'pointercancel' || !surface || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 450 || !Number.isFinite(moved) || moved > 8) surfaceTap = null;
      else surfaceTap.released = true;
    }
    if (type === 'pointercancel' && pointers.has(pointerId)) suppressedPointer = pointerId;
    const consumed = suppressedPointer === pointerId;
    if (pointers.delete(pointerId)) show();
    return consumed;
  }
  function consumeClick(event = {}, { surface = false } = {}) {
    const { detail = 1 } = event;
    if (destroyed || detail === 0) return false;
    if (suppressedPointer !== null && samePointer(event, suppressedPointer)) {
      suppressedPointer = null;
      surfaceTap = null;
      return true;
    }
    const tap = surfaceTap;
    surfaceTap = null;
    // Only a completed short tap that began on the video can hide controls.
    // Dragging, held presses, secondary clicks and double-clicks never toggle.
    if (!surface || detail !== 1 || !tap?.released || !samePointer(event, tap.pointerId)) return false;
    return hide();
  }
  function reset() {
    if (destroyed) return;
    // A cancelled press may still produce a click after navigation/source
    // change. Suppress that trailing click, but never recreate the gesture.
    if (pointers.size) suppressedPointer = pointers.values().next().value;
    pointers.clear();
    holds.clear();
    surfaceTap = null;
    show();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelTimer();
    pointers.clear();
    holds.clear();
    suppressedPointer = null;
    surfaceTap = null;
    setVisible(true);
  }

  return {
    get visible() { return visible; },
    get mode() { return mode; },
    setEnabled, show, hide, setMode, hold, release,
    pointerDown, pointerMove, pointerUp, consumeClick, reset, destroy,
  };
}
