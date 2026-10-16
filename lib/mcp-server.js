/**
 * MCP 工具面：把「拉一段录像」暴露给 AI 客户端。
 *
 * 定位很窄——**只管临时调整时段那一半需求**。每天固定的 20:00–22:30 由
 * lib/scheduler.js 在常驻服务里跑，不走这里：MCP 是被动协议，要有客户端在那个
 * 时刻活着并主动调用才会执行，把雷打不动的日常交给它是错配。
 *
 * 两条硬性约束：
 *   - 设备密码只在本进程内用于拼请求，**绝不出现在任何工具返回值里**
 *   - 时间一律按本地墙钟（"19:30" 就是 NVR 面板上的 19:30），转换由这里做，
 *     不让模型自己拼紧凑格式，更不让它做时区换算
 */

import { createHikclipClient, HikclipError } from './hikclip-client.js';
import { createMcpDispatcher, serveStdio } from './mcp-stdio.js';
import { resolveExportMethod } from './export-method.js';
import { wallTime, wallRange } from './camera-time.js';
import { MEDIA_WIDGET_URI, mediaWidgetResource } from './media-widget.js';
import { matchFilename } from './match-workflow.js';
import {
  toCompact,
  compactToDisplay,
  durationSeconds,
  localDateStr,
} from './hik-time.js';

const SERVER_INFO = { name: 'hikclip', version: '1.1.0' };

/** 图片只交付原文件链接，禁止以其他图片代替摄像头画面。 */
function imageResult(task) {
  const url = task.artifactUrl;
  const video = url ? new URL(url, 'http://localhost').pathname.includes('/videos/') : false;
  const files = task.files || [];
  const links = files.length ? files.map(file => `[${file.filename}](${file.artifactUrl})`).join('\n\n')
    : url ? `[${video ? '打开／下载视频' : '查看原图'}](${url})` : '';
  const allReady = task.status === 'completed' && (!task.total || files.length === task.total);
  const progress = task.total ? `已完成 ${files.length}/${task.total} 个镜头。` : '';
  const ready_reply = allReady ? `全部成片已就绪。\n\n${links}`
    : `任务尚未全部完成。${progress}${task.message || ''}${task.progressUrl ? `\n\n[查看进度和最终文件](${task.progressUrl})` : ''}${links ? `\n\n以下仅为已完成的镜头：\n\n${links}` : ''}`;
  const pending = !['completed', 'error', 'cancelled'].includes(task.status);
  return { content: [{ type: 'text', text: ready_reply }], structuredContent: {
    taskId: task.taskId, status: task.status, source: task.source, artifactUrl: url, files,
    progressUrl: task.progressUrl, ready_reply, displayMode: 'link-only',
    next_action: pending ? { tool: 'get_export_status', arguments: { taskId: task.taskId }, automatic: true } : undefined,
    message: task.message, filename: task.filename, total: task.total, completedCount: files.length,
    allReady, kind: task.kind === 'batch' ? 'batch' : video ? 'video' : 'image',
  } };
}

/** 日志一律走 stderr——stdout 是协议流，写进去会把它污染成解析错误。 */
const logToStderr = (msg) => process.stderr.write(`[hikclip-mcp] ${msg}\n`);

/**
 * 兜底：把 console 的普通输出改道到 stderr。
 *
 * 这条链路上的模块（hikclip-client 及其依赖）现在没有 console.log，但只要将来
 * 有人顺手加一行，MCP 就会在握手阶段挂掉，且现象很难和「协议实现有 bug」区分。
 * console.error 本来就在 stderr，不用动。
 */
function redirectConsoleToStderr() {
  for (const level of ['log', 'info', 'debug', 'warn']) {
    console[level] = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
  }
}

const dateArg = {
  type: 'string',
  description: '日期，YYYY-MM-DD。省略则用今天。',
};
const channelArg = {
  type: 'string',
  description: '通道号（如 101 是 1 号通道主码流）。省略则沿用界面上次选的通道，再不行取设备的第一个通道。',
};

