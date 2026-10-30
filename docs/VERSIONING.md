# Release versions

Every release of cadrel has a version number in the form **`MAJOR.MINOR.FIX`**, for example `0.4.2`. The three parts are always in this order, and the current one lives in the [`VERSION`](../VERSION) file.

| Part | Position | Raise it when | Resets |
|------|----------|---------------|--------|
| **Major** | `1`.0.0 | A big change: something people relied on works differently, or is removed, or the product is reworked. | Minor and Fix go to `0` |
| **Minor** | 0.`1`.0 | A new capability that does not break what was there. | Fix goes to `0` |
| **Fix** | 0.0.`1` | Bug fixes and small feature fixes: corrections and polish to what already exists. | nothing |

Examples: `0.1.0` → `0.1.1` (a bug fix) → `0.2.0` (a new capability, fix resets) → `1.0.0` (a major change, minor and fix reset).

## Rules

- Format is exactly three whole numbers separated by dots. No `v` in the file, no leading zeros, no suffix (`1.02.0` and `1.2.0-beta` are rejected). Each part can go past 9 (`0.10.0` comes after `0.9.0`).
- Versions only go up. A version is never reused or edited after it is released.
- Every merge into `main` is a release, so the pull request must raise `VERSION`. CI blocks the merge if it does not.
- Raise only one part per release, the largest that applies. If a release has both a new capability and a bug fix, it is a Minor.
- Record what changed under the new number in [`CHANGELOG.md`](../CHANGELOG.md), newest first.

## Cadrel Reader has its own version

**Cadrel Reader** (`packages/reader`, the app beta readers install) is released apart from Cadrel, so either can be updated without the other. Its version lives in [`packages/reader/VERSION`](../packages/reader/VERSION) and follows the same rules (three numbers, only upward, one part per release). Its tags are `reader-vX.Y.Z` (and `reader-vX.Y.Z-dev.N` for development builds), and `scripts/check-reader-version.sh` is its `check-version.sh`.

- A change that touches `packages/reader` or `packages/write` (the code Reader is built from) must raise Reader's version before it merges to `main`. A change that touches neither leaves it alone.
- A change that touches only `packages/reader`, the docs or Markdown files is not a release of Cadrel, so Cadrel's `VERSION` does not need to rise (a change to `packages/write` or anything else still does).
- Reader's releases are never marked "latest" on GitHub, because that is Cadrel's. Reader finds its own releases by their `reader-v` tag.

## How the version appears

| Where | Looks like |
|-------|-----------|
| `VERSION` file | `0.2.0` |
| Git tag / GitHub release on `main` | `v0.2.0` |
| Pre-release from `dev` | `v0.2.0-dev.17` (17 is the build number; it is a test build of the version being worked on, not a release) |

A build is only a *release* once it comes from `main`; anything else (`dev`, a pull request, a manual run) is a
**development build**, and must say so about itself — not just in the tag it may later be published under. CI
(`.github/workflows/build.yml`) sets `CADREL_DEV_BUILD=dev.<run number>` for every build that is not of `main`, and
`packages/shell/scripts/sync-version.mjs` appends it to the `VERSION` it writes into `package.json`, so the packaged
app's own `app.getVersion()` — what the installer is named after, and what Settings → About shows — reads
`0.2.0-dev.17`, matching the tag that run's release (if any) is published under. The updater (`isDevBuild` in
`@cadrel/write/src/shared/update.ts`) reads that suffix to decide whether to offer development or stable releases; a
build of `main` leaves `CADREL_DEV_BUILD` unset, so a stable release's own version is the bare `VERSION`, nothing more.
