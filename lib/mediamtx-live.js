/** Bounded WHEP signaling to a server-configured MediaMTX origin. No client URL is accepted. */
export function createMediaMtxLive({ baseUrl = 'http://127.0.0.1:8889', fetchImpl = fetch, timeoutMs = 10_000, maxBodyBytes = 128 * 1024 } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('MediaMTX WebRTC 地址必须是纯 HTTP(S) 服务根地址。');
  function endpoint(path) {
    if (typeof path !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(path)) throw new Error('直播通道无效。');
    return new URL(`/${path}/whep`, base);
  }
  async function request(url, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      let bytes = 0; const chunks = [];
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBodyBytes) { controller.abort(); await reader.cancel(); throw new Error('直播协商响应过大。'); } chunks.push(Buffer.from(value)); }
        } finally { reader.releaseLock(); }
      }
      return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') };
    } finally { clearTimeout(timer); }
  }
  const failure = status => Object.assign(new Error(status === 404 ? '当前通道没有直播流。' : '直播协商暂不可用。'), { status: status === 404 ? 404 : 502 });
  return {
    async options(path, { signal } = {}) {
      const result = await request(endpoint(path), { method: 'OPTIONS', signal });
      if (result.status < 200 || result.status >= 300) throw failure(result.status);
      return { link: result.headers.get('link') };
    },
    async open(path, offer, { signal } = {}) {
      if (typeof offer !== 'string' || !offer.startsWith('v=0') || Buffer.byteLength(offer) > maxBodyBytes) throw Object.assign(new Error('直播协商内容无效。'), { status: 400 });
      const url = endpoint(path), result = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer, signal });
      if (result.status !== 201) throw failure(result.status);
      const location = result.headers.get('location');
      if (!location) throw failure(502);
      const sessionUrl = new URL(location, url);
      // The response may identify a session, never redirect a later request to another host/path.
      if (sessionUrl.origin !== base.origin || sessionUrl.username || sessionUrl.password || sessionUrl.search || sessionUrl.hash || !new RegExp(`^/${path}/whep/[a-f0-9-]{36}$`, 'i').test(sessionUrl.pathname)) throw failure(502);
      let finished = false;
      return {
        answer: result.body, etag: result.headers.get('etag'),
        get finished() { return finished; },
        async patch(fragment, { signal } = {}) {
          if (finished) throw failure(404);
          if (typeof fragment !== 'string' || Buffer.byteLength(fragment) > maxBodyBytes) throw Object.assign(new Error('直播候选内容无效。'), { status: 400 });
          const response = await request(sessionUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/trickle-ice-sdpfrag', 'If-Match': '*' }, body: fragment, signal });
          if (response.status !== 204) throw failure(response.status);
        },
        async stop() {
          if (finished) return;
          finished = true;
          // Best effort: peer connection close is also observed by MediaMTX.
          try { await request(sessionUrl, { method: 'DELETE' }); } catch {}
        },
      };
    },
  };
}
