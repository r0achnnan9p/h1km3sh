// Thin wrappers over the server HTTP API. All calls return parsed JSON
// (callers check `.success`), except preview which returns a Blob.

function qs(params) {
  return new URLSearchParams(params).toString();
}

// --- Devices ---

export async function getDevices() {
  const res = await fetch('/api/devices');
  return res.json();
}

export async function addDevice(ip, username, password) {
  const res = await fetch('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, username, password }),
  });
  return res.json();
}

export async function deleteDevice(id) {
  const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
  return res.json();
}

export async function activateDevice(id) {
  const res = await fetch(`/api/devices/${id}/activate`, { method: 'PUT' });
  return res.json();
}

// --- UI session ---

export async function getSession() {
  const res = await fetch('/api/session');
  return res.json();
}

export async function saveSession(patch) {
  const res = await fetch('/api/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.json();
}

// --- Channels ---

export async function getChannels({ ip, user, pass }) {
  const res = await fetch(`/api/channels?${qs({ ip, user, pass })}`);
  return res.json();
}

// --- Preview ---
// Returns a JPEG Blob on success, or null if the endpoint failed / returned non-image.

export async function fetchPreviewBlob(endpoint, params, signal) {
  const res = await fetch(`${endpoint}?${qs({ ...params, t: Date.now() })}`, { signal });
  if (!res.ok) return null;
  const blob = await res.blob();
  if (!blob || blob.size === 0 || !blob.type.startsWith('image/')) return null;
  return blob;
}

// --- Recordings ---

export async function getRecordings({ ip, user, pass }, channel, startTime, endTime) {
  const res = await fetch(`/api/recordings?${qs({ ip, user, pass, channel, startTime, endTime })}`);
  return res.json();
}

// --- Export ---

export async function startExport(payload) {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function stopExport(taskId) {
  const res = await fetch('/api/export/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  return res.json();
}

export async function getStatus() {
  const res = await fetch('/api/status');
  return res.json();
}

export function openProgressStream() {
  return new EventSource('/api/progress');
}

// --- Cache ---

export async function getCache() {
  const res = await fetch('/api/cache');
  return res.json();
}

export async function clearCache() {
  const res = await fetch('/api/cache', { method: 'DELETE' });
  return res.json();
}

// --- Outputs (成品 MP4) ---

export async function getOutputs(limit = 50) {
  const res = await fetch(`/api/outputs?${qs({ limit })}`);
  return res.json();
}

export async function deleteOutput(filename) {
  const res = await fetch(`/api/outputs/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  return res.json();
}

export async function renameOutput(filename, newName) {
  const res = await fetch(`/api/outputs/${encodeURIComponent(filename)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName }),
  });
  return res.json();
}

// --- Schedules (定时导出) ---

export async function getSchedules() {
  const res = await fetch('/api/schedules');
  return res.json();
}

export async function updateSchedule(id, patch) {
  const res = await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.json();
}
