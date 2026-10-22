# Developer Reference

本文件保存**按需读取**的实现背景、模块边界、真机实测结论和 Known Tech Debt。根级入口规则见 [`../AGENTS.md`](../AGENTS.md)。

> 本页中的 Known Tech Debt 只用于理解现状和避免重复踩坑。除非用户任务明确要求，或它是当前问题的直接根因，否则不要顺手施工。

## 架构总览

项目是 **Express 后端 + 模块化 `lib/` + 原生单页前端**：

- `server.js`：HTTP API、SSE、任务状态、导出编排、Web 静态托管、MCP HTTP 挂载、scheduler 启动。
- `lib/`：设备存储、RTSP、ISAPI、下载/裁剪/拼接、MCP、scheduler、后台服务等核心模块。
- `public/`：无构建步骤的 ES Module 控制台前端；`console.js` 负责状态和交互，`precision-timeline.js` 负责时间轴手势，`ui-primitives.js` 提供共享控件与图标。
- `data/`：运行时配置与状态。设备为 `devices.json`，UI 会话为 session store，计划为 `schedules.json`；后台服务还会使用 `data/service/`。
- `downloads/`：成品 MP4 与 `.hikraw` 等缓存/中间文件。
- `scripts/`：便携包、SEA、后台服务 CLI 与 node 二进制下载。
- `test/`：`node --test` 测试。

首次运行 `node server.js` 后，`30001`（被占用时自动顺延）只提供 API 和静态模块，根路径 `/` 返回 404。网页控制台需要配置并访问独立的 `30002` 受保护网关。

## 设备、会话与凭据

设备凭据已经从浏览器 `localStorage` 迁移到服务端 JSON。`lib/device-store.js` 是唯一读写入口，写文件采用临时文件 + rename 的原子替换。

当前设备 API 包括：

- `GET /api/devices`：设备列表 + `activeDeviceId`。
- `GET /api/devices/active`：当前完整设备信息。
- `POST /api/devices`、`PUT /api/devices/:id`、`DELETE /api/devices/:id`。
- `PUT /api/devices/:id/activate`：切换当前设备。

这是“记住凭据”，**不是**鉴权层。现有操作接口仍直接接收 `ip/user/pass`，前端会从当前设备信息取出后传给后端。彻底改成前端只传设备 `id` 属于独立安全重构。

UI 的日期、通道、出入点和导出方式等状态由 session store 持久化，使不同浏览器访问同一个服务实例时共享最近选择。

## 导出路径

### `rtspclip`：默认快速导出

核心是 `lib/rtsp-client.js` + `lib/rtsp-clip-export.js`。自研 RTSP 客户端发送 live555 扩展头 `Rate-Control: no`，让兼容的 NVR 尽可能全速发送回放流；ffmpeg 本身无法方便地发这个头，因此这里没有直接用 ffmpeg 充当 RTSP 控制客户端。

`rtsp-clip-export.js` 会把区间分段并发拉取 H.264/AAC，再对相邻段做重叠消除：优先用字节内容指纹匹配；视频必要时可回退到 RTP 时间戳估算，音频按 RTP 时间戳计算后仍做内容复核。找不到重叠时保留原段，视为可能存在真实录像缺口。

当前录像流的 PTS/RTP 时间信息不能直接相信，导出链中会基于实际帧率重新生成可用时间戳。

### `mp4download`：完整文件下载

核心流水线：

1. `recording-search.js` 通过 ISAPI 搜索录像文件和 `playbackURI`。
2. `file-downloader.js` 下载 `.hikraw`，使用 `.done` 完成标记，支持复用、大小校验和重试。
3. `mp4-file-trimmer.js` 用 ffprobe 探测并裁首尾。
4. `mp4-file-concatenator.js` 使用 ffmpeg concat demuxer 合并，`-c copy -movflags +faststart`。
5. `mp4-download-pipeline.js` 负责阶段编排和进度。

