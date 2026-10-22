/**
 * Add a pointer hold without replacing a button's ordinary click behavior.
 * onStart and onRepeat are synchronous, local-state callbacks. onStart returns
 * the context passed to every repeat and to the final commit/cancel callback.
 * A hold repeats once at `delay`, then every `interval`; release commits once.
 * Callers own any asynchronous work started by onCommit and its error handling.
 */
export function bindPressRepeat(button, {
  onStart = () => undefined,
  onRepeat = () => {},
  onCommit = () => {},
  onCancel = () => {},
  delay = 350,
  interval = 180,
} = {}) {
  if (!Number.isFinite(delay) || delay < 0 || !Number.isFinite(interval) || interval <= 0) {
    throw new TypeError('Press-repeat timing must be finite, with delay >= 0 and interval > 0.');
  }
  const document = button.ownerDocument ?? globalThis.document;
  const window = document?.defaultView ?? globalThis.window;
  const pointerRoot = document?.addEventListener ? document : button;
  const schedule = window?.setTimeout?.bind(window) ?? globalThis.setTimeout;
  const unschedule = window?.clearTimeout?.bind(window) ?? globalThis.clearTimeout;
  const listeners = [];
  let gesture = null, suppressPointerClick = false, destroyed = false;

  const unavailable = () => button.disabled || button.getAttribute?.('aria-disabled') === 'true'
    || button.matches?.(':disabled') || document?.hidden;
  function listen(target, name, listener, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(name, listener, options);
    listeners.push(() => target.removeEventListener(name, listener, options));
  }
  function releaseCapture(current) {
    try {
      if (button.hasPointerCapture?.(current.pointerId)) button.releasePointerCapture(current.pointerId);
    } catch { /* The browser may already have released a cancelled pointer. */ }
  }
  function finish(commit, reason) {
    const current = gesture;
    if (!current) return false;
    // Clear ownership before capture loss or a callback can re-enter.
    gesture = null;
    if (current.timer !== null) unschedule(current.timer);
    // A cancelled press must not become a late click against a new page/source.
    if (current.held || !commit) suppressPointerClick = true;
    releaseCapture(current);
    if (current.started) {
      if (commit) onCommit(current.context);
      else onCancel(current.context, reason);
    }
    return true;
  }
  function cancel(reason = 'cancelled') { return finish(false, reason); }
  function repeat(current) {
    if (gesture !== current || destroyed) return;
    current.timer = null;
    if (unavailable()) { cancel('unavailable'); return; }
    try {
      if (!current.started) {
        current.held = true;
        current.context = onStart();
        if (gesture !== current || destroyed) return;
        current.started = true;
        // Short clicks keep native hit testing. Capture begins only for a hold;
        // document-level release handling also works when capture is unavailable.
        try { button.setPointerCapture?.(current.pointerId); } catch { /* Fall back to document events. */ }
      }
      if (unavailable()) { cancel('unavailable'); return; }
      onRepeat(current.context);
    } catch (error) {
      if (gesture === current) cancel('callback-error');
      throw error;
    }
    if (gesture === current && !destroyed) {
      if (unavailable()) cancel('unavailable');
      else current.timer = schedule(() => repeat(current), interval);
    }
  }
  function pointerDown(event) {
    if (destroyed || gesture || unavailable() || event.button !== 0 || event.isPrimary === false) return;
    // If a browser emitted no click for the previous hold, a fresh press still
    // gets its ordinary click. Keyboard and programmatic clicks never consume it.
    suppressPointerClick = false;
    const current = { pointerId: event.pointerId, timer: null, held: false, started: false, context: undefined };
    gesture = current;
    current.timer = schedule(() => repeat(current), delay);
  }
  function pointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (unavailable()) cancel('unavailable');
    else finish(true);
  }
  function pointerCancel(event) {
    if (gesture && event.pointerId === gesture.pointerId) cancel('pointercancel');
  }
  function lostCapture(event) {
    // Capture transferred from a child (for example an SVG) is not ours to lose.
    if (event.target !== button) return;
    if (gesture && event.pointerId === gesture.pointerId) cancel('lostpointercapture');
  }
  function pointerLeave(event) {
    if (gesture && event.pointerId === gesture.pointerId && !gesture.held) cancel('pointerleave');
  }
  function click(event) {
    if (event.detail === 0 || (!suppressPointerClick && !gesture?.held)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressPointerClick = false;
  }
  listen(button, 'pointerdown', pointerDown);
  listen(pointerRoot, 'pointerup', pointerUp, true);
  listen(pointerRoot, 'pointercancel', pointerCancel, true);
  listen(button, 'lostpointercapture', lostCapture);
  listen(button, 'pointerleave', pointerLeave);
  // Capture phase runs before an already-installed ordinary click listener.
  listen(button, 'click', click, true);
  listen(button, 'contextmenu', event => { if (gesture?.held) event.preventDefault(); });
  listen(window, 'blur', () => cancel('blur'));
  listen(document, 'visibilitychange', () => { if (document.hidden) cancel('hidden'); });

  return {
    cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { cancel('destroyed'); }
      finally { for (const remove of listeners) remove(); listeners.length = 0; suppressPointerClick = false; }
    },
  };
}

