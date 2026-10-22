# MediaMTX source quickstart

Use an existing [MediaMTX](https://mediamtx.org/) recorder and compatible local MP4 segments. H1kM3sh does not start MediaMTX or include recordings. Install Node.js24 and system FFmpeg/ffprobe, then follow the [README](../README.en.md) source install command. No container tooling is required.

## Local source configuration

Review [source.env.example](../deploy/source.env.example). Copy it to your own Git-ignored private file, replace storage paths, and set TZ to the recorder's wall-clock timezone. Node.js24 supports node --env-file=YOUR_PRIVATE_FILE server.js. The app does not load that file implicitly.

HIKVISION_ARCHIVE_DIR must be an existing archive directory readable by the app account; grant only read access to original recordings at the operating system level. Give the separate data/download/artifact directories private write access and sufficient disk capacity. HIKVISION_MEDIAMTX_PLAYBACK_URL and HIKVISION_MEDIAMTX_API_URL must be reachable by the source process. Playback and Control API addresses are independent; setting the API URL to an empty string disables API discovery. Protect the [MediaMTX Control API](https://mediamtx.org/docs/features/control-api); never publicly expose9997.

Start on127.0.0.1:30001 with scheduler and automatic API discovery disabled first, as shown in the README. This is the unauthenticated internal API and static asset host; its root path returns 404 and it is not the protected PWA. Use the 30002 gateway below for the console. An empty archive or recording gap is not filled from a random DVR.

## Protected PWA and MCP

For remote/mobile access, configure the source process with HIKCLIP_PUBLIC_PORT=30002, HIKCLIP_PUBLIC_BIND=127.0.0.1, your real HTTPS HIKCLIP_PUBLIC_BASE_URL, an independent HIKCLIP_MCP_TOKEN_FILE and a separate console password. Use an operator-generated token of at least32 non-whitespace characters; keep the file private. Configure HIKCLIP_LOGIN_PASSWORD (8–128 characters) in your private environment, or run npm run setup:status-password locally. Only you should read and use any setup code.

An operator-managed HTTPS proxy on the same host forwards only to127.0.0.1:30002; do not forward30001. A proxy on another host requires an explicit HIKCLIP_PUBLIC_BIND address and firewall restriction to that proxy. Follow [gateway configuration](camera-mcp.md) for prefix, OAuth and media-link rules. The source process does not install or configure a proxy or Tunnel.

## Verification limits

Run local tests as documented in [CONTRIBUTING](../CONTRIBUTING.md). Compatible media, real-device export, browser/PWA behavior and service permissions require separate acceptance. No cross-platform or frame-accurate export guarantee follows from offline tests.
