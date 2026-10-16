# MCP 接入与定时导出

让 AI 客户端用自然语言驱动录像导出，以及让常规时段每晚自动拉回来。
设计依据见 `mcp-plan.md`，这里只讲怎么用。

摄像头别名、MediaMTX 截图/缩略图/视频、新工具、OAuth 与公网部署见 [AI Camera MCP](camera-mcp.md)。本文保留旧工具与定时任务的兼容使用说明。

## 两条路各管一半

| | 谁执行 | 管什么 |
| --- | --- | --- |
| **定时任务** | 常驻服务进程里的 scheduler | 每天固定的 20:00–22:30，雷打不动 |
| **MCP** | AI 客户端按需调用 | 临时改时段，比如「今天 19:30 就开球了」 |

定时任务**不走 MCP**：MCP 是被动协议，得有客户端在 23:00 那一刻活着并主动调用才会执行，
把每天必做的事交给不确定的执行者是错配。

## 定时导出

首次启动服务时会在 `data/schedules.json` 写入一条默认计划：

```json
{
  "schedules": [
    {
      "id": "…",
      "name": "每晚常规",
      "enabled": true,
      "channel": null,
      "startTime": "20:00",
      "endTime": "22:30",
      "runAt": "23:00",
      "method": "auto",
      "retentionDays": 7,
      "lastRun": null
    }
  ]
}
```

如果首次启动时**已经过了 23:00**，`lastRun` 会被写成 `{ "status": "seeded" }` 把当天标记成跑过——
否则服务一起来就立刻开始一趟 2.5 小时的导出。在 23:00 之前启动则留空，今晚照常跑。

改这个文件即可，**不需要重启**——scheduler 每分钟重读一次。启动横幅里会列出启用中的计划。

字段说明：

- `channel` — 留 `null` 就跟随 Web 界面上次选的通道，再取不到就用 `101`
- `method` — `auto` 按时长选（见下），也可以写死 `rtspclip` / `mp4download`
- `runAt` — 本地时间。必须晚于 `endTime`，否则会撞上「结束时间不能晚于当前时间」的校验
- `retentionDays` — 见「磁盘保留」
- `lastRun` — scheduler 自己写，手工别改（改了会影响「今天跑没跑过」的判断）

### 触发规则

同时满足才跑：计划启用、本地时间已过 `runAt`、当天还没跑过。

- **不补跑历史**。box 关机三天再开，只会跑今天这趟，不会一口气补三个 2.5 小时的导出。
- **当天的补跑会做**。23:00 没开机、23:40 才开机，那趟仍然会执行——它还是「今天的那一趟」。
- **失败也算跑过**。同一天里不重试，`lastRun.status` 会记成 `failed` 并带上原因。
  这是有意的：设备离线之类的问题重试一晚也没用，反而会反复占会话池。

## 导出方式怎么选

| 时长 | 方式 | 为什么 |
| --- | --- | --- |
| < 1 小时 | `rtspclip` | 快，`Rate-Control: no` 全速拉流，不用先下整个录像文件 |
| ≥ 1 小时 | `mp4download` | 慢些，但 `.hikraw` 分片有断点续传，而且留在本地能被后续重导复用 |

复用是这条规则的重点。每天 20:00–22:30 走 `mp4download` 把分片留下；
某天 19:30 就开球了，重导 19:30–22:30 时 20:00 之后的部分直接命中缓存，
只需要新下 19:30–20:00 覆盖到的那个录像文件。

所以**扩展时段一律是换参数重导一次，不要把两段成品 MP4 拼起来**——
拼接要求两段编码参数完全一致、时间戳连续，出问题极难排查，而重导走的是已经跑熟的路径。

## 磁盘保留

主码流 8192 kbps 录 2.5 小时，`.hikraw` 分片约 9 GB，加上成品 MP4 一晚接近 18 GB。
每次定时任务触发时，会**先清理**再导出（这时磁盘占用最低），删掉 `downloads/` 里
超过 `retentionDays`（默认 7 天）的：

