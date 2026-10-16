/** Owner-only result verification and reversible record recovery; confirmed retry admits a new attempt. */
import { CONSOLE_CONFIG_OWNER } from './console-config.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MESSAGES = {
  CLOUD_RETRY_QUEUED: '已确认目标目前无文件，已重新加入队列；上次结果保留为待确认。',
  CLOUD_RECORD_ARCHIVED: '已移除待处理记录，成片已解除此任务的占用；原上传结果保留，可恢复记录。',
  CLOUD_RECORD_RESTORED: '已恢复记录，可继续核实或重试。',
  CLOUD_REMOTE_VERIFIED: '已核实云盘文件、大小与校验值，没有重新上传。',
  CLOUD_TARGET_MISSING: '云盘目标目录目前不存在；原任务仍待确认，没有重新上传。',
  CLOUD_FILE_NOT_FOUND: '云盘尚未找到这个文件；原任务仍待确认，没有重新上传。',
  CLOUD_REMOTE_MISMATCH: '云盘文件与原文件不一致；原任务仍待确认，没有重新上传。',
  ACCOUNT_CHANGED: '账号已改变，不能核实原账号的任务。',
  VERIFY_SOURCE_CHANGED: '原文件已改变或不可用，无法安全核实。',
  VERIFY_BUSY: '账号正在处理其他操作，请稍后核实。',
  VERIFY_NOT_ELIGIBLE: '任务状态已改变，请刷新任务列表。',
  VERIFY_UNAVAILABLE: '暂时无法核实云盘结果，请稍后再试；没有重新上传。',
};
export function mountCloud189Verification(app, { queue, verify, recover, canWrite = () => true,
  preparationOnly = () => process.env.HIKCLIP_PREPARATION_ONLY === '1' } = {}) {
  for (const action of ['verify', 'retry', 'archive', 'restore']) app.post(`/console/api/uploads/cloud189/:id/${action}`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const owner = req[CONSOLE_CONFIG_OWNER];
    if (!owner || owner.sessionVersion !== 3 || owner.isSessionActive?.() !== true)
      return res.status(401).json({ success: false, error: '请重新登录后核实上传结果。' });
    if (preparationOnly() || !canWrite()) return res.status(409).json({ success: false, error: '当前尚不能核实上传结果。' });
    if (!UUID.test(req.params.id) || !req.body || Array.isArray(req.body)
        || (action === 'retry' ? req.body.confirmRetry !== true || Object.keys(req.body).some(key => key !== 'confirmRetry') : Object.keys(req.body).length))
      return res.status(400).json({ success: false, error: '核实请求无效。' });
    let job;
    try { job = queue.get(req.params.id); } catch {}
    if (!job || job.provider !== 'cloud189' || job.status !== 'unknown' || job.uploadPhase !== 'remote_started' || (['verify', 'retry'].includes(action) && job.archivedAt))
      return res.status(409).json({ success: false, error: MESSAGES.VERIFY_NOT_ELIGIBLE });
    let result;
    try {
      const isActive = () => owner.isSessionActive() && !preparationOnly() && canWrite();
      const execute = () => action === 'verify' ? verify(req.params.id, isActive) : recover(action, req.params.id, isActive);
      result = queue.runRecovery ? await queue.runRecovery(req.params.id, execute) : await execute();
    }
    catch { result = { ok: false, code: 'VERIFY_UNAVAILABLE' }; }
    if (!owner.isSessionActive()) return res.status(401).json({ success: false, error: '登录已退出，请重新登录。' });
    const code = Object.hasOwn(MESSAGES, result?.code) ? result.code : 'VERIFY_UNAVAILABLE';
    res.json({ success: true, verified: result?.ok === true && code === 'CLOUD_REMOTE_VERIFIED', applied: result?.ok === true, code, message: MESSAGES[code] });
  });
}
