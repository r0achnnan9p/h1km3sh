/** MCP Apps 媒体卡片：由宿主传入结果，直接展示已签名图片或 MP4。 */
import { standaloneTheme } from './standalone-ui.js';

export const MEDIA_WIDGET_URI = 'ui://zl-camera/media-v3.html';

export function mediaWidgetResource(origin) {
  const base = origin ? new URL(origin) : null;
  const allowed = base ? [base.origin] : [];
  const prefix = base?.pathname.replace(/\/+$/, '') || '';
  return { uri: MEDIA_WIDGET_URI, mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: allowed, resourceDomains: allowed } },
      'openai/widgetDescription': '摄像头截图和录像播放器，可查看原图或下载视频。',
      'openai/widgetCSP': { connect_domains: allowed, resource_domains: allowed, redirect_domains: allowed } },
    text: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>摄像头媒体</title>
<style>${standaloneTheme}
  body { background: var(--surface); }
  main { display: grid; gap: .875rem; max-width: 64rem; margin: auto; padding: clamp(1rem, 4vw, 1.5rem); }
  h1 { font-size: 1.125rem; }
  #status { color: var(--muted); font-size: .875rem; }
  #media { display: grid; gap: .5rem; min-width: 0; }
  #media:empty { display: none; }
  video { display: block; width: 100%; max-height: 440px; border-radius: 12px; background: var(--bg); }
  a { display: flex; align-items: center; min-height: 44px; padding: .625rem .875rem; border-radius: 12px; font-weight: 600; overflow-wrap: anywhere; text-decoration-thickness: 1px; text-underline-offset: .2em; }
  #media a { background: var(--surface2); }
  #link { width: fit-content; background: var(--accent); color: var(--on-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style></head><body>
<main aria-labelledby="widget-title"><header><h1 id="widget-title">摄像头媒体</h1><p id="status" role="status">正在获取画面…</p></header>
<div id="media"></div><a id="link" target="_blank" rel="noopener noreferrer" hidden>打开原文件</a></main>
<script>
const allowed = ${JSON.stringify(allowed)};
const prefix = ${JSON.stringify(prefix)};
const statusEl = document.getElementById('status');
const media = document.getElementById('media');
const link = document.getElementById('link');
const pending = new Map();
let id = 0, generation = 0, currentTask, timer, renderedPath, polls = 0;
const batchLinks = new Map();
function setStatus(text) {
  if (statusEl.textContent !== text) statusEl.textContent = text;
}
function setLink(url, title) {
  if (url) {
    if (link.href !== url.href) link.href = url.href;
    if (link.textContent !== title) link.textContent = title;
    link.hidden = false;
  } else {
    link.hidden = true;
    link.removeAttribute('href');
  }
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    window.parent.postMessage({ jsonrpc: '2.0', id: requestId, method, params }, '*');
  });
}
function notify(method, params) {
  window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
}
function trustedUrl(value, pattern) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !allowed.includes(url.origin) || !url.pathname.startsWith(prefix + '/')) return null;
    if (pattern.test(url.pathname.slice(prefix.length))) return url;
  } catch {}
  return null;
}
const clipPath = /^\\/artifacts\\/videos\\/clips\\/[a-f0-9-]{36}\\.mp4$/;
const imagePath = /^\\/artifacts\\/images\\/(snapshot|timeline)\\/[a-f0-9-]{36}\\.png$/;
const jobPath = /^\\/media-jobs\\/[a-f0-9-]{36}$/;

function render(result) {
  if (!result) return;
  clearTimeout(timer);
  const revision = ++generation;
  if (currentTask !== result.taskId) polls = 0;
  currentTask = result.taskId;
  const files = Array.isArray(result.files) ? result.files : [];
  const complete = result.status === 'completed';
  const stopped = result.status === 'error' || result.status === 'cancelled';
  const ready = files.length + '/' + result.total + ' 个镜头';
  const status = stopped
    ? (result.message || (result.status === 'error' ? '导出失败' : '已取消'))
    : result.total
      ? (complete && files.length === result.total ? '全部成片已就绪' : '已完成 ' + ready)
      : complete ? '已生成' : result.message || '正在生成，请稍候…';

  setStatus(status);
  const progress = trustedUrl(result.progressUrl, jobPath);
  if (result.artifactUrl && !(complete && files.length)) {
    const video = trustedUrl(result.artifactUrl, clipPath);
    const artifact = video || trustedUrl(result.artifactUrl, imagePath);
    if (!artifact) {
      media.replaceChildren();
      renderedPath = null;
      batchLinks.clear();
      setLink(progress, '自动更新的结果页面');
      setStatus('媒体地址不受信任');
      return;
    }
    batchLinks.clear();
    setLink(artifact, video ? '打开／下载视频' : '查看原图');
    const path = artifact.origin + artifact.pathname;
    if (renderedPath !== path) {
      renderedPath = path;
      media.replaceChildren();
      if (video) {
        const player = document.createElement('video');
        player.controls = true;
        player.title = '录像播放';
        player.preload = 'metadata';
        player.playsInline = true;
        player.defaultMuted = player.muted = true;
        player.onerror = () => {
          if (media.firstElementChild === player) setStatus('文件暂时无法加载，请使用原文件链接');
        };
        player.src = artifact.href;
        media.append(player);
      }
    }
    notify('ui/notifications/size-changed', { height: document.body.scrollHeight });
    return;
  }

  setLink(complete && files.length ? null : progress, '自动更新的结果页面');
  if (renderedPath) {
    renderedPath = null;
    media.replaceChildren();
  }
  const visible = new Set();
  for (const file of files) {
    const url = trustedUrl(file.artifactUrl, clipPath);
    if (!url) continue;
    const path = url.origin + url.pathname;
    if (visible.has(path)) continue;
    const index = visible.size;
    visible.add(path);
    let anchor = batchLinks.get(path);
    if (!anchor) {
      anchor = document.createElement('a');
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      batchLinks.set(path, anchor);
    }
    anchor.href = url.href;
    const name = file.filename || '打开文件';
    if (anchor.textContent !== name) anchor.textContent = name;
    if (media.children[index] !== anchor) media.insertBefore(anchor, media.children[index] || null);
  }
  for (const [path, anchor] of batchLinks) {
    if (!visible.has(path)) { anchor.remove(); batchLinks.delete(path); }
  }
  notify('ui/notifications/size-changed', { height: document.body.scrollHeight });
  if (complete || stopped || !currentTask || polls >= 1000) return;
  polls++;
  timer = setTimeout(async () => {
    try {
      const next = await request('tools/call', { name: 'get_export_status', arguments: { taskId: currentTask } });
      if (revision !== generation) return;
      if (next.isError) throw new Error('status');
      render(next.structuredContent);
    } catch {
      if (revision === generation) setStatus('请使用自动结果页面查看进度');
    }
  }, 2500);
}
window.addEventListener('message',event=>{
 if(event.source!==window.parent)return;const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
 if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}
 if(m.method==='ui/notifications/tool-result')render(m.params?.structuredContent);
});
request('ui/initialize',{appInfo:{name:'zl-camera-media',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
 .then(()=>notify('ui/notifications/initialized',{})).catch(()=>{statusEl.textContent='媒体组件初始化失败，请使用原文件链接';});
if(window.openai?.toolOutput)render(window.openai.toolOutput);
window.addEventListener('openai:set_globals',e=>render(e.detail?.globals?.toolOutput));
</script></body></html>` };
}
