#!/usr/bin/env node
/** Build a public-safe static QA bundle. Does not publish or change production assets. */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOutputThumbnails } from '../lib/output-thumbnails.js';
import { outputId } from '../lib/output-library.js';
import { statusDashboardPage } from '../lib/status-dashboard.js';
const root = fileURLToPath(new URL('../', import.meta.url));

// Fixture-only lexer: keep production payloads intact except literal module URLs.
// Comments, ordinary strings and regexes must not be mistaken for import statements.
function moduleTokens(source) {
  const tokens = [];
  let index = 0, regexAllowed = true;
  const parentheses = [];
  while (index < source.length) {
    const start = index, char = source[index];
    if (/\s/.test(char)) { index++; continue; }
    if (source.startsWith('//', index)) { index = source.indexOf('\n', index); if (index < 0) break; continue; }
    if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); if (end < 0) throw new Error('Unterminated JavaScript comment'); index = end + 2; continue; }
    if (char === '/' && regexAllowed) {
      index++; let inClass = false;
      while (index < source.length) {
        const next = source[index++];
        if (next === '\\') index++;
        else if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) break;
      }
      while (/[a-z]/i.test(source[index] || '') && index < source.length) index++;
      tokens.push({ value: '<regex>', start, end: index }); regexAllowed = false; continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      index++; let interpolated = false;
      while (index < source.length) {
        const next = source[index++];
        if (next === '\\') index++;
        else if (next === char) break;
        else if (char === '`' && next === '$' && source[index] === '{') interpolated = true;
      }
      const raw = source.slice(start + 1, index - 1);
      if (interpolated && /\bimport\s*\(/.test(raw)) throw new Error('Move dynamic imports out of interpolated template strings so fixture asset URLs can be versioned safely.');
      const value = raw.replace(/\\(u\{[\da-f]+\}|u[\da-f]{4}|x[\da-f]{2}|\r?\n|.)/gi, (_, escape) => {
        if (escape.startsWith('u{')) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
        if (/^[ux]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
        return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '', '\r\n': '' })[escape] ?? escape;
      });
      tokens.push({ value, string: !interpolated, start, end: index }); regexAllowed = false; continue;
    }
    const word = /^[\w$]+/.exec(source.slice(index))?.[0];
    const value = word || char;
    index += value.length;
    if (value === '(') parentheses.push(/^(if|while|for|with|switch|catch)$/.test(tokens.at(-1)?.value));
    regexAllowed = value === ')' ? !!parentheses.pop() : word ? /^(return|throw|case|delete|void|typeof|new|in|instanceof|yield|await|else|do)$/.test(word) : !/[\].]/.test(value);
    tokens.push({ value, start, end: index });
  }
  return tokens;
}

function rewriteModuleUrls(source, rewrite) {
  const tokens = moduleTokens(source), replacements = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], next = tokens[index + 1];
    if (token.string || !['import', 'export'].includes(token.value) || tokens[index - 1]?.value === '.') continue;
    let reference;
    if (token.value === 'import' && next?.value === '(') {
      reference = tokens[index + 2];
      if (!reference?.string || ![')', ','].includes(tokens[index + 3]?.value)) throw new Error('Fixture imports must use literal URLs; computed dynamic imports cannot be cache-versioned safely.');
    } else if (token.value === 'import' && next?.string) reference = next;
    else if (next?.value !== '.' && (token.value === 'import' || ['*', '{'].includes(next?.value))) {
      for (let cursor = index + 1; cursor < tokens.length && ![';', 'import', 'export'].includes(tokens[cursor].value); cursor++) {
        if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.string) { reference = tokens[cursor + 1]; break; }
      }
    }
    if (reference) {
      const value = rewrite(reference.value);
      if (value !== reference.value) {
        const quote = source[reference.start];
        const escaped = value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
        replacements.push({ ...reference, replacement: `${quote}${escaped}${quote}` });
      }
    }
  }
  for (const replacement of replacements.reverse()) source = source.slice(0, replacement.start) + replacement.replacement + source.slice(replacement.end);
  return source;
}

