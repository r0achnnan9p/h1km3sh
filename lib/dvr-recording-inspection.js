/** Bounded metadata inspection only, after an already-failed DESCRIBE. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import xml2js from 'xml2js';
import { deviceHttpOrigin } from './device-endpoint.js';
import { buildSearchXml, parseSearchResponse, cachedRecordingSearch } from './recording-search.js';
import { summarizeDvrRecordings, sanitizeDvrRecordingDiagnostics } from './dvr-recording-diagnostics.js';

const execute = promisify(execFile);
const BUDGET_MS = 5000;
const outcome = (value, source = 'search') => ({ outcome: value, source, matchCount: 0, truncated: false, recordings: [] });
const tagged = code => Object.assign(new Error('Recording metadata inspection failed'), { code });
function isoWall(compact) {
  if (typeof compact !== 'string' || /[\r\n]/.test(compact) || !/^\d{8}T\d{6}Z$/.test(compact)) throw tagged('INVALID');
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== iso.replace('Z', '.000Z')) throw tagged('INVALID');
  return iso;
}

// --max-redirs 0 also blocks curl's Digest authentication follow-up (exit 47).
// --no-location disables HTTP redirects without preventing the 401 challenge.
/** One search page, never follows HTTP redirects and never transfers media. */
export async function searchRecordingPage(options, { exec = execute } = {}) {
  const { ip, httpPort, user, pass, channel, startTime, endTime, signal } = options;
  if (signal?.aborted) throw tagged('CANCELLED');
  const endpoint = typeof ip === 'object' ? ip : { ip, httpPort };
  const xml = buildSearchXml(randomUUID(), channel, startTime, endTime, 40, 0);
  const file = join(tmpdir(), `isapi_inspect_${randomUUID()}.xml`);
  writeFileSync(file, xml, { mode: 0o600 });
  try {
    const { stdout } = await exec(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--disable', '--no-location', '--connect-timeout', '2', '--max-time', '5', '-s', '--digest', '-u', `${user}:${pass}`,
      '-X', 'POST', '-H', 'Content-Type: application/xml', '--data-binary', `@${file}`,
      '--write-out', '\n%{http_code}', `${deviceHttpOrigin(endpoint)}/ISAPI/ContentMgmt/search`,
    ], { timeout: BUDGET_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal });
    if (signal?.aborted) throw tagged('CANCELLED');
    const match = typeof stdout === 'string' && /\n(\d{3})$/.exec(stdout);
    if (!match) throw tagged('INVALID');
    const status = Number(match[1]), body = stdout.slice(0, match.index);
    if (status === 401 || status === 403) throw tagged('AUTHENTICATION');
    if (/\bnotSupport\b/i.test(body)) throw tagged('UNSUPPORTED');
    if (status < 200 || status >= 300) throw tagged('FAILED');
    if (/<ResponseStatus\b/.test(body)) throw tagged(/\bUnauthorized\b/i.test(body) ? 'AUTHENTICATION' : 'FAILED');
    let parsed;
    try { parsed = await parseSearchResponse(body, channel); } catch { throw tagged('INVALID'); }
    return { files: parsed.files, truncated: parsed.totalMatches > parsed.files.length || parsed.numOfMatches >= 40 };
  } finally { try { unlinkSync(file); } catch {} }
}

/** Exact DownloadAbility schema (Hikvision General Application Guide,
 * 15.2.3 / 16.2.122). Note lowercase "by", unlike System capabilities.
 * Absence, other schema/casing, duplicate fields and malformed values are unknown.
 */