export const TOOL_DEFINITIONS = [
  {
    name: 'get_match_videos', description: '一次导出指定镜头的全场录像。只处理 cameras 中明确指定的镜头：D2 只一份，D1和D2才两份。优先MediaMTX copy音视频，按 对阵 镜头 日期.mp4 命名。同一进行中请求只返回原任务；起止时间与模式一致的已完成文件可复用，但必须等 status=completed 且 allReady=true 才能声称所有成片就绪。一次任务串行生成缺失文件，不自动投稿。pending 时自动继续 get_export_status；结果页面会自动更新。',
    inputSchema: { type: 'object', properties: { cameras: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 }, dvrMethod: { type: 'string', enum: ['auto', 'rtspclip', 'mp4download'], default: 'auto', description: '本地缺失时的 DVR 导出方式。auto沿用5分钟规则；文件下载明显限速时可选rtspclip全速并发回放。' }, start: { type: 'string' }, end: { type: 'string' }, matchup: { type: 'string' }, mode: { type: 'string', enum: ['copy', 'precise'], default: 'copy' } }, required: ['cameras', 'start', 'end', 'matchup'], additionalProperties: false },
  },
  {
    name: 'rename_match_video', description: '按对阵重命名 downloads 中的成品，自动补上摄像头编号和日期，不覆盖同名文件。',
    inputSchema: { type: 'object', properties: { filename: { type: 'string' }, matchup: { type: 'string' }, camera: { type: 'string' }, date: { type: 'string' } }, required: ['filename', 'matchup', 'camera', 'date'], additionalProperties: false },
  },
  {
    name: 'prepare_bilibili_upload', description: '准备已完成录像的 B 站投稿草稿，不会上传。固定体育运动/足球分区、足球标签、足球合集、仅自己可见和项目默认封面。用户明确说上传 B 站时才提交，不再追问固定参数。',
    inputSchema: { type: 'object', properties: { filename: { type: 'string' }, title: { type: 'string', description: '省略沿用文件名去掉 .mp4' } }, required: ['filename'], additionalProperties: false },
  },
  {
    name: 'submit_bilibili_upload', description: '用户明确授权本次投稿后提交草稿。不得因为导出完成就自动投稿。返回投稿任务，用 get_bilibili_upload_status 查询实际结果，不承诺稍后主动发送。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, confirmed: { type: 'boolean', const: true } }, required: ['id', 'confirmed'], additionalProperties: false },
  },
  {
    name: 'get_bilibili_upload_status', description: '查询 B 站投稿任务，完成返回 BV 号及 collectionStatus。若合集加入失败，只处理合集，不要重新上传视频；投稿失败或状态未知时先检查平台稿件。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'list_cameras', description: '列出摄像头别名和名称，不返回 DVR 地址、通道或凭据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_snapshot', description: '查看某个摄像头在指定时间的画面。例如“看看 D2 今天晚上八点十分”“D1 昨天下午三点什么情况”都调用本工具，将口语日期时间转换为录像机本地时间。通常一次调用直接返回原图链接；只提供真实链接，不嵌图，不调用图片搜索或生成图片代替。未完成才调用 get_export_status。',
    inputSchema: { type: 'object', properties: {
      camera: { type: 'string', description: '摄像头 ID 或名称' },
      datetime: { type: 'string', description: 'YYYY-MM-DD HH:MM[:SS]' },
    }, required: ['camera', 'datetime'], additionalProperties: false },
  },
  {
    name: 'get_video_clip', title: '获取摄像头录像片段', description: '用户只要求单个镜头的一段录像时调用；用户同时要求 D1/D2 全场应优先一次调用 get_match_videos。已有同镜头、同起止时间、同导出模式的完整成品会直接复用，不再重新拉录像。不要改用连续截图合成视频。支持真实含音频MP4导出。本地完整覆盖优先，否则按时长选择DVR回放或文件下载。未完成时媒体卡片会自动查询 get_export_status。',
    inputSchema: { type: 'object', properties: {
      camera: { type: 'string', description: '摄像头 ID 或名称' },
      start: { type: 'string', description: 'YYYY-MM-DD HH:MM[:SS]' },
      end: { type: 'string', description: 'YYYY-MM-DD HH:MM[:SS]，跨日填写结束日期' },
      matchup: { type: 'string', description: '可选对阵，例如 天行者 vs 九块九。自动命名为 对阵 摄像头 日期.mp4，保存到 downloads。' },
      mode: { type: 'string', enum: ['copy', 'precise'], default: 'copy', description: '全场默认 copy 原始音视频，不转码，边界有关键帧误差。precise 转码精确裁剪，较慢。' },
    }, required: ['camera', 'start', 'end'], additionalProperties: false },
  },
  {
    name: 'create_timeline_sheet', description: '生成带时间标注的缩略图，默认 36 格 6×6；每格间隔默认 60 秒。本地优先，缺少覆盖时获取海康素材。提交后等待生成，完成直接返回原图链接；仍在处理中必须继续调用 get_export_status，不能让用户催促查询。',
    inputSchema: { type: 'object', properties: {
      camera: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' },
      start: { type: 'string', description: 'HH:MM[:SS]' },
      interval: { type: 'integer', minimum: 1, maximum: 3600, default: 60 },
      count: { type: 'integer', minimum: 1, maximum: 36, default: 36 },
    }, required: ['camera', 'date', 'start'], additionalProperties: false },
  },
  {
    name: 'list_channels',
    description: '列出录像机上的通道（编号、名称、分辨率）。不确定该用哪个通道号时先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_recordings',
    description:
      '查某天某通道实际有哪些录像片段。导出前用它确认目标时段真的录到了东西，避免拉一段空的。',
    inputSchema: {
      type: 'object',
      properties: {
        date: dateArg,
        channel: channelArg,
        start: { type: 'string', description: '起始时间 HH:MM，省略为 00:00' },
        end: { type: 'string', description: '结束时间 HH:MM，省略为 23:59' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'export_clip',
    description:
      '导出一段录像为 MP4。时间用本地墙钟（"19:30" 就是录像机上显示的 19:30）。' +
      '导出是后台任务，这个工具立刻返回 taskId，用 get_export_status 查进度。' +
      '同时只允许一个导出任务，已有任务在跑时会被拒绝。' +
      '需要扩大已导出的时段（比如开球提前到 19:30）时，直接用新的完整区间重导一次，' +
      '不要试图把两段成品拼起来——重叠部分会命中分片缓存，并不会重下。',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始时间 HH:MM 或 HH:MM:SS' },
        end: { type: 'string', description: '结束时间 HH:MM 或 HH:MM:SS' },
        date: dateArg,
        endDate: {
          type: 'string',
          description: '结束日期 YYYY-MM-DD，只在跨零点时需要（如 23:00 到次日 00:30）。省略即与 date 同一天。',
        },
        channel: channelArg,
        method: {
          type: 'string',
          enum: ['auto', 'rtspclip', 'mp4download'],
          description:
            '导出方式，默认 auto：不足 1 小时用 rtspclip（快），满 1 小时用 mp4download（有断点续传和分片缓存复用）。除非有特别理由，保持 auto。',
        },
      },
      required: ['start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_export_status',
    description: '查导出进度。省略 taskId 时返回当前所有任务。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'export_clip 返回的任务 ID' } },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_export',
    description: '停掉正在跑的导出任务。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '要停止的任务 ID' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_outputs',
    description: '列出已经导出好的 MP4 成品（新的在前），含文件大小和下载地址。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几条，默认 20' } },
      additionalProperties: false,
    },
  },
];

