# Third-party licenses and attributions

The root [MIT license](../LICENSE) applies to the original H1kM3sh code. It does **not** relicense bundled third-party assets or separately installed binaries.

| Component | Location | License / notice |
| --- | --- | --- |
| MediaMTX browser reader (adapted) | public/mediamtx-reader.js | MIT; see [preserved license](./mediamtx-reader.LICENSE) |
| Radix Icons (SVG assets) | PWA UI | MIT; see [preserved license](radix-icons-LICENSE.txt) |
| JetBrains Mono font | public/fonts/jetbrains-mono.woff2 | SIL OFL 1.1; see [bundled license](./jetbrains-mono-OFL.txt) |
| FFmpeg, platform libraries | Operator-installed system packages | Subject to the respective binaries and distribution licenses |
| Optional Bilibili and cloud189 upload tools | Downloaded by optional managed profile | Follow separate upstream licenses; pinned notices under config/upload-tool-notices |
| Optional Hikvision HCNetSDK | Obtained separately by the operator | Proprietary vendor license; SDK binaries are not included |

Please preserve these original licenses when redistributing packaged variants. Build-time third-party dependency licenses still require normal compliance checks.

## Source-only distribution and optional dependency scope

This snapshot contains no FFmpeg, ffprobe, Node.js, HCNetSDK or upload-tool executable. The pinned lockfile records optional `ffmpeg-static@5.3.0` as **GPL-3.0-or-later**, not MIT. The optional transitive `parse-cache-control@1.0.1` entry lacks license metadata in this lockfile; its license and redistribution terms must be verified before including that dependency. A lockfile field alone does not establish the license of downloaded FFmpeg/ffprobe binaries or system packages.

The local source install instructions use `npm ci --omit=optional --ignore-scripts` with operator-supplied FFmpeg/ffprobe to avoid installing these optional binary packages. Portable/SEA builds, managed upload tools and any future binary distribution require their own complete dependency/binary license review and notices. No claim that the full dependency tree or binaries are MIT is made. Original code and asset release rights require maintainer confirmation; this notice is not legal assurance.
