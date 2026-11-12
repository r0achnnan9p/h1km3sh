/** Shared base for self-contained documents served outside the console asset paths. */
export const standaloneTheme = `
  :root {
    color-scheme: dark;
    --bg: #0b1118; --surface: #151e28; --surface2: #202e3b;
    --text: #edf4f7; --muted: #b0c1cc; --accent: #81e5e0; --on-accent: #072926;
    --line: rgba(255,255,255,.16); --green: #89d9a8; --warning: #ffd27a; --coral: #ff9d8a;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 var(--font); }
  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  h1, h2, h3, p, dl, dd { margin: 0; }
  button, input { font: inherit; }
`;
