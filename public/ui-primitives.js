// Precision transport glyphs: Radix Icons (MIT, WorkOS); see docs/radix-icons-LICENSE.txt.
// Shared UI building blocks. Labels/data always use textContent; SVG paths are
// a closed, static vocabulary shared by the server shell and browser controls.
const ICONS = Object.freeze({
  "nav-replay": "<g transform=\"scale(1.6)\" stroke=\"none\"><path d=\"M3.24182 2.32181C3.3919 2.23132 3.5784 2.22601 3.73338 2.30781L12.7334 7.05781C12.8974 7.14436 13 7.31457 13 7.5C13 7.68543 12.8974 7.85564 12.7334 7.94219L3.73338 12.6922C3.5784 12.774 3.3919 12.7687 3.24182 12.6782C3.09175 12.5877 3 12.4252 3 12.25V2.75C3 2.57476 3.09175 2.4123 3.24182 2.32181ZM4 3.57925V11.4207L11.4288 7.5L4 3.57925Z\" fill=\"currentColor\" fill-rule=\"evenodd\" clip-rule=\"evenodd\"></path></g>",
  // 导航与页面使用同一组图标，避免两端出现不同的语义。
  "nav-tasks": "<g transform=\"scale(1.6)\" stroke=\"none\"><path d=\"M0 1.5C0 1.22386 0.223858 1 0.5 1H2.5C2.77614 1 3 1.22386 3 1.5C3 1.77614 2.77614 2 2.5 2H0.5C0.223858 2 0 1.77614 0 1.5ZM4 1.5C4 1.22386 4.22386 1 4.5 1H14.5C14.7761 1 15 1.22386 15 1.5C15 1.77614 14.7761 2 14.5 2H4.5C4.22386 2 4 1.77614 4 1.5ZM4 4.5C4 4.22386 4.22386 4 4.5 4H11.5C11.7761 4 12 4.22386 12 4.5C12 4.77614 11.7761 5 11.5 5H4.5C4.22386 5 4 4.77614 4 4.5ZM0 7.5C0 7.22386 0.223858 7 0.5 7H2.5C2.77614 7 3 7.22386 3 7.5C3 7.77614 2.77614 8 2.5 8H0.5C0.223858 8 0 7.77614 0 7.5ZM4 7.5C4 7.22386 4.22386 7 4.5 7H14.5C14.7761 7 15 7.22386 15 7.5C15 7.77614 14.7761 8 14.5 8H4.5C4.22386 8 4 7.77614 4 7.5ZM4 10.5C4 10.2239 4.22386 10 4.5 10H11.5C11.7761 10 12 10.2239 12 10.5C12 10.7761 11.7761 11 11.5 11H4.5C4.22386 11 4 10.7761 4 10.5ZM0 13.5C0 13.2239 0.223858 13 0.5 13H2.5C2.77614 13 3 13.2239 3 13.5C3 13.7761 2.77614 14 2.5 14H0.5C0.223858 14 0 13.7761 0 13.5ZM4 13.5C4 13.2239 4.22386 13 4.5 13H14.5C14.7761 13 15 13.2239 15 13.5C15 13.7761 14.7761 14 14.5 14H4.5C4.22386 14 4 13.7761 4 13.5Z\" fill=\"currentColor\" fill-rule=\"evenodd\" clip-rule=\"evenodd\"></path></g>",
  "nav-library": "<g transform=\"scale(1.6)\" stroke=\"none\"><path d=\"M4.76447 3.12199C5.63151 3.04859 6.56082 3 7.5 3C8.43918 3 9.36849 3.04859 10.2355 3.12199C11.2796 3.21037 11.9553 3.27008 12.472 3.39203C12.9425 3.50304 13.2048 3.64976 13.4306 3.88086C13.4553 3.90618 13.4902 3.94414 13.5133 3.97092C13.7126 4.20149 13.8435 4.4887 13.918 5.03283C13.9978 5.6156 14 6.37644 14 7.52493C14 8.66026 13.9978 9.41019 13.9181 9.98538C13.8439 10.5206 13.7137 10.8061 13.5125 11.0387C13.4896 11.0651 13.4541 11.1038 13.4296 11.1287C13.2009 11.3625 12.9406 11.5076 12.4818 11.6164C11.9752 11.7365 11.3143 11.7942 10.2878 11.8797C9.41948 11.9521 8.47566 12 7.5 12C6.52434 12 5.58052 11.9521 4.7122 11.8797C3.68572 11.7942 3.02477 11.7365 2.51816 11.6164C2.05936 11.5076 1.7991 11.3625 1.57037 11.1287C1.54593 11.1038 1.51035 11.0651 1.48748 11.0387C1.28628 10.8061 1.15612 10.5206 1.08193 9.98538C1.00221 9.41019 1 8.66026 1 7.52493C1 6.37644 1.00216 5.6156 1.082 5.03283C1.15654 4.4887 1.28744 4.20149 1.48666 3.97092C1.5098 3.94414 1.54468 3.90618 1.56942 3.88086C1.7952 3.64976 2.05752 3.50304 2.52796 3.39203C3.04473 3.27008 3.7204 3.21037 4.76447 3.12199ZM0 7.52493C0 5.28296 0 4.16198 0.729985 3.31713C0.766457 3.27491 0.815139 3.22194 0.854123 3.18204C1.63439 2.38339 2.64963 2.29744 4.68012 2.12555C5.56923 2.05028 6.52724 2 7.5 2C8.47276 2 9.43077 2.05028 10.3199 2.12555C12.3504 2.29744 13.3656 2.38339 14.1459 3.18204C14.1849 3.22194 14.2335 3.27491 14.27 3.31713C15 4.16198 15 5.28296 15 7.52493C15 9.74012 15 10.8477 14.2688 11.6929C14.2326 11.7348 14.1832 11.7885 14.1444 11.8281C13.3629 12.6269 12.3655 12.71 10.3709 12.8763C9.47971 12.9505 8.50782 13 7.5 13C6.49218 13 5.52028 12.9505 4.62915 12.8763C2.63446 12.71 1.63712 12.6269 0.855558 11.8281C0.816844 11.7885 0.767442 11.7348 0.731221 11.6929C0 10.8477 0 9.74012 0 7.52493ZM5.25 5.38264C5.25 5.20225 5.43522 5.08124 5.60041 5.15369L10.428 7.27105C10.6274 7.35853 10.6274 7.64147 10.428 7.72895L5.60041 9.84631C5.43522 9.91876 5.25 9.79775 5.25 9.61736V5.38264Z\" fill=\"currentColor\" fill-rule=\"evenodd\" clip-rule=\"evenodd\"></path></g>",
  "nav-settings": "<g transform=\"scale(1.6)\" stroke=\"none\"><path d=\"M7.07095 0.650238C6.67391 0.650238 6.32977 0.925096 6.24198 1.31231L6.0039 2.36247C5.6249 2.47269 5.26335 2.62363 4.92436 2.81013L4.01335 2.23585C3.67748 2.02413 3.23978 2.07312 2.95903 2.35386L2.35294 2.95996C2.0722 3.2407 2.0232 3.6784 2.23493 4.01427L2.80942 4.92561C2.62307 5.2645 2.47227 5.62594 2.36216 6.00481L1.31209 6.24287C0.924883 6.33065 0.650024 6.6748 0.650024 7.07183V7.92897C0.650024 8.32601 0.924883 8.67015 1.31209 8.75794L2.36228 8.99603C2.47246 9.375 2.62335 9.73652 2.80979 10.0755L2.2354 10.9867C2.02367 11.3225 2.07267 11.7602 2.35341 12.041L2.95951 12.6471C3.24025 12.9278 3.67795 12.9768 4.01382 12.7651L4.92506 12.1907C5.26384 12.377 5.62516 12.5278 6.0039 12.6379L6.24198 13.6881C6.32977 14.0753 6.67391 14.3502 7.07095 14.3502H7.92809C8.32512 14.3502 8.66927 14.0753 8.75705 13.6881L8.99505 12.6383C9.37411 12.5282 9.73573 12.3773 10.0748 12.1909L10.986 12.7653C11.3218 12.977 11.7595 12.928 12.0403 12.6473L12.6464 12.0412C12.9271 11.7604 12.9761 11.3227 12.7644 10.9869L12.1902 10.076C12.3768 9.73688 12.5278 9.37515 12.638 8.99596L13.6879 8.75794C14.0751 8.67015 14.35 8.32601 14.35 7.92897V7.07183C14.35 6.6748 14.0751 6.33065 13.6879 6.24287L12.6381 6.00488C12.528 5.62578 12.3771 5.26414 12.1906 4.92507L12.7648 4.01407C12.9766 3.6782 12.9276 3.2405 12.6468 2.95975L12.0407 2.35366C11.76 2.07292 11.3223 2.02392 10.9864 2.23565L10.0755 2.80989C9.73622 2.62328 9.37437 2.47229 8.99505 2.36209L8.75705 1.31231C8.66927 0.925096 8.32512 0.650238 7.92809 0.650238H7.07095ZM4.92053 3.81251C5.44724 3.44339 6.05665 3.18424 6.71543 3.06839L7.07095 1.50024H7.92809L8.28355 3.06816C8.94267 3.18387 9.5524 3.44302 10.0794 3.81224L11.4397 2.9547L12.0458 3.56079L11.1882 4.92117C11.5573 5.44798 11.8164 6.0575 11.9321 6.71638L13.5 7.07183V7.92897L11.932 8.28444C11.8162 8.94342 11.557 9.55301 11.1878 10.0798L12.0453 11.4402L11.4392 12.0462L10.0787 11.1886C9.55192 11.5576 8.94241 11.8166 8.28355 11.9323L7.92809 13.5002H7.07095L6.71543 11.932C6.0569 11.8162 5.44772 11.5572 4.92116 11.1883L3.56055 12.046L2.95445 11.4399L3.81213 10.0794C3.4431 9.55266 3.18403 8.94326 3.06825 8.2845L1.50002 7.92897V7.07183L3.06818 6.71632C3.18388 6.05765 3.44283 5.44833 3.81171 4.92165L2.95398 3.561L3.56008 2.95491L4.92053 3.81251ZM9.02496 7.50008C9.02496 8.34226 8.34223 9.02499 7.50005 9.02499C6.65786 9.02499 5.97513 8.34226 5.97513 7.50008C5.97513 6.65789 6.65786 5.97516 7.50005 5.97516C8.34223 5.97516 9.02496 6.65789 9.02496 7.50008ZM9.92496 7.50008C9.92496 8.83932 8.83929 9.92499 7.50005 9.92499C6.1608 9.92499 5.07513 8.83932 5.07513 7.50008C5.07513 6.16084 6.1608 5.07516 7.50005 5.07516C8.83929 5.07516 9.92496 6.16084 9.92496 7.50008Z\" fill=\"currentColor\" fill-rule=\"evenodd\" clip-rule=\"evenodd\"></path></g>",
  'live-edge': '<g transform="scale(1.6)" stroke="none"><path d="M13.0502 2.74989C13.0502 2.44613 12.804 2.19989 12.5002 2.19989C12.1965 2.19989 11.9502 2.44613 11.9502 2.74989V7.2825C11.9046 7.18802 11.8295 7.10851 11.7334 7.05776L2.73338 2.30776C2.5784 2.22596 2.3919 2.23127 2.24182 2.32176C2.09175 2.41225 2 2.57471 2 2.74995V12.25C2 12.4252 2.09175 12.5877 2.24182 12.6781C2.3919 12.7686 2.5784 12.7739 2.73338 12.6921L11.7334 7.94214C11.8295 7.89139 11.9046 7.81188 11.9502 7.7174V12.2499C11.9502 12.5536 12.1965 12.7999 12.5002 12.7999C12.804 12.7999 13.0502 12.5536 13.0502 12.2499V2.74989ZM3 11.4207V3.5792L10.4288 7.49995L3 11.4207Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"></path></g>',
  cloud189: '<text x="12" y="18" text-anchor="middle" textLength="22" lengthAdjust="spacingAndGlyphs" font-family="var(--mono)" font-size="16" font-weight="700" fill="currentColor" stroke="none">189</text>',
  cloud: '<path d="M7 18h11a4 4 0 0 0 0-8 6 6 0 0 0-11-2 5 5 0 0 0 0 10z"/>',
  tv: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="m8 2 4 4 4-4M9 11v5l5-2.5z"/>',
  camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  fullscreen: '<path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  warning: '<path d="m12 3 10 18H2L12 3zM12 9v5M12 17v1"/>',
  'mark-in': '<path d="M8 4H4v16h4M11 7l7 5-7 5"/>',
  'mark-out': '<path d="M16 4h4v16h-4M13 7l-7 5 7 5"/>',
  dvr: '<rect x="3" y="8" width="18" height="9" rx="2.5"/><path d="M7 12.5h.1M11 12.5h6M8 20h8"/>',
  mediamtx: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21m-3 0v3m-3-3v2"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  clear: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  'volume-on': '<path d="m11 5-6 4H2v6h3l6 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  'volume-off': '<path d="m11 5-6 4H2v6h3l6 4V5zM17 9l5 6M22 9l-5 6"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  pause: '<path d="M7 5v14M17 5v14"/>',
  'skip-back': '<g transform="scale(1.6)" stroke="none"><path d="M6.85355 3.85355C7.04882 3.65829 7.04882 3.34171 6.85355 3.14645C6.65829 2.95118 6.34171 2.95118 6.14645 3.14645L2.14645 7.14645C1.95118 7.34171 1.95118 7.65829 2.14645 7.85355L6.14645 11.8536C6.34171 12.0488 6.65829 12.0488 6.85355 11.8536C7.04882 11.6583 7.04882 11.3417 6.85355 11.1464L3.20711 7.5L6.85355 3.85355ZM12.8536 3.85355C13.0488 3.65829 13.0488 3.34171 12.8536 3.14645C12.6583 2.95118 12.3417 2.95118 12.1464 3.14645L8.14645 7.14645C7.95118 7.34171 7.95118 7.65829 8.14645 7.85355L12.1464 11.8536C12.3417 12.0488 12.6583 12.0488 12.8536 11.8536C13.0488 11.6583 13.0488 11.3417 12.8536 11.1464L9.20711 7.5L12.8536 3.85355Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"></path></g>',
  'skip-forward': '<g transform="scale(1.6)" stroke="none"><path d="M2.14645 11.1464C1.95118 11.3417 1.95118 11.6583 2.14645 11.8536C2.34171 12.0488 2.65829 12.0488 2.85355 11.8536L6.85355 7.85355C7.04882 7.65829 7.04882 7.34171 6.85355 7.14645L2.85355 3.14645C2.65829 2.95118 2.34171 2.95118 2.14645 3.14645C1.95118 3.34171 1.95118 3.65829 2.14645 3.85355L5.79289 7.5L2.14645 11.1464ZM8.14645 11.1464C7.95118 11.3417 7.95118 11.6583 8.14645 11.8536C8.34171 12.0488 8.65829 12.0488 8.85355 11.8536L12.8536 7.85355C13.0488 7.65829 13.0488 7.34171 12.8536 7.14645L8.85355 3.14645C8.65829 2.95118 8.34171 2.95118 8.14645 3.14645C7.95118 3.34171 7.95118 3.65829 8.14645 3.85355L11.7929 7.5L8.14645 11.1464Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"></path></g>',
  download: '<path d="M12 4v12m-5-5 5 5 5-5M5 16v4h14v-4"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M5 16v4h14v-4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
  'sort-newest': '<path d="M17 4v16m-3-3 3 3 3-3M4 6h6M4 12h4M4 18h2"/>',
  'sort-oldest': '<path d="M17 20V4m-3 3 3-3 3 3M4 6h6M4 12h4M4 18h2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  logout: '<path d="M10 4H5v16h5m4-12 4 4-4 4M9 12h11"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
});
export function iconSvg(name, className = '') {
  if (className && !/^[a-zA-Z0-9 _-]{1,80}$/.test(className)) throw new Error('Invalid icon class');
  if (!Object.hasOwn(ICONS, name)) throw new Error(`Unknown UI icon: ${name}`);
  return `<svg${className ? ` class="${className}"` : ''} viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}
export function setButtonIcon(button, icon, label) {
  button.innerHTML = iconSvg(icon);
  button.setAttribute('aria-label', label); button.title = label;
  return button;
}
export function createSettingsRow({ document = globalThis.document, title, detail = '', status = '', disabled = false, onClick }) {
  const row = document.createElement('button'); row.type = 'button';
  row.className = `settings-row config-summary${detail ? '' : ' config-summary-compact'}`;
  row.disabled = disabled; row.addEventListener('click', onClick);
  const name = document.createElement('strong'); name.textContent = title;
  const description = document.createElement('span'); description.textContent = detail; description.hidden = !detail;
  const state = document.createElement('small'); state.textContent = status; state.hidden = !status;
  state.setAttribute('role', 'status');
  const cue = document.createElement('span'); cue.className = 'settings-row-chevron';
  cue.setAttribute('aria-hidden', 'true'); cue.innerHTML = iconSvg('chevron');
  row.append(name, description, state, cue);
  return row;
}

export function formatClipDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds) / 1000) || 0);
  return [[Math.floor(seconds / 3600), '小时'], [Math.floor(seconds / 60) % 60, '分'], [seconds % 60, '秒']]
    .filter(([value]) => value).map(([value, unit]) => `${value}${unit}`).join('') || '0秒';
}

// These controllers only manage local presentation; callers own media and navigation.
export function createPlaybackChrome({ container, video, interactionRoot = container, isBusy = () => false, document = globalThis.document, delay = 2200, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, buffering = false;
  const listeners = [];
  const listen = (node, type, callback) => { node.addEventListener(type, callback); listeners.push(() => node.removeEventListener(type, callback)); };
  const cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const mayHide = () => !isBusy() && !buffering && !video.hidden && !video.paused && !video.ended && !video.error && video.readyState >= 2
    && !(interactionRoot.contains(document.activeElement) && document.activeElement?.matches?.(':focus-visible'));
  const schedule = () => { cancel(); timer = setTimer(() => { timer = null; if (mayHide()) container.classList.add('controls-idle'); }, delay); };
  const show = () => { container.classList.remove('controls-idle'); schedule(); };
  for (const name of ['pointerdown', 'pointermove', 'pointerenter', 'pointerup', 'pointercancel', 'focusin', 'focusout']) listen(interactionRoot, name, show);
  for (const name of ['play', 'pause', 'ended', 'error', 'loadeddata', 'stalled']) listen(video, name, show);
  listen(video, 'waiting', () => { buffering = true; show(); });
  for (const name of ['playing', 'emptied']) listen(video, name, () => { buffering = false; show(); });
  listen(document, 'visibilitychange', () => { if (document.hidden) cancel(); else show(); });
  show();
  return { show, destroy() { cancel(); for (const detach of listeners) detach(); container.classList.remove('controls-idle'); } };
}

export function createSlidingNavigation({ nav, activate, window = globalThis.window, now = Date.now }) {
  const buttons = [...nav.querySelectorAll('button[data-view]')];
  let gesture = null, suppressUntil = 0;
  const listeners = [];
  const listen = (node, type, callback, options) => { node.addEventListener(type, callback, options); listeners.push(() => node.removeEventListener(type, callback, options)); };
  const paint = (button, pointerX = null) => {
    if (!button) return;
    const box = nav.getBoundingClientRect(), target = button.getBoundingClientRect();
    if (!box.width || !target.width) return;
    const first = buttons[0].getBoundingClientRect(), last = buttons.at(-1).getBoundingClientRect();
    const left = pointerX === null ? target.left : Math.max(first.left, Math.min(last.left, pointerX - target.width / 2));
    nav.style.setProperty('--nav-selection-left', `${left - box.left}px`);
    nav.style.setProperty('--nav-selection-width', `${target.width}px`);
    nav.classList.add('sliding-nav');
  };
  const clearPreview = () => { for (const button of buttons) button.classList.remove('drag-target'); nav.classList.remove('nav-dragging'); };
  const sync = () => { if (!gesture) { clearPreview(); paint(buttons.find(button => button.getAttribute('aria-current') === 'page') || buttons[0]); } };
  const hit = event => {
    const rect = nav.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
    return buttons.reduce((best, button) => {
      const r = button.getBoundingClientRect(), b = best?.getBoundingClientRect();
      return !b || Math.abs(event.clientX - r.left - r.width / 2) < Math.abs(event.clientX - b.left - b.width / 2) ? button : best;
    }, null);
  };
  const preview = event => {
    gesture.target = hit(event); clearPreview(); nav.classList.add('nav-dragging');
    if (gesture.target) { gesture.target.classList.add('drag-target'); paint(gesture.target, event.clientX); }
  };
  listen(nav, 'pointerdown', event => {
    if (gesture || event.isPrimary === false || event.button !== 0 || !event.target.closest?.('button[data-view]')) return;
    event.preventDefault(); gesture = { id: event.pointerId, target: null }; nav.setPointerCapture(event.pointerId); preview(event);
  });
  listen(nav, 'pointermove', event => { if (gesture?.id === event.pointerId) { event.preventDefault(); preview(event); } });
  const finish = (event, cancelled) => {
    if (gesture?.id !== event.pointerId) return;
    const target = cancelled ? null : hit(event), id = gesture.id; gesture = null;
    suppressUntil = now() + 600;
    if (nav.hasPointerCapture?.(id)) nav.releasePointerCapture(id);
    clearPreview(); if (target) activate(target.dataset.view); sync();
  };
  listen(nav, 'pointerup', event => finish(event, false));
  listen(nav, 'pointercancel', event => finish(event, true));
  listen(nav, 'lostpointercapture', event => finish(event, true));
  listen(nav, 'click', event => { if (now() < suppressUntil && (event.detail > 0 || event.pointerType)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  listen(window, 'resize', sync);
  sync();
  return { sync, destroy() { gesture = null; for (const detach of listeners) detach(); clearPreview(); nav.classList.remove('sliding-nav'); } };
}
