# 交叉编译：在一台机器上产出所有平台的单文件

结论先说：**在 mac 上可以直接编译出能在 Linux amd64 上跑的单文件可执行程序**，不需要 Linux 机器，也不需要
容器工具或远端构建配额。Windows exe 同理。

```bash
npm run build:sea:linux    # → dist-sea/hikvision-downloader-linux-x64
npm run build:sea:win      # → dist-sea/hikvision-downloader.exe
npm run build:sea:mac      # → dist-sea/hikvision-downloader-macos-arm64
npm run build:sea          # 当前平台
```

参数：

```bash
node scripts/build-sea.js --target=linux --arch=x64          # 也支持 arm64
node scripts/build-sea.js --target=linux --node-version=22.20.0
NODE_MIRROR=https://nodejs.org/dist npm run build:sea:linux   # 显式指定官方来源
node scripts/build-sea.js --target=linux --mirror=https://nodejs.org/dist
```

便携包（node 二进制 + bundle 分开放的那种）同样能交叉构建：`npm run build:win` / `npm run build:linux`。

## 原理

Node.js SEA（Single Executable Application）把应用打成一个 blob，再注入到 node 二进制的一个 section 里：

```
esbuild 打包 → sea-entry.js ──┐
public/ 内联 base64 ──────────┴→ node --experimental-sea-config → sea-prep.blob
                                                                      │
目标平台官方 node 二进制（下载）───────── postject 注入 ───────────────┴→ 单文件可执行程序
```

关键点：**blob 与平台无关，外壳才是平台相关的**。所以只要换成目标平台的官方 node 二进制当外壳就行，
`scripts/node-binary.js` 负责下载并缓存（`.node-cache/v<版本>/<平台>-<架构>/`），postject 本身是 JS 工具，
在任何系统上都能改 ELF / PE / Mach-O。

两个必须注意的细节，脚本已经处理：

1. **交叉编译时必须关掉 code cache**（`useCodeCache: false`）。V8 的代码缓存是按平台+架构编译的，
   带着它跨平台会在目标机器上直接崩。代价是启动稍慢一点点（几十毫秒级）。
2. **壳的 node 版本要和生成 blob 的 node 版本一致**。脚本默认下载与当前 `process.versions.node` 相同的版本，
   本机 node 版本没有官方发布包时用 `--node-version=` 指定一个存在的版本。

## 各目标平台的坑

### Linux

- 官方 node 二进制是 glibc 构建，实测本仓库产物需要 **glibc ≥ 2.28、GLIBCXX ≥ 3.4.21**，
  即 Debian 10+ / Ubuntu 20.04+ / CentOS 8+ 都没问题。
- **Alpine（musl）跑不了**，官方构建不支持 musl。
- 拷到目标机器后记得 `chmod +x`（打包成 zip 会丢权限位，tar 不会）。

### Windows

- 官方 `node.exe` 自带 Authenticode 签名，注入后签名失效。在非 Windows 主机上没有 `signtool` 可以先摘签名，
  所以产物是「签名无效」的状态——**能正常运行**，但首次打开可能弹 SmartScreen，点「更多信息 → 仍要运行」。
  介意的话在 Windows 上构建（脚本会自动 `signtool remove`），或者自己买证书签名。

### macOS

- 注入前后必须处理代码签名，脚本在 macOS 主机上会自动 `codesign --remove-signature` → 注入 →
  `codesign --sign - --force` 重新 ad-hoc 签名。
- 在非 macOS 主机上交叉编译 mac 产物会给出警告：没签名的 Mach-O 在较新的 macOS 上会被直接拒绝运行。
  也就是说 **mac 目标最好在 mac 上构建**。

## 验证产物

应在目标平台用独立私有数据目录实际验证程序启动、依赖解析及媒体行为；文件格式检查不能替代运行验收。此文保留历史本机构建入口，本源码候选只承诺提供源文件，不附预编译产物。

## Source snapshot scope

No GitHub Actions or prebuilt executables are included in this source snapshot. Local build commands require separate platform validation and third-party license review before binary distribution.
