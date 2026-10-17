## 指定镜头的全场工作流（当前）

用户说 D2 只处理 D2；说 D1 和 D2 才处理两个镜头。`get_match_videos` 接收 cameras 数组、已确认的完整起止日期时间和 matchup；一个任务串行完成全部镜头，MediaMTX 完整覆盖的优先 copy，缺少覆盖的回退 DVR。先交付本地镜头，最终每个镜头保留一个 `对阵 镜头 日期.mp4`，同名不覆盖。同一请求正在运行时返回原任务进度；镜头、起止时间、模式和文件大小均匹配的已完成文件直接复用，缺失的镜头才重新导出。同名但区间或模式不同则拒绝覆盖。只有所有指定镜头完成才报告全部成片就绪。

旧会话如果逐个调用 `get_video_clip` 且未带对阵名，服务也会按镜头、起止时间、模式查找已落盘的全场成品并直接返回原文件。仍在生成的文件不能当作成品复用。上传 B 站的能力由本 MCP 的 `prepare_bilibili_upload`、`submit_bilibili_upload` 和 `get_bilibili_upload_status` 提供，无需另找哔哩哔哩插件；客户端需加载当前 MCP 工具列表。

一次工具调用等待最多 45 秒；未完成时返回明确的 next_action，模型应在当前轮继续查询，不要求用户再发消息。所有任务另有 24 小时签名的自动结果页，打开后每三秒查询进度、展示处理阶段、镜头进度条和已完成文件；任务完成五分钟从内存列表清除后，持久化结果仍可查询。服务重启导致的中断明确报错，不谎称已经完成。MCP 不能控制 ChatGPT 结束后的主动聊天消息，结果页负责持续交付。

公网域名根路径提供短密码保护的录像控制台，支持回放、成片、上传任务、密码与存储设置；首次设置流程和服务器端 189 worker 见本文后续章节。

缩略图用 `get_timeline_sheet_link`，截图用 `get_snapshot_link`，模型必须原样输出 ready_reply 的链接；不嵌图、不搜索替代、不省略链接。旧名称只用于兼容。更新后 ChatGPT 需要刷新工具；长期对话里的旧图片展示指令可能仍在上下文中，建议新会话加载当前版本。

投稿只有用户明确说上传 B 站时才执行。固定足球分区 249（运动主分区 234 下）、足球标签、足球合集、仅自己可见；标题默认沿用文件名去掉 .mp4。不需要用户反复提供固定参数。固定封面使用服务器已有的 `/opt/biliup/assets/bilibili_default_cover.png`；可通过 worker 私有环境的 `BILIUP_COVER_FILE` 覆盖。

## 图片交付规则

截图和缩略图仅返回完整签名原文件链接，不嵌图片、不附图库或占位图，也不通过图片搜索或生成来替代。未读取真实文件不得描述画面。视频播放器仍保留。

# AI Camera MCP 改造

## 当前进度

Camera Layer、MediaMTX adapter、Video Resolver、四个新 MCP 工具、artifact 交付、Bearer/OAuth 和 源码网关配置已落地。所有媒体操作汇聚到常驻服务的任务状态与单飞守卫。

代码与合成素材验证完成，不代表已部署到实际服务器，也不代表已通过真实 NVR、远端 MediaMTX 或 ChatGPT 账号验收。

## 自动发现通道与可选别名

MediaMTX 通道不需要先创建映射：服务从 `HIKVISION_ARCHIVE_DIR` 的单层录像目录，以及 MediaMTX Control API 的 `/v3/paths/list`（直播路径）与 `/v3/recordings/list`（录像路径）自动读取通道。登录控制台、打开回放选择或重新读取设置时刷新；DVR 在选择录像机后自动读取其通道，保留每台录像机各自的选择，并合并重复请求。

Control API 用独立的 `HIKVISION_MEDIAMTX_API_URL` 指定 HTTP(S) 根地址，未设置时默认 `http://127.0.0.1:9997`；显式设置为空字符串会禁用 API 发现，只使用本地目录。测试实例应显式禁用或使用自己的模拟 API，不能继承宿主机来源。它与 Playback URL 独立，不根据远端 Playback 地址猜测端口。MediaMTX 的 Control API 必须由管理员启用并只向应用所在的可信网络开放；源码进程必须能访问配置的服务地址。API 暂不可用时仍扫描本地录像目录，并保留同一来源上次成功发现的通道；更换来源配置不会沿用旧来源的列表。

发现过程仅做有界只读查询，不创建 `cameras.json`、不访问 DVR、不启动录像。当前路径仅支持 1–64 个英文字母、数字、短横线或下划线的单层名称。设置中点击通道可选填显示名称或关联 DVR；「手动补充」仅供自动发现不到的路径。已有保存映射优先，同一 `archivePath` 不会重复列出；旧稳定 ID、来源指纹及成品缓存保持原规则。

