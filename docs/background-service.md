# 后台运行与开机自启

把工具装成后台服务：关掉终端也继续跑，开机/登录自动拉起，随时一条命令启停或彻底删掉。

三个系统都用**系统自带**的机制，**不需要管理员/root**，也不额外装 pm2、nssm 之类的东西：

| 系统 | 机制 | 服务定义写在哪 |
| --- | --- | --- |
| macOS | launchd 用户级 LaunchAgent | `~/Library/LaunchAgents/com.hikvision.video-extractor.plist` |
| Linux | systemd 用户级 service | `~/.config/systemd/user/hikvision-extractor.service` |
| Windows | 计划任务（登录触发）+ VBS 隐藏窗口启动器 | 计划任务 `HikvisionVideoExtractor` + `data\service\run-hidden.vbs` |

## 命令

三种运行形态入口不同，命令完全一样：

```bash
npm run service -- <命令>                      # 源码
node app.js service <命令>                     # 便携包（Windows 是 node.exe app.js service ...）
./hikvision-downloader-linux-x64 service <命令> # 单文件（Windows 是 hikvision-downloader.exe service ...）
```

| 命令 | 作用 |
| --- | --- |
| `install` | 写服务定义 + 打开开机自启 + 立即启动。重复执行相当于「按当前路径重新安装」 |
| `uninstall` | 停止 + 删除服务定义（日志保留） |
| `start` / `stop` | 起停当前进程，服务定义不动 |
| `restart` | 重启 |
| `status` | 装没装 / 自启开没开 / 跑没跑 / PID / API 地址 / 日志路径 / 启动命令 |
| `enable` / `disable` | 只切开机自启，不影响当前正在跑的进程 |
| `logs` | 看日志，`-n 200` 指定行数，`-f` 持续跟随 |

源码运行还有一组简写：`npm run service:install` / `:start` / `:stop` / `:restart` / `:status` / `:logs` / `:uninstall`。

选项：

- `--port <端口>`：仅 `install`。不给就用默认 30001，被占用时自动往后顺延。
  例：`npm run service:install -- --port 8080`

`status` 长这样：

```
  服务后端  launchd 用户级 LaunchAgent（macOS）
  安装状态  已安装
  开机自启  已启用
  运行状态  运行中（PID 2420）
  API 地址  http://localhost:30001
            http://192.168.50.21:30001
  服务定义  /Users/xxx/Library/LaunchAgents/com.hikvision.video-extractor.plist
  日志文件  /path/to/项目/data/service/service.log
  启动命令  /usr/local/bin/node /path/to/项目/server.js
```

## 装完之后落在哪

- **日志**：`<数据目录>/service/service.log`（stdout + stderr 一起追加进去，服务重启不清空）
- **运行时信息**：`<数据目录>/service/runtime.json`，里面是 pid 和**实际监听端口**——因为端口会自动顺延，
  `status` 靠它才能报出准确地址；进程退出时自己删掉
- **数据目录**：源码/便携包是项目里的 `data/`，单文件版是 exe 同级的 `data/`；安装时会把这个路径写死进服务定义
  （`HIKVISION_DATA_DIR`），保证后台服务和你手动前台启动读写的是同一份设备列表

服务定义里还固定了安装时的 `PATH`，这样 launchd/systemd 那种精简环境也能找到 Homebrew/自定义目录下的 ffmpeg。

## 各系统的注意事项

### macOS

- `stop` 用的是 `launchctl bootout`，plist 还留着，`start` 能再拉起来。
- `disable` 之后 launchd 会拒绝加载这个服务，此时 `start` 会明确提示先 `enable`——不是 bug。
- 服务在**登录后**才启动（用户级 Agent 的正常行为）。想要开机不登录就跑，得改成 `/Library/LaunchDaemons` 下的
  系统级服务，那需要 sudo，本工具没做。

### Linux

- 用户级 service 默认跟着登录会话走。想「开机就跑、不用登录」，按 `install` 的提示开 linger：

  ```bash
  sudo loginctl enable-linger $USER
  ```

- 日志走 `StandardOutput=append:`（systemd ≥ 240，即 Debian 10 / Ubuntu 20.04 以上）。
- 没有 systemd 的运行环境会直接提示不支持，请改用 `nohup ./app &` 之类的土办法。

### Windows

- 计划任务触发条件是**当前用户登录时**，`/RL LIMITED` 普通权限，不会弹 UAC。
- 中间套一层 VBS 是为了不弹黑窗口：`WScript.Shell.Run(cmd, 0, True)` 才能真正隐藏窗口，同时把输出重定向到日志。
- `stop` 先 `schtasks /End`，再按 `runtime.json` 里的 pid `taskkill /T /F`，避免留下游离的 node 进程。
- 计划任务/VBS/task.xml 都写的是 UTF-16，中文用户名路径（`C:\用户\张三\…`）不会乱码。

## 常见问题

**装完访问不了？**
先 `status` 看运行状态和端口，再 `logs -n 50` 看有没有报错。最常见的是 ffmpeg 不在 PATH（日志开头会打印
`[ffmpeg] ... (fallback)`）和端口被别的程序占了（服务会顺延到 30002、30003…）。

**换了 node 版本之后服务起不来？**
服务定义里写的是安装时那个 node 的绝对路径（nvm/fnm 切版本后旧路径会消失）。重新跑一次 `install` 即可覆盖。

**移动了项目目录？**
同上，路径写死在服务定义里，移动后重新 `install`。

**导出到一半 stop 会怎样？**
进程直接被停掉，正在跑的导出任务中断，已下载的 `.hikraw` 缓存还在，下次导出会复用。

**卸载干净吗？**
`uninstall` 会删掉服务定义（Windows 还会删掉生成的 vbs/xml），日志和 `data/`、`downloads/` 保留——那是你的数据，
要清自己删。
