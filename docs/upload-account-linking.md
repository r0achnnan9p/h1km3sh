# Console upload account linking

Account linking is a separate capability from upload enablement and individual upload submission. A successful QR login never enables a worker or submits a video.

## Supported, pinned tools

- Bilibili: biliup v1.2.2, QR-only interactive login
- China Telecom Cloud: gowsp/cloud189 v0.7.0, QR-only token configuration
- Linux with Python 3 and POSIX flock/PTY support

Managed releases install hash-checked tools using `config/upload-tools-pins.json`. The server verifies the installed manifest and binary hashes before permitting an authentication child. No binary is downloaded by an HTTP request.

`HIKCLIP_MANAGED_UPLOADS_ENABLED=1` permits the managed capability; it does not turn on either provider. `HIKCLIP_UPLOAD_ACCOUNT_LINKING_ENABLED` can explicitly override linking availability. Preparation-only and recovery-blocked instances refuse account changes. The UI must disclose that QR authorization saves login tokens to this server for uploads, and require an explicit connection action. Replacing saved credentials requires `replace: true` after a clear user confirmation.

## Account endpoints

All endpoints are under `/console/api/upload-accounts`, admitted only by the authenticated console gateway. Writes require the matching session CSRF token and the configured HTTPS Origin. A direct request to the local application cannot manufacture the internal owner identity.

- `GET /`: sanitized account list, `csrfToken`, and `reauthRequired`
- `POST /:provider/start`: JSON `{}` or `{ "replace": true }`
- `GET /:provider/status?attemptId=UUID`: status for the current session's attempt
- `GET /:provider/qr?attemptId=UUID`: authenticated, non-cacheable PNG
- `POST /:provider/cancel`: JSON `{ "attemptId": "UUID" }`
- `POST /:provider/verify`: JSON `{}`; read-only provider verification, allowing token-only refresh into staging
- `POST /:provider/disconnect`: JSON `{}`; delete only the application's fixed provider credential file under the account-operation lock

Providers are exactly `bilibili` and `cloud189`. Status includes only enumerated states, timestamps, availability/credential-presence booleans, a random attempt ID, QR readiness, and fixed error codes. Never return account tokens, cookies, raw CLI/provider output, or server paths.

Attempts expire after 300 seconds, belong to one server-verified browser session, and run at most once per provider. Cancel, logout, session expiry, preparation/recovery changes and shutdown stop the child process group and discard staged credentials/QR data. A generation check immediately before atomic promotion prevents stale success from a cancelled attempt replacing current credentials.

New explicit console logins issue independently random nonce-bearing v3 cookies. Existing valid v2 cookies retain their original expiry for normal console use; they are not silently extended or migrated. Account mutations ask a v2 owner to log out and log in once. Account listing indicates this with `reauthRequired: true`. Logout revokes the v3 nonce before cancelling attempts, and every mutation rechecks the still-active owner after receiving its body and after waits. Revocation is an in-memory denylist for the current gateway process, not a durable session revocation store: a service restart clears it. Rotating the session secret or password remains the persistent revocation mechanism.

## Storage and locking

App-managed credentials live at `HIKVISION_DATA_DIR/private/upload-accounts/bilibili.json` and `cloud189.json`, outside public downloads. Staging directories are 0700; files are 0600. The Python wrapper sets umask 077 and uses an environment allowlist without `189_MODE` or inherited application secrets. Cloud QR starts with a newly created empty config, never a copied legacy password-bearing config. Credential validation rejects any `user`/`User` entry.

The shared operation lock is `downloads/{biliup_work|cloud189_work}/provider.lock`. Login, verify, credential promotion, disconnect and uploader operations use this same flock inode. Worker singletons use a separate `worker.lock`. Lock descriptors are inherited by children, and lock files are never unlinked. The authentication wrapper retains its lock until the server has validated and atomically promoted credentials, then acknowledges release.

Bilibili verification calls only the fixed read-only my-info endpoint and checks the returned account ID against the credential. It never runs `renew`, which can log refreshed credentials. Cloud verification runs fixed `--json df /` against a staging copy; only an exit-zero, shape-validated response permits refreshed credentials to replace the live file.

