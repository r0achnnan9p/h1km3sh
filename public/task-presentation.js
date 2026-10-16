const terminalStatuses = new Set(['completed', 'error', 'cancelled', 'unknown']);
const waitingStatuses = new Set(['draft', 'queued', 'pending']);
const workingStatuses = new Set(['downloading', 'converting', 'uploading']);

/** 仅真实运行阶段显示进度；草稿和队列等待不伪装成正在处理。 */
export function taskProgressPresentation(task = {}) {
  const status = String(task.status || '');
  const value = task.stage === 'submitting' ? NaN : status === 'completed' ? 100 : task.stage ? (task.stagePercent == null ? NaN : Number(task.stagePercent)) : Number(task.progress);
  const hasPercent = Number.isFinite(value) && (value > 0 || (value === 0 && task.progressUnit === 'bytes' && task.stagePercent != null));
  const show = !terminalStatuses.has(status) && !waitingStatuses.has(status) && task.stage !== 'preparing';
  return {
    show,
    hasPercent,
    percent: hasPercent ? Math.min(status === 'completed' || task.stage ? 100 : 99, value) : 0,
    indeterminate: show && workingStatuses.has(status) && !hasPercent,
  };
}


const stageLabels = { searching: '搜索录像', cache: '复用缓存', downloading: '下载录像', trimming: '裁剪片段', remuxing: '封装片段', concatenating: '拼接 MP4', finalizing: '保存成品', preparing: '准备上传', uploading: '传输文件', submitting: '提交稿件' };
export function taskStageLabel(task = {}) {
  return workingStatuses.has(task.status) ? stageLabels[task.stage] || '' : '';
}
export function taskProgressCaption(task = {}, now = Date.now()) {
  const progress = taskProgressPresentation(task);
  if (waitingStatuses.has(task.status)) return '';
  if (terminalStatuses.has(task.status)) return task.status === 'completed' ? '100%' : '';
  const parts = [];
  if (progress.hasPercent) parts.push(`${task.stage ? (task.progressUnit === 'files' ? '文件完成 ' : '本阶段 ') : ''}${Math.round(progress.percent)}%`);
  else if (task.stage) parts.push('进度待测');
  if (Number.isFinite(task.processedSeconds) && task.processedSeconds >= 0) parts.push(`已处理 ${Math.floor(task.processedSeconds)} 秒`);
  if (Number.isFinite(task.progressUpdatedAt) && task.progressUpdatedAt > 0) parts.push(`${Math.max(0, Math.floor((now - progressTimestampMs(task.progressUpdatedAt)) / 1000))} 秒前更新`);
  return parts.join(' · ');
}


/** Old host-worker records used Unix seconds; new records use milliseconds. */
export function progressTimestampMs(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? (time > 1e9 && time < 1e12 ? time * 1000 : time) : 0;
}
function uploadBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(units.length - 1, value > 0 ? Math.floor(Math.log(value) / Math.log(1024)) : 0);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
/** Transfer evidence stays separate from submission; speed never hides the percentage. */
export function uploadProgressCaption(task = {}, now = Date.now()) {
  if (waitingStatuses.has(task.status)) return '';
  if (task.status === 'completed') return task.provider === 'bilibili' ? '稿件已提交' : '已完成';
  if (terminalStatuses.has(task.status)) return '';
  if (task.stage === 'preparing') return '检查文件与登录状态';
  const parts = [], presentation = taskProgressPresentation(task);
  if (task.stage === 'submitting') parts.push('文件传输结束，等待稿件确认');
  else if (presentation.hasPercent) parts.push(`文件上传 ${Math.round(presentation.percent)}%`);
  const uploaded = typeof task.uploadedBytes === 'number' ? task.uploadedBytes : NaN;
  const total = typeof task.totalBytes === 'number' ? task.totalBytes : NaN;
  if (Number.isFinite(uploaded) && uploaded >= 0) parts.push(Number.isFinite(total) && total > 0
    ? `${uploadBytes(uploaded)} / ${uploadBytes(total)}` : `已传 ${uploadBytes(uploaded)}`);
  const timestamp = progressTimestampMs(task.progressUpdatedAt), age = timestamp ? Math.max(0, now - timestamp) : null;
  if (task.stage !== 'submitting' && age !== null && age < 6000 && Number.isFinite(task.uploadSpeed) && task.uploadSpeed >= 0) {
    parts.push(`${uploadBytes(task.uploadSpeed)}/s`);
  }
  if (age !== null && age >= 6000) parts.push(`${Math.floor(age / 1000)} 秒前更新`);
  if (!parts.length) parts.push('等待上传工具回报进度');
  return parts.join(' · ');
}


