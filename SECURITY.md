# Security policy

H1kM3sh processes DVR credentials, video clips and media export jobs.

**Port 30001 is an unauthenticated internal API. Never forward or reverse-proxy it to the LAN or Internet.** Set HIKCLIP_BIND=127.0.0.1 for source execution. Use the separate authenticated 30002 gateway behind HTTPS for remote/mobile access, and independently protect MediaMTX Control API and recorder endpoints.

For private security reports, use this repository's GitHub private vulnerability reporting feature **if enabled**. Otherwise contact the maintainer privately via the GitHub profile to arrange secure disclosure. Never post exploits, camera credentials, real tokens, or sensitive footage in a public issue.

Supported behavior depends on the exact source, codec, browser and deployment profile. See the [MediaMTX quickstart](docs/oss-quickstart.md) and [main README](README.md) for boundaries.
