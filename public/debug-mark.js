// A local diagnostic HUD. Toggling it never reloads or changes playback state.
export function setupDebugMark({ $, state, debugMark }) {
  let enabled = false, taps = [], panel, viewportLog, lastViewport, previousViewport;
  try { enabled = localStorage.getItem('debugMark') === '1'; } catch {}
  try {
    const url = new URL(location.href), query = url.searchParams.get('debugMark');
    if (query === '1' || query === '0') enabled = query === '1';
    if (url.searchParams.has('debugMark')) {
      url.searchParams.delete('debugMark');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
  } catch {}
  // Numeric geometry only; no device/account data, network requests or storage.
  function updateViewport() {
    if (!enabled || !viewportLog) return;
    const viewport = window.visualViewport, root = document.documentElement;
    const safe = getComputedStyle(root);
    const rect = selector => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? [box.x, box.y, box.width, box.height].map(value => Math.round(value * 10) / 10) : null;
    };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;left:0;top:0';
    document.body.append(probe);
    const cssHeights = {};
    for (const unit of ['vh', 'dvh', 'svh', 'lvh']) {
      probe.style.height = '100' + unit;
      cssHeights[unit] = parseFloat(getComputedStyle(probe).height);
    }
    probe.remove();
    const snapshot = JSON.stringify({ view: document.body.dataset.view,
      standalone: navigator.standalone === true, displayStandalone: window.matchMedia('(display-mode: standalone)').matches, fullscreen: Boolean(document.fullscreenElement), inner: [window.innerWidth, window.innerHeight],
      client: [root.clientWidth, root.clientHeight], screen: [window.screen.width, window.screen.height],
      visual: viewport ? [viewport.width, viewport.height, viewport.offsetLeft, viewport.offsetTop, viewport.scale] : null,
      safe: ['--safe-top', '--safe-bottom'].map(name => safe.getPropertyValue(name).trim()),
      cssHeights, scrollY: window.scrollY, shell: rect('.console-shell'),
      content: rect('.workspace-main'), contentScroll: document.querySelector('.workspace-main')?.scrollTop ?? 0,
      nav: rect('.mobile-nav'), video: rect('#player-wrap') });
    if (lastViewport && lastViewport !== snapshot) previousViewport = lastViewport;
    viewportLog.textContent = 'viewport ' + snapshot + (previousViewport ? '\nprevious ' + previousViewport : '');
    lastViewport = snapshot;
  }
  function scheduleViewport() { if (enabled) window.requestAnimationFrame(updateViewport); }
  function setEnabled(value) {
    enabled = Boolean(value); taps = [];
    try { if (enabled) localStorage.setItem('debugMark', '1'); else localStorage.removeItem('debugMark'); } catch {}
    if (!enabled) { panel?.remove(); panel = null; viewportLog = null; lastViewport = null; previousViewport = null; return; }
    if (panel) return;
    panel = document.createElement('aside'); panel.id = 'debug-mark-panel';
    panel.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;margin:0;box-sizing:border-box;min-height:calc(44px + env(safe-area-inset-top,0px) + var(--status-bar-blur-gap,0px));padding:calc(4px + env(safe-area-inset-top,0px) + var(--status-bar-blur-gap,0px)) calc(50px + env(safe-area-inset-right,0px)) 4px max(6px,env(safe-area-inset-left,0px));color:#0f0;background:rgba(0,0,0,.82);pointer-events:none';
    const log = document.createElement('pre'); log.id = 'debug-mark-log';
    log.style.cssText = 'margin:0;max-height:34vh;overflow:auto;font:9px/1.25 monospace;white-space:pre-wrap;word-break:break-all';
    log.textContent = 'debugMark on';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label', '关闭诊断面板');
    close.style.cssText = 'position:absolute;right:env(safe-area-inset-right,0px);top:calc(env(safe-area-inset-top,0px) + var(--status-bar-blur-gap,0px));width:44px;height:44px;border:0;background:transparent;color:white;font:28px sans-serif;pointer-events:auto';
    close.addEventListener('click', () => setEnabled(false));
    viewportLog = document.createElement('pre'); viewportLog.id = 'debug-mark-viewport';
    viewportLog.style.cssText = log.style.cssText;
    panel.append(log, close, viewportLog); document.body.append(panel); updateViewport();
  }
  // The selection heading is hidden on phones; the visible clock uses the same toggle.
  for (const id of ['selection-title', 'app-title']) $(id)?.addEventListener('click', () => {
    const now = Date.now(); taps = [...taps.filter(time => now - time < 2500), now];
    if (taps.length >= 5) setEnabled(!enabled);
  });
  // Register once; reopening the panel must not multiply event diagnostics.
  for (const id of ['mark-in', 'mark-out']) for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'click']) {
    $(id)?.addEventListener(type, () => { if (enabled) debugMark(`raw-${type}`, { id, disabled: $(id).disabled, dragging: state.dragging }); }, true);
  }
  for (const type of ['blur', 'focus']) window.addEventListener(type, () => { if (enabled) debugMark(`window-${type}`); });
  for (const type of ['resize', 'scroll', 'orientationchange', 'pageshow', 'hashchange', 'click']) window.addEventListener(type, scheduleViewport);
  for (const type of ['resize', 'scroll']) window.visualViewport?.addEventListener(type, scheduleViewport);
  document.querySelector('.workspace-main')?.addEventListener('scroll', scheduleViewport, { passive: true });
  $('replay-player')?.addEventListener('loadedmetadata', scheduleViewport);
  setEnabled(enabled);
  return { setEnabled, isEnabled: () => enabled };
}
