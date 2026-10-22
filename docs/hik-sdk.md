# Opt-in Hikvision SDK playback

This experimental Linux x86-64 transport uses Hikvision HCNetSDK by-time recording downloads for explicitly commissioned recorder UUIDs. It does not replace the shared preview/export admission and cancellation controls. No recorder is enabled by its display name or IP address.

## Supported bounds and accuracy

- Preview requests are limited to 30 seconds; exports are limited to one hour.
- SDK requests use the recorder's local wall-clock time. Keep the application's timezone aligned with the recorder.
- SDK by-time output can start on a keyframe and include extra material. Its timing label is `unverified-keyframe`.
- A requested range, an apparently plausible duration, or an OSD observation alone does not prove frame-accurate wall-clock boundaries. Do not present this transport as an exact-time export.
- A failed or unsupported SDK request must remain an explicit failure; it must not silently switch to another recording transport.

## Pinned, local release provisioning

The SDK is vendor-licensed software and is not checked into this repository. Obtain and accept the vendor's applicable license separately. This packaging step only consumes an already obtained local archive; it does not download, log in to a recorder, execute SDK binaries, or start/restart services.

Approved archive:

- Hikvision Linux64 HCNetSDK V6.1.9.4 build20220412
- Size: `68211785` bytes
- SHA256: `964bd4d4e470aa6865c2c50d8c149753452a1853a070cbd435f91fb19c1e6d35`
- Extracted subtree: `EN-HCNetSDKV6.1.9.4_build20220412_linux64/lib/`

Use the low-level command with a fresh local stage, an archive obtained under the vendor license, and the intended recorder UUID:

```sh
python3 /absolute/new-release-stage/scripts/stage-hik-sdk.py \
  --archive /absolute/private/approved-vendor-archive.zip \
  --destination /absolute/new-release-stage/hik-sdk \
  --device-id 11111111-2222-4333-8444-555555555555
```

Repeat `--device-id` only for additional explicitly approved recorders. Credentials, addresses, cookies, and account state are neither accepted as arguments nor written to the manifest. The manifest contains only the profile, platform, archive SHA256, and explicit device UUID list. Only the library subtree is extracted, with duplicate paths, traversal, symlinks, and special archive members rejected. Existing destinations are never intentionally replaced. A size/hash mismatch leaves no installed SDK directory.

Review the prepared artifact and device scope before any manual installation. This source snapshot contains no native publishing workflow or private deployment wrapper. The staging script grants no service, permission or publication authorization.

## Runtime activation

`scripts/native-start.js` reads only its own release's `hik-sdk/manifest.json`. It validates the exact profile, pinned archive identity, platform, nonempty unique lowercase UUID list, and fixed release-local library location. Unknown manifest fields, path overrides, malformed scopes, and symlinked profile/library roots are rejected.

The SDK is disabled unless `HIKCLIP_PREPARATION_ONLY=0` and the valid release profile is installed. `HIKVISION_SDK_ENABLED=0` explicitly keeps it disabled even in a commissioned release. The launcher clears inherited `HIKVISION_SDK_DIR` and `HIKVISION_SDK_DEVICE_IDS`; only the reviewed manifest can populate the absolute release-local library directory and comma-separated UUID allowlist. A missing profile remains disabled. Commissioning does not authorize a device that is absent from the manifest.

## Verification and remaining acceptance work

Offline checks:

```sh
node --test test/sdk-runtime-profile.test.js test/native-start.test.js
```

These exercise safe archive selection with generated fixtures, pinned archive rejection, explicit UUID scoping, preparation-mode suppression, inherited-environment suppression, explicit disablement, invalid manifests, and library/profile symlink rejection. Fixtures do not substitute for testing the actual vendor archive or SDK/device behavior.

Real-app acceptance remains pending for the integrated release until recorded separately:

| Check | Required evidence |
| --- | --- |
| Approved vendor archive staging | Exact size/hash passes; staged libraries visible in the published service namespace |
| Recorder discovery | Correct explicit recorder UUID, SDK management port, and main-stream input channel |
| Preview | A bounded preview plays in the real application; no second preview/export session bypass |
| Export | A bounded export reaches the common terminal task state and playable MP4 output |
| Limits/errors | Over-limit ranges, SDK errors, unsupported media and missing recording fail clearly |
| Cancellation | Worker, download session and temporary output settle before the shared gate is released |
| Timing | Requested and measured range recorded honestly as `unverified-keyframe` |
| Regression | Existing non-SDK previews/exports and application UI remain functional |

Do not claim that passing offline tests validates any unexecuted real-recorder or UI behavior.
