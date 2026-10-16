# Local native profile (Node.js 24)

This source snapshot includes the generic native launcher, health check, environment example and systemd template. Private host bootstrap, runner, publisher and deployment instructions are excluded. No CI or automatic release is configured. For a local source start use [README](../README.md); for the authenticated gateway see [camera MCP](camera-mcp.md).

The launcher requires Node.js 24 and explicit absolute paths for HIKVISION_DATA_DIR, HIKVISION_DOWNLOADS_DIR, HIKVISION_ARTIFACT_DIR, HIKVISION_ARCHIVE_DIR and HIKVISION_RUNTIME_FILE. Use new, private, instance-specific directories. It fixes the internal API to 127.0.0.1:30001, gateway port to 30002, disables port fallback and the scheduler, and starts in preparation mode. It rejects existing source/worker state in preparation mode. Configure HTTPS, a separate MCP token and a valid 8–128 character login password before remote access. Do not expose 30001.

Review [the environment example](../deploy/native/app.env.example) and [systemd template](../deploy/native/app.service.in) before any manual installation. The template expects `/usr/local/bin/node` → `/opt/nodejs/current/bin/node`; check `/usr/local/bin/node --version`. Adapt installation paths and service identity to the operator's own host. No installation, sudo grant, enable or restart command is included here.

HIKCLIP_PREPARATION_ONLY=0 commissions the operator's own isolated instance. Do not copy another deployment's source credentials, recording archive, queues or account state. SDK activation additionally requires a validated release-local manifest and explicit recorder UUIDs; see [SDK instructions](hik-sdk.md). Upload capability requires a separately installed managed manifest and explicit account authorization; see [managed uploads](managed-uploads.md).

Local offline checks: `node --test test/native-start.test.js test/native-listener.test.js test/native-unit.test.js test/sdk-runtime-profile.test.js`. These do not prove Linux service installation, real-recorder behavior or production readiness.
