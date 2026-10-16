import { MediaMTXWebRTCReader } from './mediamtx-reader.js';

/** One cancellable live attempt; the caller owns channel/navigation generations and fallback. */
export function startMediaMtxLive({ video, url, onReady = () => {}, onUnavailable = () => {}, Reader = MediaMTXWebRTCReader, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const endpoint = new URL(url, location.href);
  if (endpoint.origin !== location.origin || !/\/console\/api\/playback\/[a-zA-Z0-9_-]{1,64}\/live\/whep$/.test(endpoint.pathname) || endpoint.search || endpoint.hash) throw new Error('直播入口无效。');
  const prefix = endpoint.pathname.slice(0, -4), requests = new Set();
  const isSession = target => target.origin === endpoint.origin && !target.username && !target.password && !target.search && !target.hash && target.pathname.startsWith(prefix + 'sessions/') && /^[a-f0-9-]{36}$/i.test(target.pathname.slice((prefix + 'sessions/').length));
  let closed = false, reader, sessionUrl, stream, ready = false;
  const cleanupSession = target => fetchImpl(target, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); clearInterval(monitor); reader?.close();
    for (const controller of requests) controller.abort(); requests.clear();
    video.removeEventListener('playing', playing); video.removeEventListener('resize', playing); video.removeEventListener('error', failed);
    if (stream && video.srcObject === stream) video.srcObject = null;
    if (sessionUrl) { cleanupSession(sessionUrl); sessionUrl = null; }
  };
  const fail = () => { if (closed) return; close(); onUnavailable(); };
  const playing = () => { if (closed || ready || video.srcObject !== stream || !(video.videoWidth > 0)) return; ready = true; clearTimeout(timer); onReady(); };
  const failed = () => fail();
  const timer = setTimeout(fail, timeoutMs);
  let lastFrame = null, lastFrameAt = Date.now();
  const monitor = setInterval(() => {
    const now = Date.now(), frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.currentTime;
    if (!ready || video.paused || video.srcObject !== stream || frames !== lastFrame) { lastFrame = frames; lastFrameAt = now; return; }
    if (now - lastFrameAt >= 10_000) fail();
  }, 1000);
  video.addEventListener('playing', playing); video.addEventListener('resize', playing); video.addEventListener('error', failed);
  const request = async (input, init = {}) => {
    const target = new URL(input, endpoint), method = init.method || 'GET';
    if (target.origin !== endpoint.origin || (target.href !== endpoint.href && !isSession(target)) || target.search || target.hash) throw new Error('直播会话地址无效。');
    if (method === 'DELETE') { await cleanupSession(target); return new Response(null, { status: 204 }); }
    if (closed) throw new Error('closed');
    const controller = new AbortController(); requests.add(controller);
    try {
      const response = await fetchImpl(method === 'OPTIONS' ? new URL('options', endpoint) : target, { ...init, method: method === 'OPTIONS' ? 'GET' : method, credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      if (method === 'POST' && response.status === 201) {
        const locationHeader = response.headers.get('location');
        if (!locationHeader) throw new Error('直播会话地址缺失。');
        const next = new URL(locationHeader, endpoint);
        if (!isSession(next)) throw new Error('直播会话地址无效。');
        if (closed) { await cleanupSession(next); throw new Error('closed'); }
        sessionUrl = next.href;
      }
      return response;
    } finally { requests.delete(controller); }
  };
  try {
    reader = new Reader({ url: endpoint.href, fetch: request, onError: fail, onTrack: event => {
      if (closed || !event.streams?.[0]) return;
      stream = event.streams[0]; video.srcObject = stream;
      event.track?.addEventListener('ended', fail, { once: true });
      const promise = video.play(); promise?.catch(error => { if (!closed && error?.name === 'NotAllowedError') { clearTimeout(timer); onReady(); } });
    } });
    if (closed) reader.close();
  } catch { fail(); }
  return { close };
}
