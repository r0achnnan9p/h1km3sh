/**
 * Local presentation state for the replay panel. The caller owns media, marks,
 * DOM focus and event routing; neither mode changes nor idle hiding seek video.
 * Enable only while the replay panel should auto-hide (landscape/fullscreen).
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
  let enabled = false, visible = true, mode = 'select', destroyed = false;
  let timer = null, timerGeneration = 0, suppressedPointer = null;
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
    const changed = setVisible(true);
    schedule();
    return changed;
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
  function pointerDown({ pointerId = 0, button = 0, isPrimary = true } = {}) {
    if (destroyed || button !== 0 || !isPrimary) return false;
    if (pointers.has(pointerId)) return suppressedPointer === pointerId;
    // Some browsers omit the click after preventDefault/cancellation. A fresh
    // pointer gesture must never inherit that previous tap's suppression.
    if (!pointers.size) suppressedPointer = null;
    if (!enabled) return false;
    const wakeOnly = !visible;
    pointers.add(pointerId);
    if (wakeOnly) suppressedPointer = pointerId;
    show();
    return wakeOnly;
  }
  function pointerUp({ pointerId = 0, type } = {}) {
    if (destroyed) return false;
    if (type === 'pointercancel' && pointers.has(pointerId)) suppressedPointer = pointerId;
    const consumed = suppressedPointer === pointerId;
    if (pointers.delete(pointerId)) show();
    return consumed;
  }
  function consumeClick({ detail = 1, pointerId } = {}) {
    if (destroyed || detail === 0 || suppressedPointer === null) return false;
    // Safari can deliver a MouseEvent without pointerId; modern pointer clicks
    // carry it, so an unrelated pointer cannot consume the pending wake click.
    if (pointerId !== undefined && pointerId > 0 && suppressedPointer > 0 && pointerId !== suppressedPointer) return false;
    suppressedPointer = null;
    return true;
  }
  function reset() {
    if (destroyed) return;
    // A cancelled press may still produce a click after navigation/source
    // change. Suppress that trailing click, but never recreate the gesture.
    if (pointers.size) suppressedPointer = pointers.values().next().value;
    pointers.clear();
    holds.clear();
    show();
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelTimer();
    pointers.clear();
    holds.clear();
    suppressedPointer = null;
    setVisible(true);
  }

  return {
    get visible() { return visible; },
    get mode() { return mode; },
    setEnabled, show, setMode, hold, release,
    pointerDown, pointerUp, consumeClick, reset, destroy,
  };
}
