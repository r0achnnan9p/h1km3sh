# Contributing to H1kM3sh

Thanks for your interest in improving the MediaMTX/DVR recording console.

- File focused issues with the MediaMTX version, browser, recording format or (if applicable) DVR firmware. Never include credentials, private footage or unredacted logs.
- Describe the change and its user-visible behavior in PRs; add targeted tests when feasible.
- For Node.js 24 development: install dependencies with **npm ci --omit=optional --ignore-scripts** and run **npm test -- --test-concurrency=2**.
- State the platforms actually verified. Browser simulations do not replace a real iPhone or DVR/recording smoke test.
- Keep self-hosted runners, native deployment automation and sensitive environment setup out of unrelated changes.
- Report security issues privately via [SECURITY.md](SECURITY.md).

This is an independent community project, not affiliated with MediaMTX or Hikvision.