- 成品 `.mp4`
- 分片缓存 `.hikraw` 和完成标记 `.hikraw.done`
- 裸流中间文件 `.h264` / `.hevc` / `.aac`

最后一类是导出中断（服务重启、崩溃、断电）后的残留——正常跑完会自己删，中断则会留下。

其他文件一概不碰。手动触发清理可以用 Web 界面的缓存抽屉，或 `DELETE /api/cache`。

## 接上 MCP 客户端

MCP 进程是常驻服务的**客户端**，不是第二个服务端——它把所有动作转发给常驻服务的 HTTP API，
这样任务状态只有一份，不会两边同时导出去抢 NVR 的回放会话池。

有两种传输：**stdio**（`server.js mcp`，独立进程）和 **HTTP**（常驻服务上的 `POST /mcp`）。

能执行本地命令的客户端优先用 stdio——按需拉起，不用一直敞着端点。反过来，
客户端跑在网页版、手机、别人的电脑上时只能用 HTTP。

注意 stdio **不意味着 AI 工具必须跑在 box 上**：MCP 进程和常驻服务之间本来就走 HTTP，
两者不必同机。下面三种 stdio 摆法都可用。

### 一、都在 box 上

```bash
claude mcp add hikclip -- node /absolute/path/h1km3sh/server.js mcp
```

### 二、AI 工具在别的机器，MCP 进程通过 ssh 在 box 上跑

```bash
claude mcp add hikclip -- ssh operator@recorder.example.com /usr/bin/node /absolute/path/h1km3sh/server.js mcp
```

**node 要写绝对路径**：ssh 非交互 shell 的 PATH 通常不含 nvm 装的 node
（和 `service-*.js` 里写死绝对路径是同一个坑）。用 `ssh operator@recorder.example.com 'which node'` 确认实际路径。

好处是本地什么都不用装；代价是每次拉起 MCP 都要建一条 ssh 连接。

### 三、MCP 进程在本机，通过局域网 HTTP 连 box

```bash
claude mcp add hikclip --env HIKCLIP_BASE_URL=http://box:30001 \
  -- node /path/to/Hikvision-Video-Extractor/server.js mcp
```

不需要 ssh，也不需要 box 上有你的账号。`list_outputs` 回的下载地址会自动用 `HIKCLIP_BASE_URL`
的主机名，所以拿到的链接在你本机就能直接下载。

本机没装 node 的话，用 SEA 单文件同样可以（它也认 `mcp` 子命令）：

```bash
HIKCLIP_BASE_URL=http://box:30001 ./hikvision-extractor mcp
```

代价是本机这份代码要和 box 上的保持同步——工具定义改了两边都得更新，否则行为对不上。
只有一台常用机器时选这条最省事；机器多了反而是方案二好维护。

### 服务地址怎么找到

按顺序尝试：

1. `HIKCLIP_BASE_URL` 环境变量（跨机或非常规端口时用，例如 `http://192.168.50.10:30001`）
2. `<dataDir>/service/runtime.json` 里的 `port` —— 服务启动时写的。端口会自动顺延，这是唯一可靠来源
3. 从 30001 起顺序探测 10 个端口

方案三必须显式给 `HIKCLIP_BASE_URL`：后两步只探测本机回环地址，找不到远端的服务。

## 四、HTTP 传输（`POST /mcp`）

常驻服务启动时自动挂上，启动横幅里会打印地址。给没法执行本地命令的客户端用：

```bash
claude mcp add --transport http hikclip http://box:30001/mcp
```

工具面、行为与 stdio 完全一致——两种传输共用同一个 dispatcher，传输层只负责收发。
`list_outputs` 回的下载链接会用**你实际访问时用的主机名**，所以从哪台机器调的，
拿到的链接就在哪台机器能直接下（`/downloads` 支持 range 请求，播放器可以边下边拖）。