/** Decimal bits/s. Promotion uses the rounded display, avoiding 1000 bps. */
export function fmtBps(value) {
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let v = Number.isFinite(value) && value >= 0 ? value : 0, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  const factor = 10 ** (2 - Math.floor(Math.log10(v || 1)));
  let rounded = Math.round((v + Number.EPSILON * v) * factor) / factor;
  if (rounded >= 1000 && i < units.length - 1) { rounded /= 1000; i++; }
  return { v: rounded.toFixed(rounded >= 100 ? 0 : rounded >= 10 ? 1 : 2), u: units[i] };
}
export function formatEta(seconds) { if (!Number.isFinite(seconds) || seconds < 0) return '—'; const rounded=Math.ceil(seconds); return Math.floor(rounded/60) + ':' + String(rounded%60).padStart(2,'0'); }
export function formatTransferBytes(value) { return (value / 1e6).toFixed(1) + ' MB'; }

/** Keep only server-timestamped evidence; duplicate SSE/refresh renders add no samples. */
export function createTransferSampler({ windowMs = 5000 } = {}) {
  const tasks = new Map();
  return {
    sample(task, now = Date.now()) {
      const id = task.taskId || task.id;
      const bytes = Number.isFinite(task.uploadedBytes) ? task.uploadedBytes : Number.isFinite(task.transferredBytes) ? task.transferredBytes : null;
      const fileScoped = task.transferScope === 'file';
      const timestamp = progressTimestampMs(bytes == null || fileScoped ? task.speedUpdatedAt || task.progressUpdatedAt : task.progressUpdatedAt || task.speedUpdatedAt);
      const total = Number.isFinite(task.totalBytes) && task.totalBytes > 0 ? task.totalBytes : null;
      const attempt = task.retryRequestedAt || task.startedAt || task.startTime || task.createdAt || '';
      let record = tasks.get(id);
      if (!record || record.attempt !== attempt || timestamp < record.last || (bytes != null && record.bytes != null && bytes < record.bytes)) {
        record = { attempt, points: [], last: 0, bytes: null, bps: null, history: [] }; tasks.set(id, record);
      }
      const transfer = ['downloading', 'uploading'].includes(task.status) && !['cache', 'preparing', 'submitting'].includes(task.stage);
      if (transfer && timestamp > record.last && timestamp <= now + 1000) {
        if (bytes != null && !fileScoped) {
          record.points.push({ t: timestamp, bytes });
          const cutoff = timestamp - windowMs;
          while (record.points.length > 2 && record.points[1].t <= cutoff) record.points.shift();
          let first = record.points[0];
          const second = record.points[1];
          if (second && first.t < cutoff && cutoff < second.t) first = { t: cutoff, bytes: first.bytes + (second.bytes - first.bytes) * (cutoff - first.t) / (second.t - first.t) };
          record.bps = timestamp > first.t ? Math.max(0, (bytes - first.bytes) * 8000 / (timestamp - first.t)) : null;
        } else {
          // File resets can fall between SSE snapshots; the backend already resets per file.
          // Existing backend rates are already smoothed; never apply another window.
          const rate = task.speed ?? task.uploadSpeed;
          record.bps = Number.isFinite(rate) && rate >= 0 ? rate * 8 : null;
        }
        if (record.bps != null) { record.history.push(record.bps); record.history = record.history.slice(-12); }
        record.last = timestamp; record.bytes = bytes;
      }
      const bps = transfer && timestamp && timestamp <= now + 1000 && now - timestamp < 6000 ? record.bps : null;
      return { bytes: bytes != null && bytes >= 0 ? bytes : null, total, bps, eta: bps > 0 && total != null && bytes != null && bytes <= total ? Math.ceil((total - bytes) * 8 / bps) : null, history: bps == null ? [] : record.history };
    },
  };
}