The cloud QR proxy accepts only `https://open.e.189.cn/api/logbox/oauth2/image.do` with exactly `REQID` and `uuid`, bounded URL/query values, no userinfo/fragment/custom port, and no redirects. It enforces an eight-second deadline, 256 KiB PNG bound and image dimensions. Bili's QR is read only from the current private attempt's fixed `qrcode.png` file, with no symlink following.

## Upload settings and cover

Settings add explicit `managedEnabled`, `bilibiliEnabled` and `cloud189Enabled` booleans, all defaulting false, plus nonnegative safe-integer `bilibiliSeasonId`/`bilibiliSectionId` (zero means unset). Existing environment collection IDs remain defaults only until settings are explicitly saved. Positive numbers alone do not establish account ownership. Before the remote-start checkpoint, the Bili worker checks the live account identity, finds the selected season in that account's authenticated management list (at most ten pages), matches its owner and section, and requires normal/not-forbidden/approved states. Missing or unknown fields fail closed, including new collections still reporting review status 0. This is conservative read-only ownership/eligibility validation, not a promise that a later write will succeed; the platform can change permissions meanwhile. No mutation is used as a permission probe. The private-only, football-tag/category rules remain mandatory.

A user-selected default cover is uploaded with authenticated/CSRF-protected `PUT /console/api/settings/bilibili-cover`, raw PNG or JPEG, at most 5 MiB, at most 8192 pixels per edge and 25 million pixels. The server checks magic and dimensions and atomically writes a private, fixed-name file. `GET` returns a non-cacheable image; responses expose only `{present, source}`, never a path. Existing server-configured cover remains a fallback. Missing cover or collection configuration keeps Bili disabled. Readiness is immediately clamped by current settings, saved credentials and supervisor state, so an old worker heartbeat cannot reopen a disabled/disconnected provider.

## Verification limits

Automated tests use local fake executables to exercise the actual Python PTY/subprocess wrapper, QR selection, private file permissions and protocol filtering. They do not perform real account authorization. First deployment still needs owner-operated QR authorization with each pinned CLI and platform-side collection verification; a unit-test pass is not evidence that the provider accepted a live login or upload.

Source contracts:

- https://github.com/biliup/biliup/blob/v1.2.2/crates/biliup-cli/src/uploader.rs
- https://github.com/biliup/biliup/blob/v1.2.2/crates/biliup/src/uploader/credential.rs
- https://github.com/biliup/biliup/blob/v1.2.2/crates/biliup/src/uploader/bilibili.rs
- https://github.com/gowsp/cloud189/blob/v0.7.0/internal/invoker/qr_login.go
- https://github.com/gowsp/cloud189/blob/v0.7.0/internal/invoker/config.go
- https://github.com/gowsp/cloud189/blob/v0.7.0/pkg/app/api.go

## Account replacement and queued work

Each explicitly saved QR connection receives a fresh private connection-generation sidecar. Verify/token refresh preserves that binding; disconnect invalidates it. Managed enqueue obtains the generation from the server, never from request data. Managed workers compare it under the provider/job locks before upload, receipt reconciliation or collection recovery. A missing or different binding fails closed with `ACCOUNT_CHANGED`; old queued work needs a new explicit submission and is never rebound to the new account. Completed history is preserved.

Before replacing/removing credentials, the server durably disables the provider switch and marks old pending jobs as requiring fresh confirmation. It then durably writes an invalid generation under the retained provider lock, promotes and fsyncs the validated credential, and only then writes/fsyncs the new generation. An interrupted replacement therefore cannot make old-generation work eligible for newly saved credentials. The sidecar is separate from the CLI config so a token-refresh rewrite cannot remove or change the binding. Connecting, replacing or disconnecting never automatically enables uploads.

Process-group cleanup retains group identity and its escalation deadline independently of leader exit, including a spontaneous worker crash. A replacement worker is held until cleanup completes. Exit-time cleanup sends SIGKILL to remaining tracked groups; the native systemd cgroup remains the deployment-level backstop.

The ownership response schema is an unofficial original API capture, not a Bilibili compatibility guarantee:
https://github.com/pskdje/bilibili-API-collect/blob/main/docs/creativecenter/season.md