自己验一下：

```bash
curl -s -X POST http://box:30001/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

实现上是无状态的 Streamable HTTP：不发 `Mcp-Session-Id`，`GET`/`DELETE` 回 405
（规范里表示「不提供服务端主动推送的 SSE 流 / 无会话」的方式）。工具全是请求—响应，用不上。

### Origin 校验

带 `Origin` 头且不是环回地址、也不与本服务同源的请求，一律 **403**。

这是 MCP 规范对 HTTP 传输的明确要求，针对的是 DNS rebinding。本服务绑 `0.0.0.0`、
**没有鉴权**、`app.use(cors())` 又放行所有来源——没有这道校验的话，你在浏览器里打开的
任意网页都能 fetch 到 `http://box:30001/mcp` 并读到响应，等于把录像机操作权交给了
任何一个你访问过的站点。

真正的 MCP 客户端不是浏览器、不带 `Origin`，所以这道校验对它们透明。

### 这个端点只适合局域网

它**没有鉴权**。在局域网内这不增加新的暴露面——同网段的人本来就能直接调 `/api/export`。
但别把它暴露到公网：那需要先给整个服务补鉴权，是独立的一件事，不能靠 Origin 校验代替
（Origin 只挡浏览器，挡不住直接发请求的程序）。

服务没起来时工具会明确报「找不到正在运行的录像提取服务」，而不是超时。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_channels` | — | 通道编号、名称、分辨率 |
| `list_recordings` | `date?` `channel?` `start?` `end?` | 某天实际录到了哪些时段 |
| `export_clip` | `start` `end` `date?` `endDate?` `channel?` `method?` | 发起导出，立刻返回 taskId |
| `get_export_status` | `taskId?` | 省略则返回全部任务 |
| `cancel_export` | `taskId` | 停止 |
| `list_outputs` | `limit?` | 成品列表，含下载地址 |

时间一律用本地墙钟：`"19:30"` 就是录像机上显示的 19:30，转换由服务端做。
跨零点用 `endDate`（如 `date=2026-08-07 start=23:00 endDate=2026-08-08 end=00:30`）。

`export_clip` 会先确认那段真有录像，没有就直接拒绝，而不是让导出慢慢失败。
如果录像检索本身报错（老固件、track 不存在），它会把情况说出来但照常尝试导出。

用起来大概是这样：

> 「今天 19:30 就开球了，把 19:30 到 22:30 的录像拉下来」

模型会调 `export_clip(start="19:30", end="22:30")`，服务端算出 3 小时 → 选 `mp4download`
→ 20:00 之后的部分命中当晚定时任务留下的分片缓存。

## 只允许一个导出任务

NVR 的回放会话池小且回收是分钟级的，两个导出并行只会互相抢会话把彼此都拖慢。
所以服务端做了单飞守卫：已有任务在跑时，第二个请求会收到 HTTP 409，
并附上正在跑的那个任务的进度和 `runningTaskId`。

这条对三个入口一视同仁：Web 界面、MCP、定时任务。定时任务被拒时会把原因记进 `lastRun`。

## 排查

MCP 的诊断输出全在 **stderr**（stdout 被 JSON-RPC 协议独占，混进一行普通日志就会让握手失败）。
手工验证握手：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node server.js mcp
```

应该只输出一行 JSON。如果掺进了别的内容，说明有代码往 stdout 写了东西。

看定时任务有没有跑：`data/schedules.json` 的 `lastRun`，以及服务日志
（装成后台服务时是 `data/service/service.log`，`npm run service:logs` 可以 tail）。

## 安全前提没变

服务无鉴权、`/api/devices` 明文返回设备密码，是可信局域网部署下的有意取舍
（见 `AGENTS.md`「部署假设」）。MCP 这层不改变这一点：它只是又一个局域网内的客户端。
密码不会出现在任何 MCP 工具的返回值里，但服务端本身照旧。别把这个端口暴露到公网。
