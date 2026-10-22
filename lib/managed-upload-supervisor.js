/** Approved, pinned uploader processes inside the existing app service cgroup. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PROVIDERS = ['bilibili', 'cloud189'];
const VERIFICATION_CODES = new Set(['CLOUD_RETRY_QUEUED', 'CLOUD_RECORD_ARCHIVED', 'CLOUD_RECORD_RESTORED', 'CLOUD_REMOTE_VERIFIED', 'CLOUD_TARGET_MISSING', 'CLOUD_FILE_NOT_FOUND', 'CLOUD_REMOTE_MISMATCH', 'ACCOUNT_CHANGED', 'VERIFY_SOURCE_CHANGED', 'VERIFY_BUSY', 'VERIFY_NOT_ELIGIBLE', 'VERIFY_UNAVAILABLE', 'VERIFY_NOT_AVAILABLE']);
const WORK = { bilibili: 'biliup_work', cloud189: 'cloud189_work' };

function regular(file, { executable = false } = {}) {
  try {
    for (let current = path.resolve(file);;) {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    const stat = fs.statSync(file);
    return stat.isFile() && (!executable || (stat.mode & 0o111) !== 0);
  } catch { return false; }
}

export function verifyManagedUploadTools(releaseRoot) {
  const directory = path.join(releaseRoot, 'upload-tools');
  const pins = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'config/upload-tools-pins.json'), 'utf8'));
  const manifestPath = path.join(directory, 'manifest.json');
  if (!regular(manifestPath)) throw new Error('Managed uploader tools unavailable');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.profile !== 'managed-uploads-v1' || manifest.platform !== 'linux-x64') throw new Error('Invalid uploader profile');
  const binaries = {};
  for (const provider of PROVIDERS) {
    const pin = pins.tools?.[provider], tool = manifest.tools?.[provider];
    if (!pin || !tool || ['version', 'filename', 'url', 'archiveSha256'].some(key => tool[key] !== pin[key])
        || !/^[a-f0-9]{64}$/.test(tool.fileSha256 || '')) throw new Error('Unpinned uploader binary');
    const binary = path.join(directory, pin.filename);
    if (!regular(binary, { executable: true }) || fs.statSync(binary).size > 512 * 1024 * 1024) throw new Error('Invalid uploader executable');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    if (hash !== tool.fileSha256) throw new Error('Uploader executable checksum mismatch');
    binaries[provider] = binary;
  }
  return binaries;
}

export function createManagedUploadSupervisor({ releaseRoot, dataDir, downloadsDir, getState,
  spawnProcess = spawn, checkTools = verifyManagedUploadTools, now = Date.now,
  stopGraceMs = 5000,
  isProcessGroupAlive = child => { try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } },
  killProcessGroup = (child, signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } },
} = {}) {
  if (![releaseRoot, dataDir, downloadsDir].every(value => typeof value === 'string' && path.isAbsolute(value))
      || typeof getState !== 'function') throw new Error('Managed uploader paths/state are required');
  // Resolve the immutable release once; following pointers/current on each spawn
  // could combine a new binary with the old running application's implementation.
  releaseRoot = fs.realpathSync(releaseRoot);
  const accountRoot = path.join(dataDir, 'private/upload-accounts');
  const entries = Object.fromEntries(PROVIDERS.map(provider => [provider,
    { child: null, nextStartAt: 0, failures: 0, state: 'disabled', signature: '', stopping: false, cleanup: null, group: null }]));
  const verifications = new Set();
  let closed = false, binaries = null, toolError = false, timer = null;

  const credential = provider => path.join(accountRoot, `${provider}.json`);
  function desired(provider, state) {
    if (closed || state.preparationOnly !== false || state.recoveryReady !== true || state.managedEnabled !== true)
      return { enabled: false, reason: 'disabled' };
    const setting = state[provider] || {};
    if (setting.enabled !== true) return { enabled: false, reason: 'disabled' };
    if (!regular(credential(provider))) return { enabled: false, reason: 'needs_login' };
    if (provider === 'bilibili' && (!Number.isSafeInteger(setting.seasonId) || setting.seasonId <= 0
        || !Number.isSafeInteger(setting.sectionId) || setting.sectionId <= 0
        || typeof setting.coverPath !== 'string' || !path.isAbsolute(setting.coverPath) || !regular(setting.coverPath)))
      return { enabled: false, reason: 'configuration_required' };
    return { enabled: true, setting, signature: JSON.stringify(setting) };
  }
  function stopChild(entry, afterState = 'stopped', nextStartAt = 0) {
    if (entry.cleanup || !entry.child) return entry.cleanup;
    entry.stopping = true; entry.state = 'stopping';
    const child = entry.child;
    entry.group = child;
    try { killProcessGroup(child, 'SIGTERM'); } catch { entry.state = 'stop_failed'; }
    // Keep the group identity independently from the leader and its close event.
    // An inherited lock may still be held by a descendant after leader exit.
    entry.cleanup = new Promise(resolve => {
      const deadline = setTimeout(() => {
        try { killProcessGroup(child, 'SIGKILL'); } catch {}
        clearInterval(poll);
        setTimeout(resolve, 25);
      }, stopGraceMs);
      const poll = setInterval(() => {
        if (!isProcessGroupAlive(child)) { clearTimeout(deadline); clearInterval(poll); resolve(); }
      }, 25);
    }).then(() => {
      entry.cleanup = null; entry.group = null; entry.stopping = false;
      if (entry.child === child) entry.child = null;
      entry.state = afterState; entry.nextStartAt = nextStartAt;
    });
    return entry.cleanup;
  }
  function environment(provider, setting) {
    const home = path.join(accountRoot, `${provider}-home`);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home,
      LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
      HIKVISION_DOWNLOADS_DIR: downloadsDir, HIKVISION_DATA_DIR: dataDir, HIKCLIP_UPLOAD_GENERATION_REQUIRED: '1',
      HIKCLIP_UPLOAD_CONNECTION_FILE: path.join(accountRoot, `${provider}.connection.json`) };
    if (process.env.TZ) env.TZ = process.env.TZ;
    if (provider === 'bilibili') Object.assign(env, {
      BILIUP_BINARY: binaries.bilibili, BILIUP_COOKIE_FILE: credential(provider),
      BILIUP_COVER_FILE: setting.coverPath, BILIUP_SEASON_ID: String(setting.seasonId),
      BILIUP_SECTION_ID: String(setting.sectionId),
    });
    else Object.assign(env, { CLOUD189_BINARY: binaries.cloud189, CLOUD189_BACKEND: 'gowsp',
      CLOUD189_CONFIG_FILE: credential(provider), CLOUD189_VERBOSE: '0' });
    return { env, home };
  }
  function reconcile() {
    if (closed) return status();
    let state;
    try { state = getState() || {}; } catch { state = {}; }
    for (const provider of PROVIDERS) {
      const entry = entries[provider], wanted = desired(provider, state);
      if (entry.cleanup) { entry.state = 'stopping'; continue; }
      if (!wanted.enabled) { entry.state = wanted.reason; stopChild(entry); continue; }
      if (entry.child) {
        // Configuration replacement is deliberately deferred while the worker is
        // alive. Integrators stop/reconcile after an explicitly approved restart.
        entry.state = entry.stopping ? 'stopping' : entry.signature === wanted.signature ? 'running' : 'restart_required';
        continue;
      }
      if (now() < entry.nextStartAt) { entry.state = 'backoff'; continue; }
      try {
        if (!binaries) binaries = checkTools(releaseRoot);
        toolError = false;
        const { env, home } = environment(provider, wanted.setting);
        const script = path.join(releaseRoot, 'scripts', provider === 'bilibili' ? 'biliup-worker.py' : 'cloud189-worker.py');
        const child = spawnProcess('/usr/bin/python3', [script], { cwd: home, env,
          detached: true, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
        entry.child = child; entry.signature = wanted.signature; entry.stopping = false; entry.state = 'starting';
        const startedAt = now();
        const finish = () => {
          if (entry.child !== child) return;
          const requested = entry.stopping;
          if (entry.cleanup) { entry.child = null; entry.state = 'stopping'; return; }
          entry.failures = requested || now() - startedAt > 60000 ? 0 : entry.failures + 1;
          entry.nextStartAt = now() + (requested ? 0 : Math.min(60000, 1000 * 2 ** Math.min(entry.failures, 6)));
          const afterState = requested ? 'stopped' : 'backoff';
          if (isProcessGroupAlive(child)) {
            stopChild(entry, afterState, entry.nextStartAt);
            entry.child = null;
            return;
          }
          entry.child = null; entry.stopping = false; entry.state = afterState;
        };
        child.once('error', finish); child.once('close', finish);
        child.once('spawn', () => { if (entry.child === child && !entry.stopping) entry.state = 'running'; });
      } catch {
        toolError = !binaries;
        entry.state = toolError ? 'tools_unavailable' : 'start_failed';
        entry.nextStartAt = now() + 30000;
      }
    }
    return status();
  }
  function cloud189Action(action, jobId, isActive = () => false) {
    const failed = () => ({ ok: false, code: 'VERIFY_UNAVAILABLE' });
    if (!['verify', 'retry', 'archive', 'restore'].includes(action) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobId) || !isActive() || verifications.size)
      return Promise.resolve(failed());
    let wanted, options;
    try {
      const state = getState() || {};
      if (closed || state.preparationOnly !== false || state.recoveryReady !== true || state.managedEnabled !== true)
        return Promise.resolve(failed());
      if (['archive', 'restore'].includes(action)) {
        // Local-only record actions need no credential or provider executable.
        // The Python helper still takes the same provider + inherited job locks.
        options = { home: releaseRoot, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', HIKVISION_DOWNLOADS_DIR: downloadsDir,
          HIKCLIP_UPLOAD_GENERATION_REQUIRED: '1' } };
      } else {
        wanted = desired('cloud189', state);
        if (!wanted.enabled) return Promise.resolve(failed());
        binaries ??= checkTools(releaseRoot);
        options = environment('cloud189', wanted.setting);
      }
      if (!isActive()) return Promise.resolve(failed());
    } catch { return Promise.resolve(failed()); }
    return new Promise(resolve => {
      let child, timer, poll, finished = false, output = Buffer.alloc(0);
      const finish = value => {
        if (finished) return; finished = true;
        clearTimeout(timer); clearInterval(poll);
        resolve(value);
      };
      const cancel = () => {
        if (child) { try { killProcessGroup(child, 'SIGKILL'); } catch {} }
        finish(failed());
      };
      try {
        child = spawnProcess('/usr/bin/python3', [path.join(releaseRoot, 'scripts/cloud189-worker.py'), `--${action}-job`, jobId],
          { cwd: options.home, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        verifications.add(child);
        timer = setTimeout(cancel, 120000);
        poll = setInterval(() => { if (closed || !isActive()) cancel(); }, 100);
        child.stdout.on('data', chunk => {
          if (output.length + chunk.length > 4096) return cancel();
          output = Buffer.concat([output, Buffer.from(chunk)]);
        });
        child.once('error', () => { verifications.delete(child); cancel(); });
        child.once('close', code => {
          if (!isProcessGroupAlive(child)) verifications.delete(child);
          else {
            try { killProcessGroup(child, 'SIGKILL'); } catch {}
            const deadline = Date.now() + stopGraceMs;
            const drain = setInterval(() => {
              if (!isProcessGroupAlive(child)) { verifications.delete(child); clearInterval(drain); }
              else if (Date.now() >= deadline) clearInterval(drain);
            }, 25);
          }
          try {
            const value = JSON.parse(output.toString('utf8'));
            if (![0, 2].includes(code) || typeof value.ok !== 'boolean' || !VERIFICATION_CODES.has(value.code)
              || (value.ok ? code !== 0 || !({ verify: ['CLOUD_REMOTE_VERIFIED'], retry: ['CLOUD_REMOTE_VERIFIED', 'CLOUD_RETRY_QUEUED'], archive: ['CLOUD_RECORD_ARCHIVED'], restore: ['CLOUD_RECORD_RESTORED'] })[action].includes(value.code) : code !== 2 || ['CLOUD_REMOTE_VERIFIED', 'CLOUD_RETRY_QUEUED', 'CLOUD_RECORD_ARCHIVED', 'CLOUD_RECORD_RESTORED'].includes(value.code))
              || Object.keys(value).some(key => !['ok', 'code'].includes(key)) || !isActive()) return finish(failed());
            finish({ ok: value.ok, code: value.code });
          } catch { finish(failed()); }
        });
      } catch { cancel(); }
    });
  }
  function status() {
    return { managed: true, toolsAvailable: !!binaries && !toolError,
      ...Object.fromEntries(PROVIDERS.map(provider => [provider, {
        state: entries[provider].state, running: !!entries[provider].child && !entries[provider].stopping,
      }])) };
  }
  function start() {
    if (closed) throw new Error('Uploader supervisor has stopped');
    if (!timer) { timer = setInterval(reconcile, 5000); timer.unref?.(); }
    return reconcile();
  }
  async function stopProvider(provider) {
    if (provider === 'cloud189') {
      // Disconnect/rebind must also drain the credential-using read-only process
      // group; leader close alone does not establish that its CLI child exited.
      const groups = [...verifications];
      for (const child of groups) { try { killProcessGroup(child, 'SIGKILL'); } catch {} }
      const deadline = Date.now() + stopGraceMs;
      while (groups.some(child => isProcessGroupAlive(child)) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25));
      if (groups.some(child => isProcessGroupAlive(child))) throw new Error('Cloud verification is still stopping');
      for (const child of groups) verifications.delete(child);
    }
    const entry = entries[provider];
    if (!entry) throw new Error('Unknown upload provider');
    const group = entry.group || entry.child;
    await stopChild(entry);
    if (group && isProcessGroupAlive(group)) throw new Error('Upload worker is still stopping');
  }
  function stop() { closed = true; for (const child of verifications) { try { killProcessGroup(child, 'SIGKILL'); } catch {} } if (timer) clearInterval(timer); timer = null; return Promise.all(Object.values(entries).map(entry => stopChild(entry))); }
  function killNow() {
    closed = true; for (const child of verifications) { try { killProcessGroup(child, 'SIGKILL'); } catch {} } if (timer) clearInterval(timer); timer = null;
    for (const entry of Object.values(entries)) {
      for (const child of new Set([entry.child, entry.group].filter(Boolean))) { try { killProcessGroup(child, 'SIGKILL'); } catch {} }
    }
  }
  return { start, reconcile, stopProvider, stop, killNow, status, verifyCloud189: (jobId, isActive) => cloud189Action('verify', jobId, isActive),
    recoverCloud189: (action, jobId, isActive) => cloud189Action(action, jobId, isActive) };
}

/** Readiness is account-derived; settings flags must never bypass a missing binding. */
export function uploadAccountReady(account) {
  return account?.available === true && account.credentialsPresent === true && account.bindingPresent === true
    && account.busy === false && !['needs_login', 'error', 'unavailable'].includes(account.state);
}