没有 DVR 绑定的通道只能使用 MediaMTX，录像缺口不会自动转到任意录像机。明确选择 DVR 时必须选择已配置的录像机和通道。

## 配置摄像头别名

优先在已登录的公网控制台「设置」中添加 DVR、配置摄像头映射及 MediaMTX Playback 地址。设备凭据仍只保存于 `devices.json`，不返回浏览器。也可在服务器人工维护同一数据目录的 `cameras.json`；`HIKVISION_DATA_DIR` 可覆盖该目录，SEA 模式与设备存储一样使用 exe 旁的 `data/`。

```json
{
  "cameras": [
    { "id": "door", "name": "门口", "deviceId": "替换为第一台DVR的实际ID", "channel": "101" },
    { "id": "yard", "name": "院子", "deviceId": "替换为第一台DVR的实际ID", "channel": "201" },
    { "id": "garage", "name": "车库", "deviceId": "替换为第二台DVR的实际ID", "channel": "101" }
  ]
}
```

`deviceId` 是现有设备条目的实际 ID，不是 IP 或显示名称。由管理员在服务端查看 `devices.json` 的 `id` 字段取得；该文件也含密码，避免把整个文件贴进聊天或日志。示例名称仅为配置示范，部署时应核对各通道的真实画面再命名。

- `id` 允许 1–64 个英文字母、数字、下划线或短横线。
- `name` 使用非空名称，名称与 ID 都必须唯一，且不能与其他摄像头的 ID/名称交叉冲突。
- `channel` 使用 1–8 位数字；主码流和备用流可分别配置别名。
- 配置允许 `id`、`name`、`deviceId`、`channel` 与 `archivePath`，不能复制密码、用户名或 IP。`deviceId` 与 `channel` 必须同时填写或同时省略；仅 MediaMTX 通道需提供 `archivePath`。
- 每次查询重新读文件，修改无需重启；缺少文件返回空目录，损坏配置明确报错。
- 删除 DVR 不自动删摄像头别名；解析时报告关联设备不存在，由管理员修复映射。

## 内部模块接口

`lib/camera-store.js` 提供：

- `listCameras()`：只返回 `{ id, name }`，用于后续 MCP 摄像头目录。
- `getCamera(idOrName)`：内部查询保存映射与自动发现目录，未找到返回 `null`。
- `resolveCamera(idOrName)`：内部返回 `{ camera, device }`；仅 MediaMTX 通道的 `device` 为 `null`，已绑定 DVR 的 `device` 包含导出需要的凭据。此结果不能直接返回模型。
- `saveCameras(cameras)`：验证格式、唯一性和可选设备引用后，以临时文件 + rename 原子替换保存的映射；自动发现目录不写入文件。

该层不更改 Web 的激活设备，不访问录像机、不创建导出任务。后续导出仍须汇聚到常驻服务的统一任务守卫。

## MediaMTX 与工具

### MediaMTX 配置与输出

设置 `HIKVISION_ARCHIVE_DIR` 为服务进程可读的录像根目录（例如 `/dvr`）。摄像头条目增加 `"archivePath": "d1"`，映射到根目录下单层目录，不能填写任意绝对路径。远程录像需先以只读挂载方式提供给同一服务；模块不隐式执行 SSH。

文件名格式为 `YYYY-MM-DD_HH-MM-SS-ffffff.mp4`，时间与 NVR 一样按本地墙钟；支持跨日与微秒起点。每个候选分片由 ffprobe 探测实际时长，只有完整覆盖请求区间才能本地裁剪，损坏/未完成分片与真实缺口不会视为覆盖。截图或缩略图的任何采样时刻缺失会报错，不复制别的画面填充。

本地裁剪对各片精确解码后以 H.264/AAC 输出，避免 `-c copy` 的关键帧偏移；速度依赖 CPU。缩略图最多 36 格，6×6 时每格左下角标注目标墙钟时间。服务器安装 drawtext 字体；Windows 默认 Arial，Alpine 默认 `/usr/share/fonts/TTF/DejaVuSans.ttf`，其他环境通过 `HIKVISION_FONT_FILE` 指定 TTF。

生成文件默认存于 `data/artifacts/images/{snapshot,timeline}` 与 `data/artifacts/videos/clips`；可通过 `HIKVISION_ARTIFACT_DIR` 改为单独目录。临时文件在 `.work`，完成后原子发布。`/artifacts` 只放行最终 UUID 文件，不托管配置或临时文件。

### MCP 工具调用

先调用 `list_cameras` 得到名称，再调用以下工具：

```json
{ "camera": "门口", "datetime": "2026-09-24 21:15" }
```