/** Stable task roots and independent per-tab scroll/count. No list-wide replacement. */
export function createTaskFeed(options) { return createCollectionFeed(options); }

// Tasks and the output library share one pagination/anchor implementation.
// Library cards update their own controls and keep media nodes attached.
export function createCollectionFeed({ list, scroller, sentinel, makeCard, createdAt = () => 0,
  groupDates = true, decorateTime = true, compare = null, emptyText = '还没有任务', isVisible = () => true,
  document = globalThis.document, pageSize = 20, observerFactory = callback => new IntersectionObserver(callback, { root: scroller, rootMargin: '0px 0px 100px 0px' }) }) {
  let limit = pageSize, tasks = [], observer;
  const nodes = new Map(), signatures = new WeakMap();
  let savedScroll = 0, savedAnchor = [];
  const visiblePanel = () => isVisible() && !scroller.hidden && (!scroller.getClientRects || scroller.getClientRects().length > 0);
  function hasLayout(card) {
    if (!card || (card.getClientRects && !card.getClientRects().length) || card.closest?.('details:not([open])')) return false;
    const rect = card.getBoundingClientRect(); return rect.bottom > rect.top;
  }
  function captureAnchor() {
    if (!scroller.getBoundingClientRect) return [];
    const bounds = scroller.getBoundingClientRect();
    return [...list.querySelectorAll('[data-task-id]')].filter(card => { if (!hasLayout(card)) return false; const r = card.getBoundingClientRect(); return r.bottom > bounds.top && r.top < bounds.bottom - 44; }).map(card => ({ id: card.dataset.taskId, offset: card.getBoundingClientRect().top - bounds.top }));
  }
  scroller.addEventListener('scroll', () => { if (visiblePanel()) { savedScroll = scroller.scrollTop; savedAnchor = captureAnchor(); } });
  const key = task => String(task.taskId || task.id);
  const active = task => !task.archivedAt && ['queued','pending','downloading','converting','uploading','stopping','reconciling'].includes(task.status);
  const priority = task => task.archivedAt ? 3 : !task.archivedAt && ['unknown','needs-confirmation'].includes(task.status) ? 0 : active(task) ? 1 : 2;
  function render(resumeAnchor = null) {
    const shown = visiblePanel(), scroll = shown ? scroller.scrollTop : savedScroll;
    const anchors = resumeAnchor || (shown ? captureAnchor() : savedAnchor);
    const retained = anchors.find(anchor => tasks.some(task => key(task) === anchor.id && (!task.archivedAt || nodes.get('archive')?.open === true)));
    const index = retained ? tasks.findIndex(task => key(task) === retained.id) : -1;
    if (index >= limit) limit = Math.ceil((index + 1) / pageSize) * pageSize;
    const visible = tasks.slice(0, limit), wanted = new Set(), ordered = [];
    let lastDate = null, archiveGroup = null, archiveIndex = 1;
    for (const task of visible) {
      const timestamp = createdAt(task);
      if (groupDates && priority(task) === 2) {
        const date = timestamp ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(timestamp) : '较早';
        if (date !== lastDate) { lastDate = date; const id = 'date:' + date; wanted.add(id); let group = nodes.get(id); if (!group) { group = document.createElement('h3'); group.className = 'task-date-heading'; group.textContent = date; nodes.set(id,group); } ordered.push(group); }
      }
      const id = 'task:' + key(task); wanted.add(id);
      let card = nodes.get(id);
      const fresh = makeCard(task);
      if (decorateTime && timestamp) { const time = document.createElement('time'); time.className = 'task-created-at'; time.dateTime = new Date(timestamp).toISOString(); time.textContent = new Date(timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }); time.title = (task.retryRequestedAt ? '重试于 ' : '创建于 ') + new Date(timestamp).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) + '（北京时间）'; time.setAttribute('aria-label',time.title); fresh.append(time); }
      if (!card) { card = fresh; card.dataset.taskId = key(task); nodes.set(id,card); signatures.set(card, fresh.outerHTML); }
      else if (fresh !== card) {
        // Keep the article identity and unchanged controls (including focused buttons).
        const focused = card.contains(document.activeElement) ? document.activeElement : null;
        const actionIndex = focused ? [...card.querySelectorAll('button')].indexOf(focused) : -1;
        const signature = fresh.outerHTML;
        if (signatures.get(card) !== signature) { card.className = fresh.className; while (card.firstChild) card.removeChild(card.firstChild); while (fresh.firstChild) card.append(fresh.firstChild); if (actionIndex >= 0) card.querySelectorAll('button')[actionIndex]?.focus({ preventScroll: true }); }
        signatures.set(card, signature);
      }
      if (task.archivedAt) {
        if (!archiveGroup) {
          const groupId = 'archive'; wanted.add(groupId); archiveGroup = nodes.get(groupId);
          if (!archiveGroup) { archiveGroup = document.createElement('details'); archiveGroup.className = 'removed-records'; const summary = document.createElement('summary'); archiveGroup.append(summary); nodes.set(groupId, archiveGroup); }
          archiveGroup.children[0].textContent = '已移除记录 · ' + tasks.filter(item => item.archivedAt).length; ordered.push(archiveGroup);
        }
        if (archiveGroup.children[archiveIndex] !== card) archiveGroup.insertBefore(card, archiveGroup.children[archiveIndex] || null); archiveIndex++;
      } else ordered.push(card);
    }
    if (!visible.length) { const id = 'empty'; wanted.add(id); let empty = nodes.get(id); if (!empty) { empty = document.createElement('p'); empty.className = 'empty-card'; empty.textContent = emptyText; nodes.set(id,empty); } ordered.push(empty); }
    for (const [id,node] of nodes) if (!wanted.has(id)) { node.remove(); nodes.delete(id); }
    ordered.forEach((node,index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
    sentinel.hidden = limit >= tasks.length;
    sentinel.textContent = sentinel.hidden ? '' : '正在载入更多…';
    savedScroll = scroll;
    if (shown) {
      const maximum = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = Math.max(0, Number.isFinite(maximum) ? Math.min(scroll, Math.max(0, maximum)) : scroll);
      const anchor = anchors.find(item => hasLayout(nodes.get('task:' + item.id)));
      if (anchor && scroller.getBoundingClientRect) scroller.scrollTop += nodes.get('task:' + anchor.id).getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
      savedScroll = scroller.scrollTop; savedAnchor = captureAnchor();
    }
  }
  function loadMore() { if (!visiblePanel() || limit >= tasks.length) return; limit += pageSize; render(); }
  if (typeof IntersectionObserver !== 'undefined') { observer = observerFactory(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }); observer.observe(sentinel); }
  else scroller.addEventListener('scroll', () => { if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100) loadMore(); });
  return {
    update(items) { tasks = [...items].sort(compare || ((a,b) => priority(a) - priority(b) || createdAt(b) - createdAt(a))); render(); },
    loadMore,
    reset() { limit = pageSize; savedScroll = 0; savedAnchor = []; scroller.scrollTop = 0; },
    clear() { for (const node of nodes.values()) node.remove(); nodes.clear(); tasks = []; this.reset(); sentinel.hidden = true; },
    resume() { if (visiblePanel()) { scroller.scrollTop = savedScroll; render(savedAnchor); } },
    get loadedCount() { return Math.min(limit, tasks.length); },
  };
}
