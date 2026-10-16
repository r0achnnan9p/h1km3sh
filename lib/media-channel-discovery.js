/** Read-only MediaMTX catalog. Discovery is deliberately separate from saved aliases. */
import fs from 'node:fs';
import path from 'node:path';

const VALID_PATH = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_API = 'http://127.0.0.1:9997';
const ENDPOINTS = ['paths', 'recordings'];
const failure = code => Object.assign(new Error('MediaMTX channel discovery failed.'), { code });

function positiveLimit(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid discovery limit.');
  return value;
}

function apiOrigin(value) {
  if (value === null || value === '') return null; // Explicit opt-out, including environment-based local-only callers.
  if (typeof value !== 'string' || value.length > 2048) throw failure('invalid-config');
  let url;
  try { url = new URL(value); } catch { throw failure('invalid-config'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') throw failure('invalid-config');
  return url.origin;
}

/**
 * root/apiUrl overrides are optional; otherwise their environment values are read on
 * each call. HIKVISION_MEDIAMTX_API_URL is a control API root, independent of the
 * Playback URL. Only an absent API setting defaults to loopback:9997; an explicitly
 * empty setting disables API discovery (local folders remain available). A bad
 * explicit setting never falls back and no remote Playback port is inferred.
 *
 * paths() does bounded synchronous filesystem discovery, without network or writes.
 * refresh() coalesces requests, fetches both v3 lists, and resolves a safe snapshot.
 * Temporary failures retain the local and each endpoint's last successful catalog,
 * but changing either configured source discards all previous entries immediately.
 * No timers or requests are started until refresh() is called.
 */
export function createMediaChannelDiscovery({
  root, apiUrl, env = process.env, fetchImpl = globalThis.fetch,
  timeoutMs = 2000, maxBodyBytes = 2 * 1024 * 1024,
  maxPages = 10, pageSize = 100, maxEntries = 1024,
} = {}) {
  positiveLimit(timeoutMs, 60_000);
  positiveLimit(maxBodyBytes, 16 * 1024 * 1024);
  positiveLimit(maxPages, 100);
  positiveLimit(pageSize, 1000);
  positiveLimit(maxEntries, 10_000);
  let current;

  function state() {
    const configuredRoot = root === undefined ? env.HIKVISION_ARCHIVE_DIR : root;
    const configuredApi = apiUrl === undefined ? (env.HIKVISION_MEDIAMTX_API_URL ?? DEFAULT_API) : apiUrl;
    let directory = null, origin = null, archiveStatus = 'disabled', apiStatus = 'pending';
    if (configuredRoot) {
      if (typeof configuredRoot !== 'string' || configuredRoot.length > 4096 || configuredRoot.includes('\0')) archiveStatus = 'invalid-config';
      else { directory = path.resolve(configuredRoot); archiveStatus = 'pending'; }
    }
    try { origin = apiOrigin(configuredApi); if (!origin) apiStatus = 'disabled'; }
    catch { apiStatus = 'invalid-config'; }
    // Keep invalid configurations distinct too, without exposing their contents.
    const key = JSON.stringify([configuredRoot ?? null, configuredApi, directory]);
    if (!current || current.key !== key) {
      for (const controller of current?.controllers || []) controller.abort();
      current = { key, directory, origin, archiveStatus, apiStatus, local: [],
        paths: [], recordings: [], diagnostics: { archive: archiveStatus, paths: apiStatus, recordings: apiStatus },
        controllers: new Set(), flight: null };
    }
    return current;
  }

  function scanArchive(target) {
    target.diagnostics.archive = target.archiveStatus;
    if (!target.directory) return;
    let directory;
    const names = [];
    try {
      // opendir/read bounds memory and work even when the root has many entries.
      // Dirent.isDirectory excludes symlinks; never inspect children or recurse.
      directory = fs.opendirSync(target.directory, { bufferSize: 32 });
      target.diagnostics.archive = 'ok';
      let count = 0, entry;
      while (count < maxEntries && (entry = directory.readSync())) {
        count++;
        if (entry.isDirectory() && !entry.isSymbolicLink() && VALID_PATH.test(entry.name)) names.push(entry.name);
      }
      if (count === maxEntries && directory.readSync()) target.diagnostics.archive = 'limit';
      target.local = Object.freeze(names);
    } catch {
      target.diagnostics.archive = 'unavailable';
    } finally {
      try { directory?.closeSync(); } catch { /* The catalog must remain nonthrowing. */ }
    }
  }

  function paths() {
    const target = state();
    scanArchive(target);
    return [...new Set([...target.local, ...target.paths, ...target.recordings])].sort();
  }

  function snapshot() {
    const names = paths();
    return Object.freeze({ paths: Object.freeze(names), diagnostics: Object.freeze({ ...current.diagnostics }) });
  }

  async function fetchNames(target, endpoint, signal) {
    const names = new Set();
    let bytes = 0, entries = 0, expectedCount, expectedPages;
    for (let page = 0; page < maxPages; page++) {
      if (signal.aborted) throw failure('timeout');
      const url = new URL(`/v3/${endpoint}/list`, target.origin);
      url.search = new URLSearchParams({ page: String(page), itemsPerPage: String(pageSize) }).toString();
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw failure('unavailable');
      }
      const reader = response.body?.getReader();
      if (!reader) throw failure('invalid-response');
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBodyBytes) throw failure('limit');
          chunks.push(Buffer.from(value));
        }
      } finally {
        // Also close oversized or interrupted bodies; do not wait for a hostile peer.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw failure('invalid-response'); }
      if (!body || !Array.isArray(body.items) || !Number.isSafeInteger(body.pageCount) || body.pageCount < 0 ||
          !Number.isSafeInteger(body.itemCount) || body.itemCount < 0 ||
          (body.pageCount === 0 && body.items.length)) throw failure('invalid-response');
      entries += body.items.length;
      if (body.pageCount > maxPages || body.itemCount > maxEntries || entries > maxEntries || body.items.length > pageSize) throw failure('limit');
      if (expectedCount === undefined) { expectedCount = body.itemCount; expectedPages = body.pageCount; }
      if (body.itemCount !== expectedCount || body.pageCount !== expectedPages) throw failure('invalid-response');
      for (const item of body.items) {
        if (!item || typeof item.name !== 'string') throw failure('invalid-response');
        if (VALID_PATH.test(item.name)) names.add(item.name);
      }
      if (page + 1 >= body.pageCount) {
        if (entries !== expectedCount) throw failure('invalid-response');
        return [...names];
      }
    }
    throw failure('limit');
  }

  async function refreshEndpoint(target, endpoint) {
    const controller = new AbortController();
    target.controllers.add(controller);
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(failure('timeout'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    // One deadline covers every page, headers, and the entire response body.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const names = await Promise.race([fetchNames(target, endpoint, controller.signal), aborted]);
      if (state() === target) {
        target[endpoint] = Object.freeze(names);
        target.diagnostics[endpoint] = 'ok';
      }
    } catch (error) {
      if (state() === target) target.diagnostics[endpoint] =
        ['limit', 'timeout', 'invalid-response'].includes(error.code) ? error.code : 'unavailable';
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      controller.abort();
      target.controllers.delete(controller);
    }
  }

  function refresh() {
    const target = state();
    if (target.flight) return target.flight;
    if (!target.origin) return Promise.resolve(snapshot());
    target.flight = Promise.all(ENDPOINTS.map(endpoint => refreshEndpoint(target, endpoint)))
      .then(snapshot).finally(() => { target.flight = null; });
    return target.flight;
  }

  return Object.freeze({ paths, refresh, diagnostics: () => snapshot().diagnostics });
}

export const mediaChannelDiscovery = createMediaChannelDiscovery();