上例用于 `get_snapshot`。`get_video_clip` 使用 `{ "camera": "门口", "start": "2026-09-24 21:15", "end": "2026-09-24 21:16" }`。

`create_timeline_sheet` 使用 `{ "camera": "门口", "date": "2026-09-24", "start": "20:00", "interval": 60, "count": 36 }`，采样从 20:00 到 20:35。

媒体生成可能需要下载或解码，工具立即返回 `taskId`，用 `get_export_status({ "taskId": "…" })` 查询；完成结果包含来源、策略与最终产物 URL。`cancel_export` 可取消，截图、拼图和视频与 Web/scheduler 共用单飞守卫。取消清理结束后才释放媒体任务。

截图和拼图本地覆盖不足时，通过同一个任务调用海康导出，再抽帧；每台 DVR 使用独立缓存目录防止同通道、同时间的设备间缓存混用。旧 `list_channels` 和 `export_clip` 保留兼容行为。

## 公网安全与认证

同一个 Node 进程保留两种入口：

- 主端口 `30001`：可信局域网 Web/API，仍有设备管理等旧功能。
- 配置 `HIKCLIP_PUBLIC_PORT=30002` 后的受限入口：只开放 MCP、OAuth 发现/授权和受授权的媒体下载。源码网关通过 `HIKCLIP_PUBLIC_BIND` 配置监听地址，默认环回；远程反代时显式绑定并用防火墙限制来源。

反向代理只转发受限端口，不能转发主端口。受限入口对 `/api/devices`、Web 页面、原始缓存和临时文件返回 404，即使请求带正确 Token 也不能访问这些路径。现有设备 API 仍使用可信局域网模型。

在同一局域网内使用 Caddy 时，可将 `HIKCLIP_PUBLIC_BASE_URL` 设为 `https://video.example.com/zl-camera`，并将 `HIKCLIP_PUBLIC_BIND` 设为录像服务器的内网地址。把 [Caddy 片段](../deploy/caddy-zl-camera.example.caddy) 导入对应站点块，`handle_path` 会剥离外部前缀后转发到 30002；应用会为页面、API、回放、PWA 和下载链接保留此前缀。不要把 30001 映射到网卡地址。

### Bearer 与 OAuth

`HIKCLIP_MCP_TOKEN_FILE` 指向保存至少 32 字符随机访问密码的文件；也可用 `HIKCLIP_MCP_TOKEN`，优先读文件。配置后所有 HTTP `/mcp` 方法要求认证；stdio 仍通过本地 HTTP API 工作。

普通 MCP 客户端可发送 `Authorization: Bearer <访问密码>`。同时配置 `HIKCLIP_PUBLIC_BASE_URL=https://实际域名` 后，自动提供适合自用的单用户 OAuth：发现元数据、动态客户端注册、浏览器授权、S256 PKCE、一次性授权码、1 小时 access token 和轮换 refresh token。也可以配置简单路径前缀，例如 `https://实际域名/zl-camera`，并让反向代理剥离此前缀再转发到 30002。

路径部署的 OAuth 页面、表单提交地址、发现元数据和资源地址均使用完整公网前缀；反代只剥离一次。以 `https://video.example.com/h1km3sh` 为例，MCP 为 `/h1km3sh/mcp`，授权表单提交到 `/h1km3sh/oauth/authorize`。`WWW-Authenticate` 指向 `/h1km3sh/.well-known/oauth-protected-resource`，该路径通过同一 `handle_path` 到受限入口。

此外，按标准发现的客户端会把 well-known 放在前缀之前，反代须单独提供精确别名：

- `/.well-known/oauth-authorization-server/h1km3sh` → 新实例受限入口的 `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/h1km3sh/mcp` → 新实例受限入口的 `/.well-known/oauth-protected-resource/mcp`

别名要直接重写到对应新实例，不能重定向到旧实例或抢占根 `/.well-known/oauth-authorization-server`、根 `/oauth/*`；同域旧实例的原有发现和授权路由保持不变。其他或多级前缀用其完整路径作同样映射，不能把整个 `/.well-known/*` 通配转发到新实例。

在授权页面输入该访问密码，只交给自己的服务端。页面显示回调来源，核对后同意授权；不要把访问密码填入聊天或工具参数。Token 校验、凭据查询与下载签名均在服务端完成。

自用 OAuth 的客户端及 access/refresh token 保存到服务端 `data/oauth-state.json`（权限 0600，含敏感授权数据，禁止提交或分享），普通服务重启保留授权。一次性授权码仅存内存，有效 60 秒；refresh token 最长 30 天。换域名或访问密码会使原授权失效。旧版本丢失注册后，再次授权会显示密码页面，只有正确密码才能恢复该客户端的一个 HTTPS 回调；恢复后不能更换回调。它不是多用户身份服务。

