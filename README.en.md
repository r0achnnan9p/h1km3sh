# H1kM3sh

[简体中文](README.md) | [MediaMTX source quickstart](docs/oss-quickstart.md)

H1kM3sh reviews MediaMTX and Hikvision DVR/NVR recordings, selects timeline ranges and exports MP4 clips through a web console and MCP. Run this distribution **directly from source with Node.js 24**. No container deployment, automatic release or prebuilt executable is supplied. It does not record streams or replace MediaMTX server administration.

## Requirements and limits

- Install Node.js 24, npm, and system FFmpeg/ffprobe on PATH. H.264 encoding, AAC and drawtext are needed by relevant media paths; readable fonts are needed for thumbnails (HIKVISION_FONT_FILE can select one).
- Hikvision ISAPI/RTSP paths require curl. Optional upload workers, account adapters and SDK tooling require Python 3 and separately reviewed upstream tools.
- Linux export recovery requires flock from util-linux. Complete recovery and service behavior on Windows/macOS need separate platform acceptance.
- Optional proprietary HCNetSDK targets Linux x86-64, requires a licensed vendor archive, an explicit recorder UUID/runtime profile and real device validation. No SDK binaries are included or automatically enabled; see [SDK scope](docs/hik-sdk.md).
- Set the application timezone to the recorder's wall clock. The Z in Hikvision time strings does not establish ordinary UTC semantics.

Offline tests and a local startup do not validate every platform, real recorder, iPhone PWA, media boundary or production permission.

## Install and first start

Obtain the maintainer-reviewed source snapshot and open its directory:

~~~sh
node --version
ffmpeg -version
ffprobe -version
npm ci --omit=optional --ignore-scripts
HIKCLIP_BIND=127.0.0.1 HIKCLIP_PORT_FALLBACK=0 HIKCLIP_SCHEDULER_ENABLED=0 HIKVISION_MEDIAMTX_API_URL='' node server.js
~~~

Windows PowerShell:

~~~powershell
$env:HIKCLIP_BIND = '127.0.0.1'
$env:HIKCLIP_PORT_FALLBACK = '0'
$env:HIKCLIP_SCHEDULER_ENABLED = '0'
$env:HIKVISION_MEDIAMTX_API_URL = ''
node server.js
~~~

Open http://127.0.0.1:30001 on the same host; stop with Ctrl+C. An empty recorder/archive list is expected before configuration. Keep data/ (including credentials) and downloads/ private and out of Git. See [source setup](docs/oss-quickstart.md) for storage and MediaMTX settings. Node.js 24 can read your private configuration with node --env-file=YOUR_PRIVATE_FILE server.js; the app does not automatically load .env.

## Safe access and use

**30001 is an unauthenticated internal API/legacy interface with device credentials and downloads. Keep HIKCLIP_BIND=127.0.0.1. Never proxy, forward or publicly expose it.** Without an explicit bind, the generic launcher still defaults to 0.0.0.0.

For a phone, another host or remote access, configure the independent **30002 protected gateway behind HTTPS**: HIKCLIP_PUBLIC_PORT, HIKCLIP_PUBLIC_BIND, the actual HTTPS HIKCLIP_PUBLIC_BASE_URL, a separate MCP token file, and a console password. Set HIKCLIP_LOGIN_PASSWORD (8–128 characters) in your private environment or initialize locally with npm run setup:status-password. Keep setup codes, tokens and passwords private. Proxy only 30002 and restrict its reachability. See [gateway/MCP](docs/camera-mcp.md) and [security](SECURITY.md).

In the protected console, configure your source, inspect recording coverage and select a range for export. MediaMTX and DVR coverage are handled separately; another recorder does not silently fill a gap. Preview and export share device resources and the queue. Keyframes, gaps, codecs and firmware affect results: no universal frame-accurate wall-clock cuts are promised. SDK preview requests are limited to 30 seconds and exports to one hour; SDK failures remain explicit. The private one-off HTTP compatibility diagnostic is excluded.

Upload integrations require separate tool setup and account authorization; starting the app does not authorize uploads. See [managed uploads](docs/managed-uploads.md) and [account linking](docs/upload-account-linking.md).

## Local checks and further reading

~~~sh
npm test -- --test-concurrency=2
~~~

Record failures, skips and untested platforms. Read [CLI configuration](tools/hikvision-cli/README.md), [developer reference](docs/developer-reference.md), [background service](docs/background-service.md), [native profile](docs/native-staging.md) and [contributing](CONTRIBUTING.md).

## License

Original code uses [MIT](LICENSE); bundled assets and optional tools retain their own licenses. See [third-party notices](docs/third-party-notices.md). The lockfile marks optional ffmpeg-static GPL-3.0-or-later. The install command omits optional binary packages and install scripts; dependencies, system FFmpeg and future binaries are not all MIT. No private footage, credentials or vendor SDK is included. This is an independent project, unaffiliated with MediaMTX or Hikvision.
