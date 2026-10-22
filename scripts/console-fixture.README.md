# Synthetic console QA fixture

## Static browser bundle

```sh
node scripts/build-console-fixture.js
# Optional output directory: node scripts/build-console-fixture.js /absolute/path/to/dist
node --test test/console-fixture-browser.test.js test/console-fixture.test.js
```

The `fixture-dist/` output is a self-contained static bundle for separately authorized public QA hosting. It contains the actual current console HTML and public assets, the supplied synthetic `demo.mp4`, a conspicuous synthetic-data warning, and an isolated browser runtime that intercepts fixture API requests and SSE. No production source is modified and the build does not publish anything. Rebuild after frontend edits.

The static build adds a content-derived `?v=` query to local CSS/JavaScript HTML references, local module imports/re-exports (including literal dynamic imports), and CSS imports/stylesheet URLs. One SHA-256-derived bundle version covers the complete sorted original CSS/JavaScript payload set, generated HTML, and builder implementation. Thus a dependency-only edit changes both its own URL and every importer URL, including cyclic module graphs; changing the rewriting implementation also invalidates the version. This deliberately invalidates more assets than a per-file dependency graph. Neither the build timestamp nor output directory enters the hash, so repeated identical builds are byte-identical except `fixture-info.json`'s `generatedAt`. Source files are never rewritten. Existing query parameters and fragments are retained. External references are unchanged. Missing local CSS/JavaScript dependencies, computed dynamic imports, and dynamic imports embedded inside interpolated template strings fail the build rather than silently escaping cache versioning.

Each browser tab owns its in-memory data. Reload resets every simulated mutation. The same scenario links below apply. Replay URLs are redirected to the packaged synthetic clip. Upload-account APIs return `unavailable` by default. Never enter real credentials into the demo.

For account UI review, open `?fixture=normal&accounts=demo#settings`. The provider connectors then offer fake in-memory attempts and display a non-login graphic labeled **演示二维码，不可登录**. The fixture-only controls at the top manually switch an active attempt to waiting for scan, phone confirmation, verification, connected, expired, error or needs-login. These controls move inside an open account dialog so the browser's modal background lock does not block them. Start/status/cancel/verify/disconnect are mocked; replacing an existing simulated connection requires `replace: true`. Verification never automatically claims success. First generate an example code in settings, then use the controls; polling displays the selected state. No real provider is contacted and no credentials are saved.

The dedicated static tests cover injected script order, preserved real assets, path-prefix playback, SSE, empty/error/auth states, unavailable account APIs, export/gap/completion, upload/rename/delete and configuration/settings writes with no API network fallback.

### Task order and account-status review

The seeded task arrays deliberately mix creation times and statuses. In each list,
newest tasks appear first, including completed cards without an expansion step.
Timestamps use Beijing wall time and do not change when a task completes.

For browser-only account-state QA, add one of these synthetic query options:
- `&accounts=reauth#settings`: old control-panel session, existing fake credentials,
  explicit re-login action; this must not be presented as a disconnected account
- `&accounts=unauthorized#settings`: account read returns 401; show the re-login action
- `&accounts=read-error#settings`: account read returns 503; show unknown status and retry

These fixed error modes remain in effect until reloading with another query value.
No real login, credentials, or provider requests are used.

### Managed uploads and cover review

Both fixtures include `managedEnabled`, `bilibiliEnabled` and `cloud189Enabled` (all false by default), plus integer `bilibiliSeasonId` and `bilibiliSectionId` (both zero by default). B 站 upload requires positive collection/section IDs and a cover. These are format checks only; the fixture never claims to validate collection ownership. Add `&settings=ready` for synthetic enabled settings with example positive IDs.

Settings responses include top-level `cover: { present, source }`, with a synthetic one-pixel PNG by default. Add `&cover=missing` to test missing-cover setup. The raw PNG/JPEG PUT endpoint `/console/api/settings/bilibili-cover` checks CSRF, MIME/signature and a 5 MiB size limit; authenticated GET returns the image. Static mode retains uploaded bytes only as a per-tab Blob and rewrites image previews to its local object URL. Local-server mode retains bytes only in session memory. No cover file is persisted or uploaded to a provider.