### 下载链接

媒体产物只在生成成功后发布。配置认证后，完成结果返回绑定具体文件路径、有效期为 24 小时的 HMAC 下载链接；链接不包含主访问密码，修改路径或有效期会失效。链接本身具有下载权限，不要转发给无关人员。再次查询任务状态可以得到新签名，任务状态保留约 5 分钟。

签名链接不等于文件保留策略；新 artifact 与摄像头分设备缓存目录当前由管理员按磁盘情况清理，已有 scheduler 对旧顶层 downloads 的保留行为不变。

### 公网录像控制台

也可在服务器本地的私有环境变量文件中设置 `HIKCLIP_LOGIN_PASSWORD`，使用普通 8–128 位密码即可，无大小写、数字或特殊字符组合要求。非空值在启动时用 PBKDF2 哈希，仅保存在内存，不写入密码状态文件、日志或网页；无需一次性初始化码。无效非空值会阻止启动。修改密码后须重启服务，旧控制台会话失效；密码与 MCP Token 不变时，普通重启或部署会保留未过期登录。环境密码的 PBKDF2 盐由现有高熵 MCP Token 进行带用途标识的 HMAC 派生，不保存额外密钥或明文密码；更换 MCP Token 也会使旧登录失效。此模式下网页改密会明确提示到服务器修改。环境变量优先于已保存密码，留空或移除后恢复原有文件密码/初始化流程（不会删除旧密码）。它只控制控制台登录，不替代或修改 MCP/OAuth 的独立 Token。不要把真实值放入仓库或聊天。

未配置该环境变量时，访问公网域名根路径后，首次用服务器本机生成的一次性初始化码设置短密码。密码哈希保存在被忽略的 `data/public-console-auth.json`，目录权限为服务用户专用；初始化码 30 分钟有效且只能使用一次。运行：

```bash
npm run setup:status-password
```

命令只打印一次初始化码；把它输入网页并设置至少 8 位密码。之后可在“设置”里用当前密码更换；改密会立即让旧会话失效。控制台登录默认保留 30 天，使用 HttpOnly、Secure、SameSite=Strict 的持久 Cookie；以登录时间为起点，到期必须重新输入密码，日常访问不会无限续期。可在服务器使用 `HIKCLIP_STATUS_SESSION_HOURS` 缩短有效期，允许整数 1–720 小时，非法值阻止启动。退出登录会清除当前路径 Cookie，修改密码或 MCP Token 会使旧登录失效。请只在个人可信设备上保持登录。错误密码连续 5 次会暂时锁定 15 分钟。旧部署仍可用 `HIKCLIP_STATUS_PASSWORD_HASH` 初始化，但新密码状态会迁移到 data 文件。

路径部署的控制台会话使用由完整路径前缀确定的独立 Cookie 名称及对应 `Path`，退出只清除该路径的会话；签名也绑定此前缀和配置的会话有效期；缩短有效期不会让旧的长会话在将来重新有效。根部署继续使用原来的 `hikclip_status` 与 `Path=/`。同域并行部署不会覆盖或误读旧根 Cookie；升级已有路径部署时需重新登录一次，不迁移旧的根路径会话。Cookie 路径隔离不能替代独立服务器端数据目录、Token、密码与受限端口。首次升级到此版本的会话签名时需重新登录一次；环境密码之前使用的临时盐也无法恢复。修改会话有效期后亦需重新登录。浏览器清理网站数据、无痕会话关闭或在不同浏览器/独立 Web App 间切换，仍可能需要各自登录，服务器不能恢复已被客户端删除的 Cookie。

控制台包含 MediaMTX 回放、成片播放/改名/删除、B 站与天翼云盘上传、SSE 任务状态和 DVR 缓存清理。手机使用底部导航，桌面使用侧栏；回放时间轴标出录像缺口。播放代理使用 `cameras.json` 的 `archivePath`（未配置时使用摄像头 ID）请求 MediaMTX Playback API；内部 `9996` 不向公网开放。只有明确选中的摄像头参与回放或导出。

公网网关只放行独立 `/console/api/*` 白名单、控制台静态资源和登录接口；设备管理、DVR 密码、原始缓存和其他通用 API 仍被拒绝。修改 Cloudflare Tunnel 配置后，应自行按所用连接器的官方说明验证规则；本源码不自动安装或运行连接器。

### Web 上传设置与登录边界

