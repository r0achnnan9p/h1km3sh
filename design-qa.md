# Focus replay design QA

## Review result

**blocked** — exact target-device visual verification remains unavailable. This is a visual-verification limit, not a claim that the implemented interface failed its interaction tests.

## Approved reference and scope

The selected third prototype, “专注回看”, is the layout reference. The latest requested changes take precedence: portrait and landscape target the iPhone 14 Pro Max; date navigation uses larger single arrows; the separate gap button is removed; every export gap shows start, end and duration; landscape retains range controls and hides all chrome when idle.

The implementation uses one DOM tree across viewports. Source/channel/date stay above the player, playback tools and the thin timeline sit together, and the watch/select switch only changes presentation. Precise time entry belongs to the corresponding in/out field. Clear and export share the range action row. Existing project tokens, icons, typography and media behavior are retained.

## Evidence collected

- Target viewport contracts: 430×932 portrait and 932×430 landscape, plus non-immersive 960×700 and desktop widths.
- Actual controller integration tests cover mode changes without changing marks or media position, both fullscreen paths, first-tap wake without export, keyboard focus, dialogs, inputs, and lifecycle cleanup.
- Gap integration tests cover every disjoint range, millisecond duration precision, cached and server-discovered gaps, cancellation, stale context, repeated submissions and the single export queue.
- Safe-area tests retain the shared viewport height, bounded status-bar clearance, keyboard isolation and exactly one inset calculation.
- Static module access and public-diff privacy checks are included in the release review.

## Remaining visual verification

The available browser session does not expose a target viewport resize capability. The local supervised preview could not start because its runtime could not mount the required process filesystem. No alternate browser protocol, security bypass, or fabricated device screenshot was used.

Exact 430×932 / 932×430 screenshots and physical iOS home-screen behavior therefore remain unverified. The viewport contract and programmatic tests must not be described as device screenshots or real-device acceptance. The live application can still receive a smoke check at the browser's available desktop viewport after publishing.

No private configuration, deployment address, account data, recording image, or service log is included in this report or the public patch.