In opt-in account demo mode, verify returns a `verifying` attempt and awaits a manually simulated result; it never silently reports login success. Disconnect returns an asynchronous attempt and then clears only the fake in-memory credential marker.

## Local API server

Run from this repository:

```sh
node scripts/console-fixture.js
# Optional: CONSOLE_FIXTURE_PORT=8788 CONSOLE_FIXTURE_MEDIA=/absolute/path/to/synthetic.mp4 node scripts/console-fixture.js
node --test test/console-fixture.test.js
```

Open `http://127.0.0.1:8787/?fixture=normal`. The CLI binds only to loopback. The default video is the supplied synthetic `/workspace/shared/prototype-assets/demo.mp4`; override it only with another synthetic file. Missing media produces a clear 503 rather than falling back to real video.

## Safety boundary

- Serves the actual `statusDashboardPage()` HTML and current whitelisted `public/` assets
- Does not import `server.js`, production device/config stores, MediaMTX, export queues, upload workers, or any credential reader
- No outgoing requests, subprocesses, real device operations, filesystem writes, uploads, or file deletion/renaming
- All mutations affect session-local memory. Rename/delete only change in-memory records; exports add another reference to the same synthetic MP4
- Mock recorder addresses use reserved documentation IPs; mock service URLs use `.invalid`
- Passwords are never retained or logged. Do not enter real credentials. The fake password is `fixture-demo` (satisfies the real UI’s eight-character minimum); the fake setup code is `demo`
- This is a test harness, not a production server or security implementation. Do not route production traffic to it

## Scenarios

The root `fixture` query chooses a fresh scenario and resets that browser's session. Reloading without the query retains the session. A new scenario replaces the cookie for all tabs in that browser profile, so use one scenario at a time or separate profiles.

- `/?fixture=normal`: three cameras, one DVR, four recording bands with gaps, three outputs, mixed active/queued/error/completed tasks, upload activity, settings and cache
- `/?fixture=empty`: no cameras, DVRs, recordings, outputs, jobs or cache
- `/?fixture=error`: bootstrap 503 and boot/retry UI
- `/?fixture=auth`: fake expired login; no real authentication operation
- `/?fixture=setup`: fake initial setup
- `/?fixture=recordings-empty`: populated console with no recordings
- `/?fixture=recordings-error`: recording-list request 503
- `/?fixture=media-error`: video request 503 for preview/retry testing
- `/?fixture=upload-error`: upload submission fails and retains the output
- `/?fixture=config-error`: configuration fetch fails
- `/?fixture=config-conflict`: first configuration write returns 409; reload/review/retry works
- `/?fixture=preparation`: source configuration is read-only
- `/?fixture=slow`: bootstrap delayed 2.5 seconds for loading-state QA

Add `#library`, `#tasks`, or `#settings` to open a specific panel, e.g. `/?fixture=normal#library`.

`GET /__fixture__/info` reports the current scenario, available scenarios, synthetic-media availability and method/path-only mutation history. Request bodies are deliberately excluded.

## Useful interactions

All days contain the same synthetic footage bands in Beijing wall time: 08:00–09:20, 09:24–10:50, 12:00–14:00, 18:00–21:00. The first four-minute gap is useful for consent testing.

- Export 08:00:00–08:01:00 for a normal export
- Export 09:19:00–09:25:00 for the gap warning; accepting gaps creates an output marked `含缺口`
- Export 01:00:00–01:01:00 for a no-footage error
- A newly submitted export/upload progresses from queued to 25/65%-style progress to completed over three seconds; seeded tasks remain stationary for repeatable screenshots
- Cancelling a newly queued export prevents completion
- Rename, duplicate-name failure, upload, busy protection and delete work on synthetic output records
- Settings use the same CSRF-header contract; source configuration uses revision checks and supports add/edit/delete/mapping/test/snapshot interactions. The snapshot is a harmless one-pixel placeholder, not a camera frame
- SSE emits state updates plus quiet keepalives, so idle browsing does not display spurious reconnect banners
- Preview/output streaming supports byte ranges, but the file is short synthetic media, not an accurate rendition of the requested wall-clock interval

