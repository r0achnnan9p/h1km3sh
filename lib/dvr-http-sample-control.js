/** Private one-off recorder diagnostic excluded from the source distribution. */
import { CONSOLE_CONFIG_OWNER } from './console-config.js';
// Reserved synthetic identifier; no private task identity is distributed.
export const DVR_HTTP_SAMPLE_TASK_ID = '00000000-0000-4000-8000-000000000000';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MESSAGES = Object.freeze({
  unavailable: 'This private one-off compatibility diagnostic is unavailable in the source distribution.',
  blocked: 'Compatibility diagnostic unavailable in this source distribution.',
  invalid: 'Invalid compatibility diagnostic request.',
});
export function createDvrHttpSampleControl() {
  const unavailable = async () => ({ ok: false, status: 409, error: MESSAGES.unavailable });
  return { available: () => false, resumeAvailable: () => false,
    start: unavailable, resume: unavailable, recoverInterrupted: () => false };
}
export function mountDvrHttpSample(app, { control, canWrite = () => true,
  preparationOnly = () => process.env.HIKCLIP_PREPARATION_ONLY === '1' } = {}) {
  app.post('/console/api/tasks/:id/dvr-http-sample', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const owner = req[CONSOLE_CONFIG_OWNER];
      if (!owner || owner.sessionVersion !== 3 || owner.isSessionActive?.() !== true)
        return res.status(401).json({ success: false, error: '请重新登录后开始兼容性测试。' });
      if (preparationOnly() || !canWrite()) return res.status(409).json({ success: false, error: MESSAGES.blocked });
      if (!UUID.test(req.params.id) || !req.body || typeof req.body !== 'object'
        || Array.isArray(req.body) || Object.keys(req.body).length !== 0)
        return res.status(400).json({ success: false, error: MESSAGES.invalid });
      const result = await (req.params.id === DVR_HTTP_SAMPLE_TASK_ID ? control.resume(req.params.id) : control.start(req.params.id));
      if (result?.ok === true && result.taskId === DVR_HTTP_SAMPLE_TASK_ID)
        return res.status(202).json({ success: true, taskId: DVR_HTTP_SAMPLE_TASK_ID });
      const status = result?.status === 409 ? 409 : 503;
      return res.status(status).json({ success: false, error: status === 409 ? MESSAGES.unavailable : MESSAGES.blocked });
    } catch { return res.status(503).json({ success: false, error: MESSAGES.blocked }); }
  });
}
