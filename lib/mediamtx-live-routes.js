import express from 'express';
import { randomUUID } from 'node:crypto';

/** Mount only signaling. Media travels through MediaMTX's existing ICE configuration. */
export function mountMediaMtxLive(app, { transport, getCamera, reservePreview }) {
  const sessions = new Map();
  const route = '/console/api/playback/:camera/live';
  const resolve = req => {
    const camera = getCamera(req.params.camera);
    if (!camera) throw Object.assign(new Error('摄像头不存在。'), { status: 404 });
    return camera.archivePath || camera.id;
  };
  const fail = (res, error) => { if (!res.headersSent && !res.destroyed) res.status(error.status || 502).json({ success: false, error: error.message }); };
  // The reader's same-origin OPTIONS is translated to this authenticated GET by the client wrapper.
  app.get(`${route}/options`, async (req, res) => {
    try { const result = await transport.options(resolve(req)); if (result.link) res.set('Link', result.link); res.status(204).end(); }
    catch (error) { fail(res, error); }
  });
  app.post(`${route}/whep`, express.text({ type: 'application/sdp', limit: '128kb' }), async (req, res) => {
    const controller = new AbortController();
    let delivered = false, session, reservation;
    res.once('close', () => { if (!delivered) { controller.abort(); session?.stop(); } });
    try {
      const path = resolve(req);
      if (typeof req.body !== 'string' || !req.body.startsWith('v=0')) throw Object.assign(new Error('直播协商内容无效。'), { status: 400 });
      if (controller.signal.aborted) return;
      reservation = await reservePreview(controller);
      const peer = await transport.open(path, req.body, { signal: controller.signal });
      if (controller.signal.aborted || !reservation.isCurrent()) { await peer.stop(); throw Object.assign(new Error('预览已被较新的请求替换。'), { status: 409 }); }
      const id = randomUUID();
      session = { ...peer, camera: req.params.camera, path, async stop(reason) { sessions.delete(id); reservation.finish(session); await peer.stop(reason); } };
      sessions.set(id, session); reservation.attach(session);
      res.set('Location', `sessions/${id}`).set('Content-Type', 'application/sdp').set('Cache-Control', 'private, no-store');
      if (peer.etag) res.set('ETag', peer.etag);
      // Mark complete only after Express has accepted the complete bounded answer.
      res.status(201).send(peer.answer); delivered = true;
    } catch (error) { await session?.stop(); fail(res, error); }
    finally { if (!delivered) reservation?.finish(session); }
  });
  const find = req => {
    const session = sessions.get(req.params.session);
    if (!session || session.camera !== req.params.camera || session.path !== resolve(req)) throw Object.assign(new Error('直播会话不存在。'), { status: 404 });
    return session;
  };
  app.patch(`${route}/sessions/:session`, express.text({ type: 'application/trickle-ice-sdpfrag', limit: '128kb' }), async (req, res) => {
    try { await find(req).patch(req.body); res.status(204).end(); } catch (error) { fail(res, error); }
  });
  app.delete(`${route}/sessions/:session`, async (req, res) => {
    try { await find(req).stop('client closed'); res.status(204).end(); } catch (error) { fail(res, error); }
  });
}
