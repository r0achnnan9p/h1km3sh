import { setButtonIcon } from './ui-primitives.js';

export const SHARE_BYTE_LIMIT = 32 * 1024 * 1024;
const downloadHref = url => `${url}${url.includes('?') ? '&' : '?'}download=1`;
const DOWNLOAD_HELP = '下载后可在系统“文件”中分享，并在支持时选择“存储视频”。';

// Never call response.blob() on an unbounded recording (some are many GB).
export async function readShareFile(response, filename, { signal, FileType = globalThis.File, limit = SHARE_BYTE_LIMIT } = {}) {
  if (!response.ok || !/^video\/mp4(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('读取失败，请直接下载文件。');
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw new Error('视频较大，请直接下载文件。'); }
  if (!response.body?.getReader) throw new Error('此浏览器请使用直接下载。');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('视频较大，请直接下载文件。');
      chunks.push(value);
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!size) throw new Error('视频为空，请刷新后重试。');
    return new FileType(chunks, filename, { type: 'video/mp4' });
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export function createOutputDownload({ file, document = globalThis.document, navigator = globalThis.navigator || {}, fetch = globalThis.fetch, FileType = globalThis.File, resolveUrl = value => value, openDialog, onNotice = () => {} }) {
  let current = file;
  const element = document.createElement('a'); element.className = 'quiet-button ui-icon-button output-download';
  setButtonIcon(element, 'download', '下载成片');
  const update = next => { current = next; element.href = downloadHref(resolveUrl(next.streamUrl)); element.download = next.filename; };
  update(file);
  element.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.button > 0) return;
    const selected = current;
    // Ordinary download stays browser-managed and needs no JS copy of the file.
    let canShare = false;
    try { canShare = navigator.maxTouchPoints > 0 && selected.size > 0 && selected.size <= SHARE_BYTE_LIMIT && typeof FileType === 'function'
      && typeof navigator.share === 'function' && navigator.canShare?.({ files: [new FileType([new Uint8Array(1)], selected.filename, { type: 'video/mp4' })] }); } catch {}
    if (!canShare) { if (navigator.maxTouchPoints > 0) onNotice(DOWNLOAD_HELP); return; }
    event.preventDefault();
    const sheet = openDialog('下载', '', { trackChanges: false }), controller = new AbortController();
    let closed = false, prepared = null, sharing = false;
    const status = document.createElement('p'); status.className = 'setting-help'; status.textContent = '正在准备分享…'; status.setAttribute('role', 'status'); sheet.content.append(status);
    const fallback = document.createElement('a'); fallback.className = 'quiet-button'; fallback.textContent = '下载文件'; fallback.href = downloadHref(resolveUrl(selected.streamUrl)); fallback.download = selected.filename;
    fallback.addEventListener('click', () => { onNotice(DOWNLOAD_HELP); sheet.close(); });
    const share = document.createElement('button'); share.type = 'button'; share.className = 'primary-button'; share.textContent = '分享或存储视频'; share.disabled = true;
    share.addEventListener('click', async () => {
      if (!prepared || sharing || closed) return;
      sharing = true; share.disabled = true;
      try {
        // This second deliberate tap supplies fresh transient user activation.
        await navigator.share({ files: [prepared] });
        if (!closed) sheet.close();
      } catch (error) { if (!closed && error.name !== 'AbortError') sheet.error.textContent = '无法打开系统分享，请下载文件。'; }
      finally { sharing = false; if (!closed) share.disabled = !prepared; }
    });
    sheet.actions.append(fallback, share);
    sheet.dialog.addEventListener('close', () => { closed = true; prepared = null; controller.abort(); });
    fetch(resolveUrl(selected.streamUrl), { credentials: 'same-origin', signal: controller.signal })
      .then(response => readShareFile(response, selected.filename, { signal: controller.signal, FileType }))
      .then(result => {
        if (closed) return;
        if (!navigator.canShare({ files: [result] })) throw new Error('此视频无法系统分享，请下载文件。');
        prepared = result; share.disabled = false; status.textContent = '选择系统面板中的存储选项；是否可存入相册取决于设备。';
      }).catch(error => {
        if (closed) return;
        controller.abort(); status.textContent = DOWNLOAD_HELP; sheet.error.textContent = error.message || '准备失败，请下载文件。';
      });
  });
  return { element, update };
}