“设置 → 上传”保留账号连接和封面，移除总开关及平台开关；配置就绪即可提交，但仍只有明确点击上传才会新建任务。天翼云盘目录固定为 `/H1kM3sh`，旧目录不再用于新任务。B 站标题固定沿用文件名（无前缀），标签仅为“足球”，合集及分节使用下方已记录的固定配置，网页无需填写编号。旧设置中的前缀和额外标签不会再用于新任务；旧合集编号统一迁移到已记录的足球配置。每次上传前仍需在线核实合集名称为“足球”、归属当前账号、审核资格和分节关系，不匹配则不上传。设置只影响之后新建的上传任务；已入队任务保留提交时参数。足球分区 249、足球标签、足球合集、仅自己可见继续保持既有策略。固定封面由服务器管理，网页不能提交本地路径、命令、Cookie 或密码。

设置写入要求控制台会话、同源 Origin 和会话 CSRF Token，持久化采用私有临时文件原子替换。旧的仅含天翼目录的设置文件会补齐默认字段。网页能区分 worker 心跳、程序、登录文件和封面是否可用；B 站登录文件存在仅显示“未验证”，不能据此宣称账号有效。升级后 B 站按钮需要新版 worker 提供新鲜心跳；旧 worker 未更新时保持不可用。189 登录状态来自 worker 的 CLI `who` 检查，不代表云端上传必定成功。

