/** Shared base for self-contained documents served outside the console asset paths. */
export const standaloneTheme = `
  :root {
    color-scheme: dark;
    --bg: #05060f; --surface: #2f343e; --surface2: #3a414c;
    --text: #d1e4fa; --muted: #c7d3ea; --accent: #ffffff; --on-accent: #10151c;
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
