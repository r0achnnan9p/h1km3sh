/** MCP Apps 媒体卡片：由宿主传入结果，直接展示已签名图片或 MP4。 */
export const MEDIA_WIDGET_URI = 'ui://zl-camera/media-v3.html';

export function mediaWidgetResource(origin) {
  const allowed = origin ? [new URL(origin).origin] : [];
  return { uri: MEDIA_WIDGET_URI, mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: allowed, resourceDomains: allowed } },
      'openai/widgetDescription': '摄像头截图和录像播放器，可查看原图或下载视频。',
      'openai/widgetCSP': { connect_domains: allowed, resource_domains: allowed, redirect_domains: allowed } },
    text: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px system-ui;margin:0;padding:12px;color:CanvasText;background:Canvas}img,video{display:block;width:100%;max-height:440px;object-fit:contain;border-radius:8px;background:#111}p{margin:8px 0}a{display:inline-block;margin:8px 0;color:#2979df}</style>
<p id="status" role="status">正在获取画面…</p><div id="media"></div><a id="link" target="_blank" rel="noopener noreferrer" hidden>打开原文件</a>
<script>
const allowed=${JSON.stringify(allowed)}, statusEl=document.getElementById('status'), media=document.getElementById('media'), link=document.getElementById('link');
const pending=new Map(); let id=0, currentTask, timer, renderedUrl, polls=0;
function request(method,params){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});window.parent.postMessage({jsonrpc:'2.0',id:n,method,params},'*');});}
function notify(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*');}
function render(result){
 if(!result)return;
 clearTimeout(timer); currentTask=result.taskId;
 statusEl.textContent=result.total?(result.status==='completed'&&result.files?.length===result.total?'全部成片已就绪':'任务尚未全部完成：已完成 '+(result.files?.length||0)+'/'+result.total+' 个镜头'):result.status==='completed'?'已生成':result.message||'正在生成，请稍候…';
 if(result.files?.length){
  media.replaceChildren();
  for(const file of result.files){
   let u;try{u=new URL(file.artifactUrl);}catch{continue;}
   if(u.protocol!=='https:'||!allowed.includes(u.origin)||!/^\\/artifacts\\/videos\\/clips\\/[a-f0-9-]{36}\\.mp4$/.test(u.pathname))continue;
   const a=document.createElement('a');a.href=file.artifactUrl;a.textContent=file.filename;a.target='_blank';a.rel='noopener noreferrer';media.append(a);
  }
  if(result.status==='completed')return;
 }
 if(result.progressUrl){
  try{const u=new URL(result.progressUrl);if(u.protocol==='https:'&&allowed.includes(u.origin)&&/^\\/media-jobs\\/[a-f0-9-]{36}$/.test(u.pathname)){link.href=result.progressUrl;link.textContent='自动更新的结果页面';link.hidden=false;}}catch{}
 }
 if(result.artifactUrl){
  let u;try{u=new URL(result.artifactUrl);}catch{statusEl.textContent='媒体地址无效';return;}
  if(u.protocol!=='https:'||!allowed.includes(u.origin)||!/^\\/artifacts\\/(images\\/(snapshot|timeline)\\/[a-f0-9-]{36}\\.png|videos\\/clips\\/[a-f0-9-]{36}\\.mp4)$/.test(u.pathname)){statusEl.textContent='媒体地址不受信任';return;}
  if(renderedUrl!==result.artifactUrl){
   renderedUrl=result.artifactUrl;media.replaceChildren();
   link.href=result.artifactUrl;link.hidden=false;
   link.textContent=u.pathname.endsWith('.mp4')?'打开／下载视频':'查看原图';
   if(u.pathname.endsWith('.mp4')){
    const node=document.createElement('video');node.controls=true;node.preload='metadata';node.playsInline=true;node.defaultMuted=true;node.muted=true;
    node.onerror=()=>{statusEl.textContent='文件暂时无法加载，请使用原文件链接';};
    node.src=result.artifactUrl;media.append(node);
   }

  }
  notify('ui/notifications/size-changed',{height:document.body.scrollHeight});return;
 }
 if(['error','cancelled'].includes(result.status))return;
 if(currentTask&&polls++<1000)timer=setTimeout(async()=>{try{const next=await request('tools/call',{name:'get_export_status',arguments:{taskId:currentTask}});if(next.isError){statusEl.textContent='请使用自动结果页面查看进度';return;}render(next.structuredContent);}catch{statusEl.textContent='请使用自动结果页面查看进度';}},2500);
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
</script></html>` };
}