本版本不提供网页扫码或密码登录。B 站 CLI 上游提供交互登录，但当前适配器没有版本核验、短时扫码会话、取消/超时和账号有效性验证接口；需由用户在服务器上以 worker 服务账户自行登录。天翼 `cloudpan189-go` 上游已停止维护，其 README 仅确认账号密码 CLI 登录，不能承诺网页扫码。后续接入应单独验证准确版本，凭据只保留在 worker 私有目录，由用户完成扫码/凭据提交，不能把终端原始输出或凭据回传网页。上游参考：[biliup](https://github.com/biliup/biliup-rs)、[cloudpan189-go](https://github.com/tickstep/cloudpan189-go)。

### 天翼云盘上传 worker

控制台可以先保存 189 目标目录；未配置目录、`cloudpan189-go` 或服务器登录态时，上传按钮保持禁用。CLI 安装在主机后，通过同一个服务账户和同一个 `HOME` 完成一次登录，再启用独立 worker。登录凭据只保存在服务器端，不要发到聊天中：

```bash
export HOME=/dvr/data/hikvision-camera-mcp/downloads/cloud189_work/home
/opt/cloud189/cloudpan189-go login
/opt/cloud189/cloudpan189-go who
```

将 `scripts/cloud189-worker.py` 及同目录依赖 `scripts/upload_worker_state.py` 与 `deploy/cloud189-worker.service` 安装到 `/opt/hikvision-camera-mcp/`，核对 service 中的 `HIKVISION_DOWNLOADS_DIR`、`CLOUD189_BINARY`、`HOME` 和 `ReadWritePaths` 与当前主机实际路径，然后运行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloud189-worker
sudo systemctl status cloud189-worker
```

worker 通过 `downloads/cloud189_work/jobs/` 消费队列。CLI 没有可核实的字节进度时，界面只显示“正在上传”，不会伪造百分比；进程异常或重启后会标成“待核实”，不会自动重试，以免重复传文件。云盘目录首次使用前必须在控制台设置中填写。

### 缓存与成片保护

公网和本机 Web 的缓存清理都覆盖 `downloads/` 顶层及受管的 `camera_<哈希>/` 子目录。只删除带 `.done` 标记的完整 `.hikraw`，任何未完成分片都会保留以供断点续传；导出任务运行时拒绝整库清理。成片库允许播放与改名，但文件处于导出、排队上传、上传中或状态待核实时禁止改名/删除；改名不会覆盖同名目标。

## 源码网关与可选 Tunnel

先按 [源码快速开始](oss-quickstart.md) 配置本机来源、独立MCP token、网页登录密码和受保护30002网关。自己的HTTPS反代或Tunnel只连接30002，保持30001环回私有。源码不会创建Tunnel、DNS路由、系统服务或修改权限；这些均由操作人按自己的主机审阅。

## ChatGPT 连接

带认证的 ChatGPT MCP 连接需要 OAuth 发现与授权流程；仅静态 Bearer 不足以替代它，参见 [OpenAI 认证说明](https://developers.openai.com/plugins/build/auth)。本服务提供上述 OAuth 流程，工具声明 `camera` 权限。

端点为 `https://实际域名/mcp`。在支持自定义 MCP 的 ChatGPT 账号/工作区中创建连接，选择 OAuth 并完成本服务的浏览器授权。创建位置与账号可用性以 [OpenAI 连接文档](https://developers.openai.com/plugins/deploy/connect-chatgpt) 和当前界面为准。首次连接、实际工具选择、图片/视频链接展示及重授权还需在真实账号验收。

## 已验证与待验证

- Windows 合成 fMP4：微秒起点、跨日截图/拼图/裁剪；真实 HTTP MCP 的任务、取消与下载。
- Bearer、PKCE、code 重放、refresh 轮换、过期令牌、签名篡改和错误 Origin 有测试覆盖。
- 待实际环境验证：两台 DVR 的通道画面与回放、远端录像挂载、Tunnel 域名与真实 ChatGPT 账号。
# 全场录像与哔哩哔哩工作流

1. 先说“看看 D2 今晚八点起每两分钟的 12 个画面”，生成带时间的缩略图；需要仔细看时，再说“单独看 20:18 的画面”。
2. 确认范围后说“导出 D2 今天 20:20–22:25 的全场，对阵是天行者 vs 九块九”。`get_video_clip` 默认优先 MediaMTX，复制音视频码流，不转码。未完整覆盖时走原有 DVR 下载策略；不会跨缺口伪造完整录像。
3. 自动保存为 `downloads/天行者 vs 九块九 D2 2026-09-27.mp4`。同名拒绝覆盖；`rename_match_video` 可改对阵名称。未提供对阵时按摄像头、时间范围和随机编号保存，也可以后续改名。媒体卡片保留 UUID 地址。
4. copy 模式起止受关键帧限制，可能有几秒误差；精确短片可指定 `mode=precise`，需要转码。
5. 说“把这场上传 B 站”，用 `prepare_bilibili_upload` 准备标题、分区、标签，再以本次明确投稿授权调用 `submit_bilibili_upload`。标题沿用成品名，固定运动/足球（249）、标签足球、足球合集、仅自己可见。`get_bilibili_upload_status` 返回实际状态、BV 号和合集状态。导出不自动投稿。

Token 放在项目 `.secrets/mcp-token`；B 站登录文件可放 `.secrets/biliup-cookies.json`，均已 ignore。截图与短片在 `artifacts/`，中文命名全场在 `downloads/`，两者也已 ignore。生产服务器这两个项目目录指向 NAS，避免录像占满系统盘；全场与媒体卡片使用硬链接，不重复占用同一份视频空间。临时切片工作目录完成后自动清理，最终成品不自动删除。

## 主机 biliup worker

MCP 服务准备文件队列；`scripts/biliup-worker.py` 作为可选独立主机worker运行已安装的 Rust biliup。将 `scripts/biliup-worker.py` 与 `scripts/upload_worker_state.py` 安装在同一目录。安装 `deploy/biliup-worker.service`，配置项目 `.secrets/biliup-worker.env`：

```ini
HIKVISION_DOWNLOADS_DIR=/dvr/data/hikvision-camera-mcp/downloads
BILIUP_BINARY=/opt/biliup/biliupR-v1.2.2-x86_64-linux/biliup
BILIUP_COOKIE_FILE=/opt/hikvision-camera-mcp/.secrets/biliup-cookies.json
BILIUP_COVER_FILE=/opt/biliup/assets/bilibili_default_cover.png
BILIUP_SEASON_ID=YOUR_COLLECTION_ID
BILIUP_SECTION_ID=YOUR_SECTION_ID
```

目录与环境文件仅服务账户可读；源码进程显式设置 `HIKVISION_BILIUP_ENABLED=1`。投稿队列在 `downloads/biliup_work/jobs/`，可跨重启查询。提交同一个草稿不会重复投稿；上传中断或未确认 BV 号时标记状态未知，不自动重试，应先查平台稿件。获得 BV 号后单独核对并加入足球合集；合集失败会保留 BV 号和 `collectionStatus=error`，不能重新上传视频。待上传或上传中的文件禁止改名和删除。
`biliup` 会以可写方式打开 Cookie 文件，也会在 `HOME/.local` 创建上传锁。systemd 的 `ProtectSystem=strict` 下要将 `.secrets` 加入 `ReadWritePaths`，并把 `HOME` 指向可写的 `biliup_work`；否则 CLI 在上传开始前就会报 `Read-only file system`。只开放这两个私有目录，不开放整个项目。

## Hermes Agent

在 `~/.hermes/config.yaml` 合并以下配置，Token 写入 `~/.hermes/.env` 的 `ZL_CAMERA_TOKEN`，不要提交这些用户配置：

```yaml
mcp_servers:
  zl_camera:
    url: "https://camera.example.com/mcp"
    headers:
      Authorization: "Bearer ${ZL_CAMERA_TOKEN}"
    timeout: 120
    supports_parallel_tool_calls: false
```

重启后用“列出摄像头”验证。Hermes 图片/播放器显示取决于客户端实现，接口返回的完整签名下载链接同样可用。配置依据：[Hermes 官方 MCP 文档](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)。



### 重启后的任务恢复

新提交的导出会在执行前把请求及排队顺序原子保存到数据目录。服务重启后，继续原任务编号和原录像机/通道；已选择的视频来源保持不变。已完成、失败和取消任务不会自动重跑，取消意图先落盘。已发布的媒体通过文件身份与发布检查点核对，多镜头任务只补未完成部分；恢复记录损坏或录像机被删除/换地址会明确报错，保留文件且不会切到当前激活录像机。旧版任务缺少完整请求的历史记录无法自动恢复，需人工重新提交。旧接口使用未保存设备的临时凭据时不额外落盘凭据，重启后会提示来源不可恢复。

Linux 的自动恢复需要 `flock`（由操作人安装 util-linux）。内核文件锁由服务及 curl/ffmpeg 子进程共同持有，同一数据目录只允许一个导出实例；主进程崩溃但旧媒体子进程仍存活时，新实例等待锁释放后再自动恢复。没有 `flock` 的非 Linux 平台可以正常启动空闲队列，但不自动重放未完成任务，必须先确认旧媒体进程并提供该锁工具；Windows/macOS 此恢复路径尚未实测。任务恢复会复用下载管线已有缓存；RTSP 流不会声称支持按字节续传。

两个主机上传 worker 均需与 `upload_worker_state.py` 一起升级，先停止旧 worker，再一起替换并重新启动；不要混跑使用旧 `.claim` 与新锁协议的版本。明确尚未启动远端操作的排队/预检任务会自动恢复。B 站已有稿件号会先只读核实，再恢复合集步骤；云盘完成状态只接受与该文件及目标对应的成功回执。已开始上传但结果不明的任务保持“待确认”，绝不自动重复投稿或重新上传。导出恢复不会新增上传任务，历史上传记录和远端名称不会随本地改名而改写。

本地改名也保存独立的写前意图；重启后只在原/新路径的文件身份一致时完成改名和任务索引更新。身份冲突或记录损坏时保留所有文件并显示待核对，不按同名/同大小猜测，也不改写上传历史。

### 上传进度与缺口选择

B 站 worker 使用 PTY 接收工具的字节进度，同时解析带 ANSI 控制序列、回车重绘和无换行完整帧。只有工具给出非零总字节数时显示文件传输百分比；零或未知总量保持未知，不用本地文件大小补出百分比。最近的测量值会节流落盘并在退出前刷新。任务卡同时显示百分比、已传/总量、速度；旧速度过期后隐藏并标记最近更新时间。文件传输与提交稿件是不同阶段，提交时不假装停在 99%。这些状态不会改变 `remote_started` 的防重复投稿规则。旧的已运行上传进程不会因 UI 更新自动重启。

控制台明确选择 MediaMTX 时，不再因录像缺口静默切到 DVR。选段内的警告按钮直接使用已加载的时间轴覆盖信息，逐条显示已知中断的开始和结束时间；点击导出时也先展示同一确认界面，取消不会提交任务。确认操作绑定当时的日期、来源、通道及入出点，过期的确认不会覆盖当前选择。

`POST /console/api/export` 在入队前通过 MediaMTX Playback 目录核验所选窗口，采用服务端保存的通道映射，不信任客户端给出的覆盖数据。目录查询含响应体读取的总超时为 15 秒；前端等待 20 秒后恢复操作，并允许用户主动停止等待。已在服务器创建的任务须到任务页取消，停止等待并不保证撤回已经受理的任务。

目录报告缺口时，接口返回 `409 / MEDIAMTX_GAPS` 与各条缺口区间、缺失秒数、请求秒数和可用覆盖秒数，不创建任务。用户明确接受后以 `acceptGaps: true` 重新提交，只导出已有素材并跳过缺口，不填黑帧、不冻结补时；没有可用素材则返回 `422 / MEDIAMTX_EMPTY`。用户也可以自行选择并核验 DVR 及通道。

快速检查通过后立即返回任务编号，耗时的本地文件核验在可见、可取消的任务内执行。实际导出仍核对文件覆盖；目录与文件发生变化时会明确失败，不把快速检查当作文件完整性的保证。时间轴、目录及文件时长描述的是时间覆盖，并不证明每一帧都正确，也不能识别所有色块、冻结或文件内部损坏。

接受缺口的选择、原来源和缺口记录会随队列恢复保留。成片任务明确标为含缺口；可用覆盖时长不同于原墙钟时间范围，MP4 中缺口被略过。复制模式切点仍受关键帧影响，不把覆盖秒数说成逐帧精确的成品播放时长。后续未接受缺口的请求不会复用旧缺口成片作为完整结果。


### 公网来源配置（独立实例第一阶段）

已登录的控制台可保存多台 DVR 的稳定 ID、显示名称、主机/IP、独立 HTTP/RTSP 端口及设备账号。HTTP 默认 80，RTSP 默认 554；旧 `host:port` 仅按 HTTP 端口迁移，不猜测 RTSP 端口。新增设备不切换旧界面的全局激活设备。密码只写入服务器：界面只显示「已保存」，留空保留原值；改变地址、任一端口或用户名必须重新输入密码。保存不访问设备、不预览、不导出。连接测试仅顺序读取 ISAPI deviceInfo 与 Streaming/channels，总时限 10 秒，每次响应最多 1 MiB，不跟随重定向，设备认证失败使用安全的 502 / DVR_AUTH_FAILED，不等同控制台登录过期。

摄像头映射包含 `id/name/deviceId/channel/archivePath`；`archivePath` 仍只允许单层目录名称，不是任意文件路径。删除设备前必须移除映射；运行、排队、清理中或待恢复任务引用的设备不可更换来源或删除。映射变更须等待未完成任务结束。MediaMTX 配置仅修改 Playback HTTP(S) 根 URL，不接受 URL 内账号密码、查询或路径；不修改本地录像根目录，不连接或管理 MediaMTX 录制服务。保存后新回放请求采用新地址，已取得的流不被强制重启。回放目录响应最多 2 MiB，15 秒超时覆盖响应体读取。

公开网关仅放行以下新增接口，旧 `/api/devices` 仍不公开：

- `GET /console/api/config`：返回不含密码的 DVR 列表、完整映射、MediaMTX 地址、准备模式、revision 和 CSRF token
- `POST /console/api/dvrs`、`PATCH/DELETE /console/api/dvrs/:id`
- `POST /console/api/dvrs/:id/test`
- `PUT /console/api/cameras`：原子替换完整映射数组
- `PUT /console/api/mediamtx`：更新 Playback 地址

修改与测试须使用 owner 登录 Cookie、同源 Origin、`X-CSRF-Token`，并在 JSON 中携带最近读取的 `revision`。Bearer/MCP/OAuth token 不授权这些接口。revision 是进程私有随机密钥的 HMAC，密码改变也使旧 revision 失效，重启后重新加载即可；不会公开密码文件的可离线猜测摘要。过期版本返回 409，禁止盲目覆盖。错误或超大 JSON 返回通用 JSON 错误，不输出请求内容、解析栈、密码或原始 curl 错误。存储原子替换且采用私有文件权限；损坏的现有文件明确失败并保留原字节。

`HIKCLIP_PREPARATION_ONLY=1` 时这些配置写入、测试和通道探测均拒绝执行。仅在用户授权启用本机新来源后，由服务器管理员改成 0 并重启；Web 不修改此开关，也不复制其他实例的配置。`HIKCLIP_LOGIN_PASSWORD` 的环境管理方式及 MCP/OAuth 凭据保持独立，CLI 设备登录不由本页面配置。

同域不同路径的 Cookie 名称/签名/路径隔离避免会话冲突；Origin 与 CSRF 防护不能隔离同一 origin 中已恶意执行的其他应用脚本。需要此类隔离时应使用不同 origin。

来源可编辑后，成片自动复用和任务恢复必须匹配凭据无关的来源指纹，包括 DVR ID/端口/通道、摄像头及归档映射、本地归档根目录和 Playback URL。旧无来源指纹的成片仍可查看、下载，不会自动复用；旧无来源指纹的摄像头待恢复任务明确停止并保留文件，需要核对后重新提交。旧未命名来源的中间缓存不自动复用，不删除旧文件。此次验证使用本地模拟 DVR/MediaMTX，真实 DVR 协议及服务器现场验收另行进行。


### 控制台 MediaMTX 直播

控制台切换 MediaMTX 通道时尝试 WebRTC 最新画面。WHEP 信令通过已登录控制台的同源受限路由转发，媒体仍走 MediaMTX 原有 ICE 候选；不公开 Control API，也不接受浏览器指定上游主机。服务默认连接本机 `http://127.0.0.1:8889`，远程部署可显式设置 `HIKVISION_MEDIAMTX_WEBRTC_URL` 为纯 HTTP(S) 根地址。此配置不修改 MediaMTX 或防火墙。

直播与 DVR 预览共用全局预览替换／导出停止屏障。关闭、切换通道或开始回放会关闭 peer connection 并尽力 DELETE 临时 WHEP 会话。页面不申请摄像头／麦克风权限。

直播连接失败时只读取当前所选日期（默认为北京时间当天）的录像目录，暂停在该日最后可解码画面，并按日期标记“今日最后录像画面”或“所选日期最后录像画面”。切换通道和直播回退均保留所选日期及入点／出点；所选日期没有录像时显示空态，不自动改查其他日期，也不冒充实时画面。

浏览器客户端使用 MediaMTX v1.21.1 官方 MIT `reader.js`，附带原 LICENSE。仅增加每实例 fetch 注入以经过同源鉴权路由，以及 ES module 导出；上游 codec / SDP 处理保留。支持的音视频编码仍由 MediaMTX 与实际浏览器协商决定。