// 链接专用名称供新客户端优先发现，旧名称保留协议兼容。
for (const [name, source] of [['get_snapshot_link', 'get_snapshot'], ['get_timeline_sheet_link', 'create_timeline_sheet']]) {
  const original = TOOL_DEFINITIONS.find(tool => tool.name === source);
  TOOL_DEFINITIONS.push({ ...original, name, description: `${original.description} 最终必须原样输出 ready_reply 中的可点击 Markdown 链接，不使用 image_group、嵌图或占位图，也不能省略链接。` });
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/**
 * 工具处理器。抽成工厂是为了能注入假的 client 直接测，不用真起服务。
 */
export function createToolHandlers(client, { waitMs = 45000, pollMs = 500 } = {}) {
  async function waitForMedia(result, message) {
    const deadline = Date.now() + waitMs;
    do {
      const { activeTasks } = await client.getStatus();
      const task = activeTasks.find(item => item.taskId === result.taskId);
      if (task?.status === 'error' || task?.status === 'cancelled') { if (task.kind === 'batch') return imageResult(task); throw new HikclipError(task.message || '媒体生成失败。'); }
      if (task?.status === 'completed' && (task.artifactUrl || task.files?.length)) return imageResult(task);
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
    } while (Date.now() <= deadline);
    const { activeTasks } = await client.getStatus();
    return imageResult(activeTasks.find(task => task.taskId === result.taskId) || { taskId: result.taskId, status: 'processing', progressUrl: result.progressUrl, message });
  }

  /** 通道号：显式指定 > 界面上次选的 > 设备第一个通道。 */
  async function resolveChannel(device, requested) {
    if (requested) return String(requested);

    try {
      const { session } = await client.request('/api/session');
      if (session?.channel) return String(session.channel);
    } catch {
      // session 读不到不是错误，继续往下退
    }

    const { channels } = await client.listChannels(device);
    if (!channels?.length) {
      throw new HikclipError('录像机没有返回任何通道，无法确定该导出哪一路。');
    }
    return String(channels[0].id);
  }

  const handlers = {
    async get_match_videos(args) {
      wallRange(args.start, args.end);
      const result = await client.startCameraJob('match', { cameras: args.cameras, start: args.start, end: args.end, matchup: args.matchup, mode: args.mode ?? 'copy', dvrMethod: args.dvrMethod });
      return waitForMedia(result, '正在导出指定镜头，结果页面自动更新。');
    },
    async rename_match_video(args) {
      const { cameras } = await client.listCameras();
      const camera = cameras.find(c => c.id === args.camera || c.name === args.camera);
      if (!camera) throw new HikclipError('摄像头不存在。');
      const newName = matchFilename(args.matchup, camera.id, args.date);
      return JSON.stringify(await client.request(`/api/outputs/${encodeURIComponent(args.filename)}`, { method: 'PUT', body: { newName } }));
    },
    async prepare_bilibili_upload(args) {
      return JSON.stringify(await client.request('/api/bilibili/prepare', { method: 'POST', body: {
        ...args, title: args.title ?? args.filename.replace(/\.mp4$/i, ''), tid: 249, tags: ['足球'], onlySelf: true,
      } }));
    },
    async submit_bilibili_upload(args) {
      return JSON.stringify(await client.request('/api/bilibili/submit', { method: 'POST', body: args }));
    },
    async get_bilibili_upload_status(args) {
      const endpoint = `/api/bilibili/status/${encodeURIComponent(args.id)}`;
      let result = await client.request(endpoint);
      const deadline = Date.now() + waitMs;
      while ((['queued', 'uploading'].includes(result.job?.status) || result.job?.collectionStatus === 'pending') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        result = await client.request(endpoint);
      }
      return JSON.stringify(result);
    },
    async list_cameras() {
      const { cameras } = await client.listCameras();
      return JSON.stringify({ cameras: cameras.map(({ id, name }) => ({ id, name })) });
    },
    async get_snapshot(args) {
      wallTime(args.datetime);
      const result = await client.startCameraJob('snapshot', { camera: args.camera, datetime: args.datetime });
      return waitForMedia(result, '截图正在生成…');
    },
    async get_video_clip(args) {
      wallRange(args.start, args.end);
      const result = await client.startCameraJob('clip', { camera: args.camera, start: args.start, end: args.end,
        ...(args.matchup !== undefined ? { matchup: args.matchup } : {}), ...(args.mode ? { mode: args.mode } : {}) });
      return waitForMedia(result, '录像正在生成…');
    },
    async create_timeline_sheet(args) {
      wallTime(`${args.date} ${args.start}`);
      const interval = args.interval ?? 60, count = args.count ?? 36;
      if (!Number.isInteger(interval) || interval < 1 || interval > 3600 || !Number.isInteger(count) || count < 1 || count > 36) {
        throw new HikclipError('interval 必须为 1–3600 秒，count 必须为 1–36。');
      }
      const result = await client.startCameraJob('timeline', { camera: args.camera, date: args.date, start: args.start, interval, count });
      return waitForMedia(result, '时间轴拼图正在生成…');
    },
    async list_channels() {
      const device = await client.getActiveDevice();
      const { channels } = await client.listChannels(device);

      if (!channels?.length) return '录像机没有返回任何通道。';

      const lines = channels.map((ch) => `  ${ch.id}  ${ch.name}  ${ch.resolution}`);
      // 设备名和 IP 可以说，密码不行
      return `设备「${device.name}」(${device.ip}) 共 ${channels.length} 个通道：\n${lines.join('\n')}`;
    },

    async list_recordings(args) {
      const device = await client.getActiveDevice();
      const date = args.date || localDateStr();
      const channel = await resolveChannel(device, args.channel);

      const startTime = toCompact(date, args.start || '00:00');
      const endTime = toCompact(date, args.end || '23:59');

      const { recordings, totalSize, fileCount } = await client.listRecordings(device, {
        channel, startTime, endTime,
      });

      if (!fileCount) {
        return `${date} 通道 ${channel} 在 ${args.start || '00:00'}–${args.end || '23:59'} 之间没有录像。`;
      }

      const lines = recordings.map(
        (r) => `  ${r.startTime} → ${r.endTime}  ${formatSize(r.size)}`
      );
      return [
        `${date} 通道 ${channel} 共 ${fileCount} 个录像片段，合计 ${formatSize(totalSize)}：`,
        ...lines,
      ].join('\n');
    },

    async export_clip(args) {
      const device = await client.getActiveDevice();
      const date = args.date || localDateStr();
      const endDate = args.endDate || date;
      const channel = await resolveChannel(device, args.channel);

      const startTime = toCompact(date, args.start);
      const endTime = toCompact(endDate, args.end);

      const seconds = durationSeconds(startTime, endTime);
      if (seconds <= 0) {
        const hint = endDate === date
          ? '如果本意是跨零点（比如 23:00 到次日 00:30），请把 endDate 设成第二天。'
          : '';
        throw new HikclipError(`结束时间必须晚于开始时间：${args.start} → ${args.end}。${hint}`);
      }

      const { method, reason, auto } = resolveExportMethod(args.method, seconds);

      // 先确认这段真有录像。搜索本身失败（老固件、track 不存在等）不当拦截理由，
      // 只是把情况说出来，让导出照常尝试。
      let coverage = '';
      try {
        const found = await client.listRecordings(device, { channel, startTime, endTime });
        if (!found.fileCount) {
          throw new HikclipError(
            `${date} 通道 ${channel} 的 ${args.start}–${args.end} 没有录像，没什么可导的。` +
            `可以先用 list_recordings 看看这天实际录到了哪些时段。`
          );
        }
        coverage = `\n这段范围内有 ${found.fileCount} 个录像片段（约 ${formatSize(found.totalSize)} 原始数据）。`;
      } catch (err) {
        if (err instanceof HikclipError && err.message.includes('没有录像')) throw err;
        coverage = `\n（录像检索没成功：${err.message}；仍然继续尝试导出。）`;
      }

      const result = await client.startExport(device, { channel, startTime, endTime, method });
      if (result.reused) {
        const { activeTasks } = await client.getStatus();
        const task = activeTasks.find(item => item.taskId === result.taskId);
        if (task) return imageResult(task);
        return `已复用完整成品：${result.filename}。用 get_export_status 查询任务 ${result.taskId} 获取下载链接。`;
      }

      return [
        `已开始导出：通道 ${channel}，${compactToDisplay(startTime)} → ${compactToDisplay(endTime)}`,
        `时长 ${formatDuration(seconds)}，导出方式 ${method}（${auto ? reason : '调用方指定'}）。`,
        `任务 ID：${result.taskId}`,
        `预计输出文件：${result.filename}`,
        coverage,
        `\n用 get_export_status 查进度。`,
      ].join('\n');
    },

    async get_export_status(args, context) {
      let { activeTasks } = await client.getStatus();
      // 为媒体任务提供有界等待，让模型通过少数连续调用完成交付，而不是空轮询。
      const deadline = Date.now() + waitMs;
      if (args.taskId) {
        while (Date.now() < deadline) {
          const task = activeTasks.find((item) => item.taskId === args.taskId);
          if (!task?.cameraJob || ['completed', 'error', 'cancelled'].includes(task.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          ({ activeTasks } = await client.getStatus());
        }
      }

      let tasks = args.taskId
        ? activeTasks.filter((t) => t.taskId === args.taskId)
        : activeTasks;

      if (!tasks.length && args.taskId && client.request) {
        try { const { task } = await client.request(`/api/media-jobs/${encodeURIComponent(args.taskId)}`); if (task) return imageResult(task); } catch { /* 兼容历史任务与旧服务。 */ }
      }
      if (!tasks.length) {
        return args.taskId
          ? `没有这个任务：${args.taskId}。任务完成 5 分钟后会从列表里清掉，可以用 list_outputs 看成品。`
          : '当前没有导出任务。';
      }

      const baseUrl = tasks.some((t) => t.artifactUrl) ? (context?.publicBaseUrl || await client.resolveBaseUrl()) : '';
      if (tasks.length === 1 && (tasks[0].cameraJob || tasks[0].kind === 'batch' || /\/artifacts\//.test(tasks[0].artifactUrl || ''))) {
        return imageResult(tasks[0]);
      }
      return tasks
        .map((t) => `任务 ${t.taskId}\n  状态 ${t.status}  进度 ${t.progress ?? 0}%\n  ${t.message || ''}` +
          (t.artifactUrl ? `\n  来源 ${t.source}，策略 ${t.strategy}\n  ${/^https?:\/\//.test(t.artifactUrl) ? t.artifactUrl : baseUrl + t.artifactUrl}` : ''))
        .join('\n\n');
    },

    async cancel_export(args) {
      if (!args.taskId) throw new HikclipError('要停哪个任务？请给出 taskId。');
      await client.stopExport(args.taskId);
      return `已停止任务 ${args.taskId}。`;
    },

    async list_outputs(args, context) {
      const limit = Number.isFinite(args.limit) ? args.limit : 20;
      const { files } = await client.listOutputs(limit);

      if (!files?.length) return '还没有导出过任何文件。';

      // HTTP 传输带来本次请求的对外地址：端点跑在服务进程里，客户端 baseUrl 是
      // 127.0.0.1，直接拿它拼下载链接的话，远程调用方收到的是指向它自己机器的地址。
      // stdio 没有这个问题——那时 baseUrl 本来就是调用方用来连服务的地址。
      const baseUrl = context?.publicBaseUrl || await client.resolveBaseUrl();
      const lines = files.map((f) => {
        // /api/outputs 给的是 ISO，直接展示即可
        const range = f.startTime && f.endTime ? `${f.startTime} → ${f.endTime}` : '时间范围未知';
        return `  ${f.filename}\n    ${range}  ${formatSize(f.size)}\n    ${/^https?:\/\//.test(f.url) ? f.url : baseUrl + f.url}`;
      });
      return `共 ${files.length} 个成品（新的在前）：\n${lines.join('\n')}`;
    },
  };

  handlers.get_snapshot_link = handlers.get_snapshot;
  handlers.get_timeline_sheet_link = handlers.create_timeline_sheet;
  return handlers;
}

/**
 * 工具面接上协议分发。stdio 和 HTTP 两种传输共用这一个，
 * 保证两条路的行为完全一致（传输只负责收发字节）。
 */
export function createHikclipDispatcher(client, { log = logToStderr, oauth = false } = {}) {
  const handlers = createToolHandlers(client);

  return createMcpDispatcher({
    serverInfo: SERVER_INFO,
    instructions: '截图优先使用get_snapshot_link，缩略图优先使用get_timeline_sheet_link。镜头严格按用户指定，单镜头不要扩成双镜头。全场用get_match_videos，按对阵、镜头、日期命名。没有明确上传B站的要求只导出不投稿；上传参数固定足球分区249、足球标签、足球合集、仅自己可见、项目默认封面，不再追问。投稿成功后核对 collectionStatus，合集加入失败不能说已加入，也不能重新上传视频。结果必须原样输出 structuredContent.ready_reply 的 Markdown 链接，不能省略链接，不能使用image_group、嵌图、图片搜索、生成图片或占位图。没有读取真实文件不得描述内容。next_action 存在时在当前轮自动继续查询到完成，不问用户要不要查，不承诺稍后主动发。达到客户端调用限制时提供真实自动结果页链接，页面自动展示所有最终文件，用户无需再次发消息。',

    resources: [{ uri: MEDIA_WIDGET_URI, name: '摄像头媒体播放器', mimeType: 'text/html;profile=mcp-app' }],
    readResource: (_uri, context) => mediaWidgetResource(process.env.HIKCLIP_PUBLIC_BASE_URL || context?.publicBaseUrl),
    tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool,
      annotations: { readOnlyHint: !['get_snapshot', 'get_snapshot_link', 'get_video_clip', 'get_match_videos', 'create_timeline_sheet', 'get_timeline_sheet_link', 'export_clip', 'cancel_export', 'rename_match_video', 'prepare_bilibili_upload', 'submit_bilibili_upload'].includes(tool.name),
        destructiveHint: false, openWorldHint: tool.name === 'submit_bilibili_upload' },
      ...(['get_video_clip', 'get_match_videos', 'get_export_status'].includes(tool.name) ? { _meta: {
        ui: { resourceUri: MEDIA_WIDGET_URI, visibility: ['model', 'app'] }, 'openai/outputTemplate': MEDIA_WIDGET_URI,
        'openai/widgetAccessible': true,
      } } : {}),
      ...(oauth ? { securitySchemes: [{ type: 'oauth2', scopes: ['camera'] }] } : {}),
    })),
    log,
    callTool: (name, args, context) => handlers[name](args || {}, context),
  });
}

/**
 * 起一个 stdio MCP 服务。stdin 关闭时 resolve。
 */
export async function runMcpServer({ client = createHikclipClient(), input, output } = {}) {
  redirectConsoleToStderr();

  const dispatcher = createHikclipDispatcher(client);

  logToStderr('stdio MCP server ready');
  await serveStdio(dispatcher, { input, output });
}

