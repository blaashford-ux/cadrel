# Building and releasing

## Day to day

```
npm install
npm run typecheck
npm test                       # unit + integration; GUI tests run only where Electron and Chromium can start
xvfb-run -a npm test           # on Linux without a display
npm run start -w @cadrel/market-desktop
```

Tests that need a browser or window skip themselves when none is available. `BOOKSCOUT_PERF=1 npx vitest run --root packages/library test/perf.test.ts` runs the scale check (see `docs/performance.md`).

## The installed app

`npm run pack -w @cadrel/market-desktop` builds the app into `packages/desktop/release/` without an installer (on Linux: `linux-unpacked/bookscout`). To run the whole app suite and the walkthrough against that build:

```
BOOKSCOUT_PACKAGED_BIN=$PWD/packages/desktop/release/linux-unpacked/bookscout xvfb-run -a \
  npx vitest run --root packages/desktop test/app.e2e.test.ts test/walkthrough.e2e.test.ts
```

This proves the native pieces (SQLite vector extension, image library, OCR, PDF reader) load from inside the installed layout, and that the MCP setting the app produces launches a working server with the app's own Node. CI runs it on every push.

## The Windows installer

The installer must be built on Windows (native modules differ per platform): run the **Release** workflow (Actions tab, or push a tag like `v0.1.0`). It runs the tests, builds `BookScout-Setup-x.y.z.exe` and `bookscout-extension.zip`, uploads them as artifacts and, for a tag, attaches them to a GitHub release. Locally on Windows: `npm run dist -w @cadrel/market-desktop`.

**Not verified in the build environment used so far:** the NSIS installer itself and a Windows run (the packaged layout was verified on Linux with the same configuration). Before sharing a build, install it on a clean Windows machine and walk through `docs/user-guide.md` sections 1-3.

The installer is **not code-signed**; Windows SmartScreen will warn. To sign, add a certificate to the workflow (`CSC_LINK`, `CSC_KEY_PASSWORD` secrets) and electron-builder signs automatically.

## Version bump checklist

1. Set `version` in `packages/desktop/package.json` and `packages/extension/manifest.json`.
2. Update `docs/plan.md` progress notes if behaviour changed.
3. Tag `vX.Y.Z` and push; download the artifacts; smoke-test on Windows.

## What ships where

| Part | Where it ends up |
|---|---|
| App code, parsers, analysis, MCP server | `resources/app.asar` (`dist/main.mjs`, `dist/mcp.mjs`) |
| Native libraries and OCR data | `resources/app.asar.unpacked/node_modules/...` |
| Browser extension | `resources/extension/` (to load unpacked) and `resources/bookscout-extension.zip` |
| Settings, token, logs | `%APPDATA%\BookScout\` (`config.json`, `token`, `logs\bookscout.log`) |
| Your data | the library folder you chose |

## Updates

There is no auto-update. A new installer upgrades in place; the library is untouched and its index migrates on first open (the schema is versioned).
