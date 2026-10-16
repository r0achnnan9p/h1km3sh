/**
 * Server-side device storage backed by a JSON file.
 * Provides CRUD operations and active device tracking.
 *
 * Data file location:
 *   - Normal (node server.js / portable bundle): <project>/data/devices.json
 *   - Single executable (SEA .exe):               <exe-dir>/data/devices.json
 *   - Override with env HIKVISION_DATA_DIR
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDataDir } from './data-dir.js';
import { normalizeDeviceEndpoint } from './device-endpoint.js';

const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, 'devices.json');

/**
 * Absolute path to the devices.json file currently in use.
 */
export function getDataFilePath() {
  return DATA_FILE;
}

function validateTextFields(fields) {
  for (const key of ['name', 'username', 'password']) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') throw new Error(`Invalid device ${key}`);
  }
}

/** Read and validate without altering legacy bytes until an explicit write. */
function readStore() {
  let raw;
  try { raw = fs.readFileSync(DATA_FILE, 'utf-8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { devices: [], activeDeviceId: null };
    throw error;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.devices) || (data.activeDeviceId !== null && data.activeDeviceId !== undefined && typeof data.activeDeviceId !== 'string')) throw new Error();
    const ids = new Set();
    data.devices = data.devices.map(device => {
      if (!device || typeof device.id !== 'string' || !device.id || ids.has(device.id)) throw new Error();
      validateTextFields(device);
      ids.add(device.id);
      return { ...device, ...normalizeDeviceEndpoint(device) };
    });
    return { ...data, activeDeviceId: data.activeDeviceId || null };
  } catch {
    throw new Error('Device configuration is invalid; original file preserved');
  }
}

/** Atomic private write; failed reads never create an empty replacement store. */
function writeStore(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${DATA_FILE}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, DATA_FILE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// --- Public API ---

/**
 * Get all devices. Passwords are included (single-user internal tool).
 */
export function getAllDevices() {
  const { devices, activeDeviceId } = readStore();
  return { devices, activeDeviceId };
}

/**
 * Get a single device by ID, or null if not found.
 */
export function getDeviceById(id) {
  const { devices } = readStore();
  return devices.find(d => d.id === id) || null;
}

/**
 * Get the currently active device, or null if none set.
 */
export function getActiveDevice() {
  const { devices, activeDeviceId } = readStore();
  if (!activeDeviceId) return null;
  return devices.find(d => d.id === activeDeviceId) || null;
}

/**
 * Add a new device. Returns the created device object.
 */
export function addDevice({ name, ip, username, password, httpPort, rtspPort }, { autoActivate = true } = {}) {
  const store = readStore();
  validateTextFields({ name, username, password });
  const device = {
    id: crypto.randomUUID(),
    name: name || ip,
    ...normalizeDeviceEndpoint({ ip, httpPort, rtspPort }),
    username,
    password,
    createdAt: new Date().toISOString(),
  };
  store.devices.push(device);

  // If this is the first device, auto-activate it
  if (autoActivate && store.devices.length === 1) {
    store.activeDeviceId = device.id;
  }

  writeStore(store);
  return device;
}

/**
 * Update an existing device. Returns the updated device or null if not found.
 */
export function updateDevice(id, fields) {
  const store = readStore();
  const index = store.devices.findIndex(d => d.id === id);
  if (index === -1) return null;

  validateTextFields(fields);
  const allowed = ['name', 'username'];
  const endpoint = normalizeDeviceEndpoint({ ...store.devices[index], ...Object.fromEntries(['ip', 'httpPort', 'rtspPort'].filter(key => fields[key] !== undefined).map(key => [key, fields[key]])) });
  Object.assign(store.devices[index], endpoint);
  // Empty and omitted passwords mean keep the existing secret.
  if (fields.password !== undefined && fields.password !== '') store.devices[index].password = fields.password;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      store.devices[index][key] = fields[key];
    }
  }
  store.devices[index].updatedAt = new Date().toISOString();

  writeStore(store);
  return store.devices[index];
}

/**
 * Delete a device by ID. Returns true if deleted, false if not found.
 */
export function deleteDevice(id, { autoActivate = true } = {}) {
  const store = readStore();
  const before = store.devices.length;
  store.devices = store.devices.filter(d => d.id !== id);

  if (store.devices.length === before) return false;

  // If we deleted the active device, clear or reassign
  if (store.activeDeviceId === id) {
    store.activeDeviceId = autoActivate && store.devices.length > 0 ? store.devices[0].id : null;
  }

  writeStore(store);
  return true;
}

/**
 * Set a device as active. Returns the device or null if not found.
 */
export function activateDevice(id) {
  const store = readStore();
  const device = store.devices.find(d => d.id === id);
  if (!device) return null;

  store.activeDeviceId = id;
  writeStore(store);
  return device;
}

