# Managed uploader profile

An optional operator-prepared native release can package biliup **1.2.2** and **gowsp/cloud189 0.7.0** under `upload-tools/`. `config/upload-tools-pins.json` pins exact upstream release URLs, archive hashes, and executable members. `scripts/install-upload-tools.py` can run locally as a non-root operator during separate release preparation; it checks the archive, extracts only the selected regular executable, retains bundled license notices, and records an executable SHA256 in `upload-tools/manifest.json`. It never executes either CLI, reads user credentials, starts services, or changes system permissions. A bad download/hash/member prevents packaging. This source snapshot has no publication automation.

The native launcher advertises `HIKCLIP_MANAGED_UPLOADS_ENABLED=1` only for an installed `managed-uploads-v1` manifest in commissioned mode. An explicit environment value `0` disables the capability. Preparation mode always disables it. This capability is not account authorization or an upload request. Authenticated Settings must explicitly enable each provider, with no auto-enable after connecting an account.

## Runtime contract

`createManagedUploadSupervisor({releaseRoot,dataDir,downloadsDir,getState})` exposes `start()`, `reconcile()`, `stop()`, and sanitized `status()`. `start()` reconciles immediately and every five seconds. `getState()` returns:

- `preparationOnly: false`, `recoveryReady: true`, `managedEnabled: true` (derived from installed server capability, not a user toggle) before workers may run
- `cloud189: {enabled: true}` only when account-derived readiness is true
- `bilibili: {enabled: true, seasonId, sectionId, coverPath}` with positive integer collection/section IDs and a real server-owned cover

Credentials are fixed to `data/private/upload-accounts/bilibili.json` and `cloud189.json`. Never put them in a release, Git, CI variables, browser storage, downloaded artifacts, or logs. QR authorization and credential promotion are owned by the account-linking module. New credentials must originate from the new account-linking flow, never copied from another deployment's state.

Both workers use the existing app identity and service cgroup. The supervisor imports raw `child_process.spawn`; it must not inherit the NVR export lease via `spawnExportProcess`. Children get a small allowlisted environment and private HOME; application passwords, MCP tokens, proxy/debug variables and provider credentials are not placed in argv or inherited environment. No new systemd units, sudo grants, service users or listening ports are needed. The actual unit must retain `UMask=0077`, `KillMode=control-group`, `NoNewPrivileges=yes`, and write access only to the existing state root.

The provider singleton is `downloads/{biliup_work|cloud189_work}/worker.lock`. The shared account-operation lock is `provider.lock` in that same directory. Login, account verification/promotion, uploads and upload reconciliation must use the latter. The Python workers inherit singleton, account-operation and job lock descriptors into CLI processes, preventing replay while a surviving child still owns a lock. Never unlink these lock files. Do not run managed workers alongside separately installed worker services.

Disabling a provider or removing credentials stops its process group. Changes to a running worker's collection/cover settings yield `restart_required` rather than unexpectedly interrupting an upload; an explicit disable/re-enable applies them. App restart can interrupt transfers. Existing ambiguity checkpoints remain `unknown` and cannot automatically re-upload. Stop the supervisor during app shutdown; the existing systemd cgroup is the final descendant cleanup boundary.

## Cloud189 adapter

The managed backend sets `CLOUD189_BACKEND=gowsp` and `CLOUD189_CONFIG_FILE`. The legacy tickstep invocation remains available only outside this managed profile for compatibility. Machine commands are:

- Account readiness: `--config PRIVATE_FILE --json df /`
- Destination check: `--config PRIVATE_FILE --json stat FULL_REMOTE_PATH`
- Upload: `--config PRIVATE_FILE --json up --input LOCAL_MP4 --path FULL_REMOTE_PATH --policy skip`

The adapter rejects any existing destination before uploading, even if its size matches. Upstream `skip` can report success for an existing same-size file without comparing contents. A successful managed receipt requires the expected remote path/name/size, a nonempty numeric file ID, matching MD5, and a second `stat` with the same file ID and checksum. Missing checksums and failures after the remote-start checkpoint remain `unknown`; do not retry blindly. Only local/preflight failures proven to precede upload may retry.

Bilibili keeps the existing football tag/category, private submission option, and mandatory collection handling. QR login is not permission to remove those gates, set arbitrary positive IDs, or upload a video. Settings must establish the account/section relationship separately. Actual upload verification still requires a specifically authorized test file.

## Upstream sources and verification scope

- [biliup 1.2.2](https://github.com/biliup/biliup/releases/tag/v1.2.2)
- [cloud189 0.7.0](https://github.com/gowsp/cloud189/releases/tag/v0.7.0)
- [cloud189 command contract](https://github.com/gowsp/cloud189/blob/v0.7.0/internal/cmd/up.go)
- [cloud189 skip behavior](https://github.com/gowsp/cloud189/blob/v0.7.0/pkg/drive/drive.go)
- [cloud189 QR/token behavior](https://github.com/gowsp/cloud189/blob/v0.7.0/pkg/app/login.go)

This implementation is covered by mocked installation, process supervision, account/job locking, collision, receipt, recovery and native profile tests. Those tests perform no login or upload and do not prove current platform compatibility. Check real QR login and a separately approved upload after deployment. The old fresh-upload setup archive with two root-owned units is superseded for the managed profile and must not be installed alongside it.

The global upload switch is removed. Existing `managedEnabled: false` settings normalize to available; all user upload switches are removed. Runtime readiness still requires account credentials, a connection-generation binding, no active account change, and required target/cover configuration. Account changes stop workers before credential promotion and quarantine old jobs; only explicit upload requests create new jobs. No queue entries are created by this migration.