MP4 下载管线通过任务状态透传搜索、缓存复用、下载、裁剪、分片封装、拼接和最终保存阶段。仅在有证据时显示阶段百分比（例如已完成的文件数量），不再把估算下载大小或固定阶段权重当作整体完成率。拼接显示 ffmpeg 实际处理的录像秒数；faststart 和最终文件保存使用不定进度并保留最后更新时间。只有成品发布和清理完成后任务才进入终态。

DVR 成品发布使用异步文件复制，避免数 GB 文件阻塞 HTTP/SSE 与 服务健康检查。支持 reflink 的文件系统优先写时复制，不支持时回退普通异步复制；取消仍等待复制结算。成片库只在存在明确复制来源关联、且双方文件身份仍匹配时隐藏内部 native MP4，原下载 ID 保留。旧任务无可靠关联时不会根据同大小、同时间猜测去重，也不会自动删除历史文件。

`.hikraw` 缓存是该路径的重要能力：如果以后扩大时间范围，重叠录像文件可以直接复用，因此扩展时段应重新提交完整目标区间，而不是拼两个成品 MP4。

### `auto` 选择

`lib/export-method.js` 根据时长选择：短于 1 小时用 `rtspclip`，达到或超过 1 小时用 `mp4download`。这是 MCP 与 scheduler 等自动调用方的策略；HTTP `/api/export` 的缺省仍保持 `rtspclip`，避免改变既有 Web 行为。

## 单飞守卫与任务状态

所有正常导出应进入 `startExportTask()`。它负责参数校验、方法选择、`activeTasks` 注册和单飞守卫。

NVR 回放会话池有限且回收慢；导出通过同一条进程内 FIFO 队列串行执行。已有任务运行时，新请求返回自己的 `taskId`、`status: queued` 和从 1 开始的 `queuePosition`，不再因忙碌返回 409。重复提交仍在运行或排队的同一请求会复用任务编号。排队任务没有执行进度；只有当前任务的执行与清理 Promise 全部结束后，下一项才启动。取消排队项仅移除该项；取消执行项会先等待拉流、进程与临时素材清理结束。