/**
 * Bind hold-to-repeat keyboard shortcuts on a document. resolve(event) returns
 * the action for a keydown, or null for keys this binding does not own.
 * The first keydown starts and applies one step immediately, native key repeat
 * is ignored, then the action repeats after `delay` every `interval`. Keyup
 * commits once; a different key's keyup cannot settle the active gesture.
 */
export function bindKeyRepeat(document, {
  resolve,
  canStart = () => true,
  onStart = () => undefined,
  onRepeat = () => {},
  onCommit = () => {},
  onCancel = () => {},
  delay = 350,
  interval = 180,
} = {}) {
  if (typeof resolve !== 'function') throw new TypeError('bindKeyRepeat requires a resolve(event) function.');
  if (!Number.isFinite(delay) || delay < 0 || !Number.isFinite(interval) || interval <= 0) {
    throw new TypeError('Key-repeat timing must be finite, with delay >= 0 and interval > 0.');
  }
  if (!document?.addEventListener) throw new TypeError('bindKeyRepeat requires a document event target.');
  const window = document.defaultView ?? globalThis.window;
  const schedule = window?.setTimeout?.bind(window) ?? globalThis.setTimeout;
  const unschedule = window?.clearTimeout?.bind(window) ?? globalThis.clearTimeout;
  const listeners = [];
  let active = null, destroyed = false;

  const unavailable = () => document.hidden === true;
  function listen(target, name, listener, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(name, listener, options);
    listeners.push(() => target.removeEventListener(name, listener, options));
  }
  function stop(current) {
    if (current.timer !== null) unschedule(current.timer);
    current.timer = null;
  }
  function finish(commit, reason) {
    const current = active;
    if (!current) return false;
    active = null;
    stop(current);
    if (commit) onCommit(current.context, current.action);
    else onCancel(current.context, current.action, reason);
    return true;
  }
  function cancel(reason = 'cancelled') { return finish(false, reason); }
  function repeat(current) {
    if (active !== current || destroyed) return;
    current.timer = null;
    if (unavailable()) { cancel('unavailable'); return; }
    try { onRepeat(current.context, current.action); }
    catch (error) {
      if (active === current) cancel('callback-error');
      throw error;
    }
    if (active === current && !destroyed) current.timer = schedule(() => repeat(current), interval);
  }
  function matchesKey(event, current) {
    if (current.code !== null && event.code != null) return event.code === current.code;
    return current.key !== null && event.key === current.key;
  }
  function keydown(event) {
    if (destroyed) return;
    const action = resolve(event);
    if (action === null || action === undefined || action === false) return;
    // Native repeat would bypass the local hold and issue extra seeks. Only
    // swallow it when this binding owns the gesture, so holding a comma inside
    // a text field still types normally.
    if (event.repeat) {
      if (active || canStart(event)) event.preventDefault?.();
      return;
    }
    if (active || unavailable() || !canStart(event)) return;
    event.preventDefault?.();
    const current = { action, code: event.code ?? null, key: event.key ?? null, context: undefined, timer: null };
    active = current;
    try {
      current.context = onStart(action, event);
      onRepeat(current.context, action);
    } catch (error) {
      if (active === current) cancel('callback-error');
      throw error;
    }
    if (active === current && !destroyed) current.timer = schedule(() => repeat(current), delay);
  }
  function keyup(event) {
    if (!active || !matchesKey(event, active)) return;
    finish(true);
  }
  listen(document, 'keydown', keydown);
  listen(document, 'keyup', keyup);
  listen(window, 'blur', () => cancel('blur'));
  listen(document, 'visibilitychange', () => { if (document.hidden === true) cancel('hidden'); });

  return {
    cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { cancel('destroyed'); }
      finally { for (const remove of listeners) remove(); listeners.length = 0; }
    },
  };
}