export async function versionFixtureAssets(directory, html) {
  const assets = new Map();
  async function collect(relative = '') {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (/\.(?:css|m?js)$/.test(name)) assets.set(name, await readFile(path.join(directory, name), 'utf8'));
    }
  }
  await collect();
  // Hash the complete unrewritten CSS/JS set and HTML, not just each importer.
  // This transitive bundle version also handles cyclic imports without recursive
  // hash equations. A dependency-only edit invalidates every importing URL.
  const builder = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const version = createHash('sha256').update(JSON.stringify(['fixture-assets-v1', builder, html, [...assets]])).digest('hex').slice(0, 20);
  const versionUrl = (reference, importer = 'index.html', module = false) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference) || (module && !/^(?:\.{1,2}\/|\/)/.test(reference))) return reference;
    const url = new URL(reference, `https://fixture.invalid/${importer}`);
    const target = decodeURIComponent(url.pathname.slice(1));
    if (!assets.has(target)) {
      if (module || /\.(?:css|m?js)$/.test(url.pathname)) throw new Error(`Missing local fixture asset: ${reference} imported by ${importer}`);
      return reference;
    }
    url.searchParams.set('v', version);
    return reference.split(/[?#]/, 1)[0] + url.search + url.hash;
  };
  for (const [name, source] of assets) {
    if (/\.m?js$/.test(name)) await writeFile(path.join(directory, name), rewriteModuleUrls(source, reference => versionUrl(reference, name, true)));
    else {
      const versioned = source.replace(/\/\*[\s\S]*?\*\/|@import\s+(['"])(.*?)\1|url\(\s*(?:(['"])(.*?)\3|([^'"\s)]+))\s*\)/gi, (match, importQuote, imported, urlQuote, quoted, bare) => {
        if (match.startsWith('/*')) return match;
        const reference = imported ?? quoted ?? bare;
        if (!reference) return match;
        const offset = match.lastIndexOf(reference);
        return match.slice(0, offset) + versionUrl(reference, name) + match.slice(offset + reference.length);
      });
      if (versioned !== source) await writeFile(path.join(directory, name), versioned);
    }
  }
  return html.replace(/\b(src|href)=(['"])([^'"]+)\2/g, (match, attribute, quote, reference) => `${attribute}=${quote}${versionUrl(reference)}${quote}`);
}

// Fixture recordings start at 08:00; yesterday stays fully selectable after midnight.
export function fixtureConsoleSource(source) {
  return source.replaceAll("$('date-select').value = today(); state.date = today();", "$('date-select').value = state.date = shanghai.format(new Date(Date.now() - 86400000));")
    .replaceAll("$('date-select').value = state.date = today();", "$('date-select').value = state.date = shanghai.format(new Date(Date.now() - 86400000));");
}

async function main() {
const destination = path.resolve(process.argv[2] || path.join(root, 'fixture-dist'));
const media = process.env.CONSOLE_FIXTURE_MEDIA || '/workspace/shared/prototype-assets/demo.mp4';
if (destination === root || destination === path.join(root, 'public')) throw new Error('Build destination must not replace source assets.');
await mkdir(destination, { recursive: true });
await cp(path.join(root, 'public'), destination, { recursive: true, filter: source => !source.endsWith('.orig') && path.basename(source) !== 'index.html' });
await writeFile(path.join(destination, 'console.js'), fixtureConsoleSource(await readFile(path.join(destination, 'console.js'), 'utf8')));
await cp(media, path.join(destination, 'demo.mp4'));
// Extract from the supplied synthetic MP4, never from an account or recording source.
const thumbnails = createOutputThumbnails({ root: destination });
const poster = await thumbnails.get(outputId('demo.mp4'));
await writeFile(path.join(destination, 'demo-poster.jpg'), poster);
const posterVersion = createHash('sha256').update(poster).digest('hex').slice(0, 20);
const runtime = (await readFile(path.join(root, 'scripts/console-fixture-browser.js'), 'utf8'))
  .replace("'./demo-poster.jpg'", `'./demo-poster.jpg?v=${posterVersion}'`);
await writeFile(path.join(destination, 'fixture-runtime.js'), runtime);
const banner = '<aside id="fixture-banner" role="note" style="position:relative;z-index:10000;background:#fffbeb;color:#92400e;padding:8px 16px;text-align:center;font:500 12px/1.5 system-ui,sans-serif">公开演示 · 所有录像和数据均为合成 · 操作仅保存在当前页面内存 · 请勿输入真实账号或密码</aside>';
const html = statusDashboardPage('.').replace(/(<script type="module" src="\.\/console\.js"><\/script>)/, '<script src="./fixture-runtime.js"></script>\n  $1').replace(/(<body[^>]*>)/, `$1\n${banner}`);
if (!html.includes('fixture-runtime.js')) throw new Error('Could not inject fixture runtime before console.js.');
await writeFile(path.join(destination, 'index.html'), await versionFixtureAssets(destination, html));
await writeFile(path.join(destination, 'fixture-info.json'), JSON.stringify({ synthetic: true, runtime: 'browser-memory', realNetworkOperations: false, scenarios: ['normal','empty','error','auth','setup','recordings-empty','recordings-error','media-error','upload-error','config-error','config-conflict','preparation','slow','cloud-verify-success', 'cloud-verify-unknown', 'cloud-verify-pending', 'cloud-verify-error'], optionalQueries: { accounts: 'demo', settings: 'ready', cover: 'missing' }, cloudVerification: { jobId: '00000000-0000-4000-8000-000000000189', pendingDelayMs: 6000, uploadOperations: false }, warning: 'No real account login. All video is synthetic. Covers remain in browser memory.', generatedAt: new Date().toISOString() }, null, 2));
// Copy the usage text into a neutral downloadable file, avoiding production documentation.
await writeFile(path.join(destination, 'fixture-readme.txt'), 'Public synthetic console QA. Add ?fixture=normal, empty, error, auth, setup, recordings-empty, recordings-error, media-error, upload-error, config-error, config-conflict, preparation, slow, cloud-verify-success, cloud-verify-unknown, cloud-verify-pending, or cloud-verify-error. Cloud verification scenarios seed an UNKNOWN UUID job: success resolves completed, unknown retains UNKNOWN, pending delays 6 seconds then succeeds, error returns 503 and retains UNKNOWN. Open #tasks and choose 核实结果; no upload is performed. Add #library, #tasks, or #settings. Optional: &accounts=demo enables clearly marked manual QR-state simulation; &settings=ready supplies enabled synthetic upload settings; &cover=missing tests cover setup. All operations and cover bytes are local to this browser tab and reset on reload. No real authentication, cameras, exports, uploads, collection ownership verification, or file deletion.\n');
console.log(`Static synthetic fixture built: ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