新任务的请求、原来源、队列顺序与发布检查点会原子持久化，凭据不写入恢复记录。服务重启后在独占进程锁保护下自动继续排队/执行中的任务；已完成、失败和取消任务不重放。旧记录缺少恢复请求或原设备不可用时明确提示错误，不自动改用当前设备。上传恢复另由主机 worker 负责：只有能证明尚未提交或已核实结果的任务才安全继续，结果不明保持待确认。详见 [恢复说明](camera-mcp.md#重启后的任务恢复)。

公网控制台按来源选择通道：MediaMTX 使用 D1/D2 等别名，缺口预检返回确切区间；用户可明确 acceptGaps 跳过缺口，或另行选择 DVR，不自动回退。完全没有可用素材仍拒绝导出。海康 DVR 使用录像机 ID 与实际 101/201 通道，不依赖 MediaMTX 别名，也不会被本地档案误选源。

终态任务会在 `activeTasks` 中短暂保留，供刷新后的页面读取结果，所以判定是否有任务运行不能用“Map 非空”，必须使用 `task-registry.js` 的实际状态判断。

进行中的导出可能已经在 `downloads/` 里创建最终 `.mp4` 路径；`/api/outputs` 会标记 `inProgress`，删除和重命名接口会对这些文件返回 409，避免破坏正在写入的 inode。

## 预览与 RTSP 真机结论

当前真机验证主要基于 DS-7808N-Q1 V4.82.100。换设备/固件时以下结论需要重新验证，不能当成海康全系列协议保证。

- `Rate-Control: no` 能显著提升回放发送速度；默认回放接近 1X，空闲时全速可明显更快。
- 回放会话池小、回收分钟级；导出和预览结束时必须尽力 `TEARDOWN`。
- 预览和导出会争用带宽/会话，导出跑满时预览可能严重掉速，因此全局只保留一路预览，启动导出会先停预览。
- 回放 seek 能到秒级，但实际数据按 GOP 对齐，边界可能前后多出少量内容。
- 当前录像主码流无 B 帧，H.264 裸流在 NAL 边界处理；实际设备切换编码参数后仍要重新验证。
- 当前设备没有录子码流：录像 track 是 `101`/`201` 等主码流，`102`/`202` 不存在；对不存在的录像 track 搜索时可能返回 `badXmlContent`，不能简单解释成“当天无录像”。

### 真实帧率来源

当前设备真实录像帧率以 `GET /ISAPI/ContentMgmt/record/tracks` 的 Track `Description` 为权威来源，例如其中会出现 `framerate=25.0 fps`。

`Streaming/channels` 的 `maxFrameRate` 在“全帧率”配置下可能返回 0；不同 ffprobe 版本从 SPS 推出来的值也出现过不一致。因此预览/导出不要因为局部重构回到单一 `maxFrameRate` 或 ffprobe 值。

现有实现由 `record-tracks.js` 优先读取录像 track，`stream-params.js` 只作为回落。

## 预览 ffmpeg 行为

`/api/preview-stream` 使用 `rtsp-client.js` 拉普通 1X 回放，再交给 ffmpeg 转 MJPEG 并以 `multipart/x-mixed-replace` 给 `<img>`。

几个参数是实测留下的：

- `-re`：让 ffmpeg 按源帧率消费，抑制 NVR 突发数据导致的前端忽快忽慢。
- `rtsp-client.js` 会为 ffmpeg 背压暂停 socket，因此 idle timeout 要允许较长暂停，不能把正常背压误判为断流。
- 预览缩放上限和 JPEG 质量是局域网画质/带宽折中；如果做公网访问，应重新评估，而不是沿用局域网参数。

## ISAPI / RTSP 输入安全

ISAPI 请求通过系统 `curl` + HTTP Digest Auth，使用 `execFile` 和参数数组，不经过 shell。

`rtsp-client.js` 手写 RTSP 文本并直接写 TCP socket，因此进入 RTSP URI/头部的动态值必须严格限制。`server.js` 当前对 `channel` 使用纯数字格式校验，对 compact 时间使用 `YYYYMMDDTHHmmssZ` 校验；这不仅是参数合法性，也是在防止 CR/LF 等协议注入。

## 海康时间语义

海康接口使用类似 `20231012T080000Z` 的 compact 格式。项目历史实现把设备返回和用户输入当**本地墙钟**处理；这里的 `Z` 不能简单理解成“已经是 UTC 后再做时区换算”。

`lib/hik-time.js` 是时间转换的统一实现。修改“结束时间不能晚于当前时间”、scheduler 时段、文件边界判断等逻辑前先确认墙钟语义。

源码进程的 `TZ` 必须与NVR系统时区一致，否则时间校验、录制分片与scheduler时间都会偏移；按自己的录像机配置时区。

## MCP

有两种传输，但工具面共用同一 dispatcher：

- stdio：`node server.js mcp`。
- HTTP：常驻服务挂载 `POST /mcp`。

MCP 的原则是“**常驻 HTTP 服务的客户端**”，不是第二套业务后端。实际动作通过 `hikclip-client.js` 调用 `/api/*`，从而复用同一份 `activeTasks`、单飞守卫和服务状态。

stdio 的 stdout 被 JSON-RPC 独占；MCP 模式下启动日志需要静音或重定向 stderr。

HTTP MCP 为无状态 Streamable HTTP 适配器，带 Origin 检查以降低浏览器来源和 DNS rebinding 风险。它不会因此给整个 Web 服务增加鉴权；可信局域网的总体部署假设不变。

MCP 返回中不应包含设备密码。远程调用方需要下载地址时，HTTP 传输会结合当前请求的对外地址生成 URL，避免返回错误的 `127.0.0.1` 链接。

更多工具定义和接入说明见 [`mcp.md`](mcp.md)。

## Scheduler 与保留策略

scheduler 跑在**常驻服务进程**，不依赖 MCP 客户端在线。它定期重读 `data/schedules.json`，所以 Web UI 修改计划后不用重启。

当前 Web API：

- `GET /api/schedules`：读取计划与 `lastRun`。
- `PUT /api/schedules/:id`：更新 enabled、时段、`runAt`、channel、method、retentionDays 等，并做格式/跨字段校验。

触发时 scheduler 调用 `startExportTask()`；启动后记录 `lastRun.status = started`，导出终态由 `server.js` 的 progress hook 按 `taskId` 回写为 `completed` 或 `failed`。服务启动时还会把上次进程遗留的 `started` 恢复为失败，避免 UI 永久显示“进行中”。

保留策略在定时任务前清理旧缓存/成品及中断遗留的 `.h264`/`.hevc`/`.aac` 等文件。默认计划的保留天数以当前 schedule 配置为准，不要在别处复制一份独立常量。

## 后台服务

`<入口> service <命令>` 与普通 HTTP、`mcp` 是并列 CLI 入口。源码可以用 `scripts/service.js`，便携包/SEA 仍通过同一套 service manager。

核心模块：

- `service-manager.js`：解析命令、选择平台后端、统一 status/logs。
- `service-utils.js`：进程调用、环境、日志和运行时上下文。
- `service-launchd.js` / `service-systemd.js` / `service-windows.js`：平台后端。
- `runtime-file.js`：记录 `{ pid, port, startedAt }`；端口会自动顺延，后台服务需要它知道真实地址/进程。

服务定义会固化安装时的 Node 路径、PATH、数据目录等，移动项目或更换 Node 后通常需要重新 install。详细操作见 [`background-service.md`](background-service.md)。

## SEA / 便携包

便携包/SEA 以 `server.js` 为入口。SEA blob 与平台基本解耦，交叉构建时平台相关的是 Node 二进制外壳；跨平台构建还受 V8 code cache 和 Node 版本匹配约束。

历史本机构建方式、签名和 Windows 注意事项见 [`cross-build.md`](cross-build.md) 与 [`build-windows-exe.md`](build-windows-exe.md)。

便携包/SEA 不应假设一定携带 ffmpeg。运行时解析顺序是系统 PATH → 可选 `ffmpeg-static` / `ffprobe-static` → 裸命令名兜底，最终目标环境必须真正可执行。

## 依赖

运行时主要依赖：

- `express`：Web 服务。
- `xml2js`：ISAPI XML。
- `cors`：局域网前端访问。
- `ffmpeg-static` / `ffprobe-static`：可选兜底。

开发/构建包括 `esbuild`、`fast-check`；项目使用 ESM。

## 部署安全假设

当前服务监听 `0.0.0.0` 且无统一鉴权。`/api/devices` 能返回完整设备凭据，前端会再把这些凭据传到操作接口；`/downloads` 则只静态托管 `.mp4`，不托管 `.hikraw`。

因此它适合可信局域网或由外层网络控制保护的环境。要放到公网/不可信网络时，需要独立设计认证、授权、凭据只留服务端和下载访问控制，不能把现状描述成公网安全。

## Known Tech Debt

以下问题当前存在，但**不自动进入普通任务范围**：

1. **设备凭据仍经客户端往返。** `/api/devices` 返回密码，前端再传 `ip/user/pass`；彻底修复需要服务端以 device id 解析凭据，是独立安全重构。
2. **旧设备 JSON 可能残留已废弃字段。** 早期 `port/httpPort` 已不再参与运行；老数据中残留字段会被忽略。除非做 schema 清理，不需要普通任务顺手迁移。
3. **本源码分发没有自动发布流水线。** 如将来需要二进制分发，应另行审阅目标平台、依赖许可、产物与权限，不能将历史构建入口视为已验证发版。
4. **Windows 后台服务缺少充分真机覆盖。** Windows 计划任务/VBS 路径有测试，但平台级 install/start/stop/uninstall 仍应在真实 Windows 环境验收后再宣称完全闭环。
5. **中断产生的裸流文件不是立即清理。** retention 会最终处理 `.h264`/`.hevc`/`.aac` 等残留，但崩溃后到保留期清理前仍可能占用较大磁盘；如果磁盘压力成为现实问题，可单独增加安全的启动清理策略。

已不再属于技术债的旧描述不要重新写回：当前 Web 已有 `/api/schedules` GET/PUT，scheduler 的 `lastRun` 也会在终态回写并在启动时恢复中断状态。

