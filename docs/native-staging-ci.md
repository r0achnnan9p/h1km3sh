# Local verification of native source

This source-only snapshot deliberately contains no GitHub Actions, self-hosted runner configuration, native publisher or automatic release. Run checks locally in an isolated checkout with Node.js 24:

```sh
npm ci --omit=optional --ignore-scripts
node --test test/oss-packaging.test.js test/native-start.test.js test/native-listener.test.js test/sdk-runtime-profile.test.js
npm test -- --test-concurrency=2
```

Record actual failures, skipped platform checks and missing tools. Tests do not authorize deployment or replace real browser/recorder acceptance. See [native profile](native-staging.md).
