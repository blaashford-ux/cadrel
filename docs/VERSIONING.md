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

## How the version appears

| Where | Looks like |
|-------|-----------|
| `VERSION` file | `0.2.0` |
| Git tag / GitHub release on `main` | `v0.2.0` |
| Pre-release from `dev` | `v0.2.0-dev.17` (17 is the build number; it is a test build of the version being worked on, not a release) |