## Hosted wrapper

If separately authorized for synthetic browser QA, a hosting wrapper can import `createConsoleFixture` from `scripts/console-fixture.js`, then mount its returned `.app` on the hosting server. Supply a packaged synthetic MP4 using `{ mediaPath: absolutePath }`, and call `.close()` during shutdown. No hosting or publishing occurs from this script. Preserve the `public/` files and `lib/status-dashboard.js` relative to the script.

## Verification

The dedicated Node tests cover real shell/assets, missing production routes, synthetic byte-range streaming, scenarios, recording gaps, export completion/cancellation, rename/upload/delete, config and settings writes, revision/CSRF handling, SSE, same-origin checks and cache cleanup. They run entirely against temporary local fixtures. Actual browser layout, responsive behavior and media decoding still require browser QA; passing these tests does not claim NVR or upload-provider integration coverage.

### Cloud189 result verification QA

The normal fixture and verification scenarios include the synthetic UNKNOWN job
`00000000-0000-4000-8000-000000000189` with `uploadPhase: remote_started`.
Use the current console implementation containing the `核实结果` action, then open:

- `?fixture=cloud-verify-success#tasks`: verification completes the existing job
- `?fixture=cloud-verify-unknown#tasks`: `CLOUD_FILE_NOT_FOUND`; the same job remains UNKNOWN and can be checked again
- `?fixture=cloud-verify-pending#tasks`: the request waits six seconds, then completes the same job; check the disabled `正在核实…` button, repeated clicks, and navigation away/back while pending
- `?fixture=cloud-verify-error#tasks`: HTTP 503; the job remains UNKNOWN and the button becomes available again

All checks run only in session/tab memory. They do not read source files, load
account credentials, invoke provider workers, or enqueue another upload. Successful
verification marks the existing job completed in the same chronological list;
no history expansion is needed to inspect it. Reload restores the UNKNOWN fixture.
The default verification response delay is 350 ms. The normal scenario uses the
success result. Fixture responses preserve production validation for CSRF, UUID,
empty request object, and eligible job state; duplicates return `VERIFY_BUSY`.
Logging out while a response is pending leaves the original UNKNOWN job unchanged.

For automation, browser `window.__consoleFixture.inspectVerification()` returns
only synthetic accepted requests and pending job IDs; the server exposes the same
metadata at `/__fixture__/info`. Compare upload IDs before/after to establish that
no job was enqueued. These fixture tests do not claim real provider verification.

### Cloud189 unknown-result recovery QA

`?fixture=cloud-recovery&settings=ready#tasks` links the UNKNOWN upload to the first
synthetic library MP4. All steps below only mutate tab/session memory:

- The library labels it `上传待核实`, offers `处理上传记录`, and permits B 站 upload
- `移除记录` asks once, retains UNKNOWN, and releases the file for rename
- Rename the released MP4, then `恢复记录`; the same recovery job follows its local
  source while retaining the original remote filename
- `重试上传` requires explicit confirmation; it preserves the original UNKNOWN in
  attempt history and changes that same fixture job to queued, without adding an
  unrelated second task
- A normal cloud upload of the unresolved source is rejected even after rename;
  the existing job's explicit recovery is the available next step
- `cloud-verify-error` exercises request failure; `cloud-verify-pending` exercises
  the disabled action buttons and logout while a request is pending

The production retry rechecks account binding, unchanged local source and current
remote absence under inherited provider/job locks. A matching existing remote file
is reconciled instead of reuploaded. The fixture simulates this outcome only; it
never contacts a provider, reads credentials or transfers a real video.