export async function readDownloadCapabilities(options, { exec = execute } = {}) {
  const { ip, httpPort, user, pass, signal } = options;
  if (signal?.aborted) return 'unknown';
  const endpoint = typeof ip === 'object' ? ip : { ip, httpPort };
  const limit = Number.isInteger(options.budgetMs) && options.budgetMs > 0 && options.budgetMs <= BUDGET_MS ? options.budgetMs : BUDGET_MS;
  try {
    const { stdout } = await exec(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--disable', '--no-location', '--connect-timeout', '2', '--max-time', String(limit / 1000),
      '-s', '--digest', '-u', `${user}:${pass}`, '-X', 'GET', '--write-out', '\n%{http_code}',
      `${deviceHttpOrigin(endpoint)}/ISAPI/ContentMgmt/download/capabilities`,
    ], { timeout: limit, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal });
    if (signal?.aborted || typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 64 * 1024) return 'unknown';
    const match = /\n(\d{3})$/.exec(stdout);
    if (!match || Number(match[1]) !== 200) return 'unknown';
    const body = stdout.slice(0, match.index);
    if (/<!DOCTYPE|<!ENTITY/i.test(body)) return 'unknown';
    // The promise/callback API resolves at the first root close, before trailing
    // junk is validated. Consume the complete document before trusting a result.
    let parsed, invalid = false, roots = 0, openedRoots = 0, depth = 0;
    const parser = new xml2js.Parser({ explicitArray: true, trim: true });
    parser.on('end', value => { parsed = value; roots++; });
    parser.on('error', () => { invalid = true; });
    // xml2js also marks its root ended before SAX reaches EOF. Count opening
    // roots/depth independently so an unclosed second root cannot slip through.
    const sax = parser.saxParser, onOpen = sax.onopentag, onClose = sax.onclosetag;
    sax.onopentag = node => { if (depth++ === 0) openedRoots++; onOpen(node); };
    sax.onclosetag = name => { onClose(name); depth--; };
    parser.parseString(body);
    if (invalid || roots !== 1 || openedRoots !== 1 || depth !== 0 || signal?.aborted || Object.keys(parsed || {}).length !== 1 || !Object.hasOwn(parsed, 'DownloadAbility')) return 'unknown';
    const root = parsed.DownloadAbility;
    if (!root || typeof root !== 'object' || Array.isArray(root) || Object.hasOwn(root, '_')) return 'unknown';
    if (root.$?.xmlns !== undefined && root.$.xmlns !== 'http://www.isapi.org/ver20/XMLSchema') return 'unknown';
    const values = Object.hasOwn(root, 'isSupportDownloadbyTime') ? root.isSupportDownloadbyTime : null;
    if (!Array.isArray(values) || values.length !== 1) return 'unknown';
    return values[0] === 'true' || values[0] === '1' ? 'supported'
      : values[0] === 'false' || values[0] === '0' ? 'unsupported' : 'unknown';
  } catch { return 'unknown'; }
}

/** Its outcome never replaces the primary RTSP failure. Both metadata reads
 * share one deadline; a slow capability read cannot discard a completed search.
 */
export async function collectDvrRecordingDiagnostics(options, { search = searchRecordingPage, capabilities = readDownloadCapabilities, lookup = cachedRecordingSearch, budgetMs = BUDGET_MS } = {}) {
  if (options.signal?.aborted) return outcome('cancelled');
  let query;
  try {
    if (typeof options.channel !== 'string' || !/^\d{1,8}$/.test(options.channel)) return outcome('invalid');
    query = { ...options, startTime: isoWall(options.startTime), endTime: isoWall(options.endTime) };
    if (Date.parse(query.endTime) <= Date.parse(query.startTime)) return outcome('invalid');
  } catch { return outcome('invalid'); }
  const controller = new AbortController();
  const limit = Number.isInteger(budgetMs) && budgetMs > 0 && budgetMs <= BUDGET_MS ? budgetMs : BUDGET_MS;
  let timer, abort, finished = false, recording, downloadByTime = 'unknown';
  return new Promise(resolve => {
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      controller.abort();
      resolve(sanitizeDvrRecordingDiagnostics({ ...result, downloadByTime }) || outcome('invalid'));
    };
    abort = () => finish(outcome('cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    // Starts before cache/search/capabilities; never a second five-second budget.
    timer = setTimeout(() => finish(recording || outcome('timeout')), limit);
    const readOptions = { ...query, signal: controller.signal, budgetMs: limit };
    const readRecording = Promise.resolve().then(async () => {
      try {
        const files = lookup(query);
        if (Array.isArray(files)) return summarizeDvrRecordings({ ...query, files, source: 'cache' });
      } catch { /* An unavailable cache is not a new export failure. */ }
      const result = await search(readOptions);
      return summarizeDvrRecordings({ ...query, files: result?.files, source: 'search', truncated: result?.truncated === true });
    }).then(result => { if (!finished) recording = result; }, error => {
      if (finished) return;
      const kind = error?.code === 'AUTHENTICATION' ? 'authentication' : error?.code === 'UNSUPPORTED' ? 'unsupported'
        : error?.code === 'INVALID' ? 'invalid' : error?.code === 'CANCELLED' || error?.name === 'AbortError' ? 'cancelled'
        : error?.code === 28 || error?.killed === true ? 'timeout' : 'failed';
      recording = outcome(kind);
    });
    const readCapabilities = Promise.resolve().then(() => capabilities(readOptions)).then(value => {
      if (!finished && (value === 'supported' || value === 'unsupported')) downloadByTime = value;
    }, () => { /* Missing, denied, malformed or timed-out capability stays unknown. */ });
    Promise.all([readRecording, readCapabilities]).then(() => finish(recording || outcome('invalid')),
      () => finish(recording || outcome('invalid')));
  });
}
