# Branches and releases

Two long-lived branches:

- **`main`**: released code. Every merge here publishes a release `vX.Y.Z`.
- **`dev`**: integration. Work lands here first. Every merge here publishes a pre-release `vX.Y.Z-dev.N`.

Work happens on short-lived branches off `dev`. See [VERSIONING.md](VERSIONING.md) for what the numbers mean.

## What runs when

| Event | Workflow | Result |
|-------|----------|--------|
| Pull request into `dev` or `main` | `build` | Checks `VERSION`, builds, attaches the build to the run. For a PR into `main` the version must be higher than every released tag. |
| Merge / push to `dev` | `release` | Builds and publishes a GitHub **pre-release** `vX.Y.Z-dev.N`. |
| Merge / push to `main` | `release` | Builds and publishes a GitHub **release** `vX.Y.Z` and marks it latest. |

Builds are always downloadable without a release: open the run in the **Actions** tab and take **cadrel-build** under *Artifacts* (kept 30 days). Releases carry the same files plus generated notes.

## Cutting a release

1. Merge feature branches into `dev` (builds appear as pre-releases).
2. When `dev` is ready, raise `VERSION` on `dev` per [VERSIONING.md](VERSIONING.md) and add the entry to `CHANGELOG.md`.
3. Open a PR `dev` → `main`. The `build` check must pass (including the version check). Merge it.
4. The `release` workflow publishes `vX.Y.Z`.

## The build

`scripts/build.sh` produces everything in `dist/`. It is currently a placeholder that zips the tracked source. Replace it with the real build once there is one; the workflows publish whatever ends up in `dist/`.

## One-time GitHub settings (not stored in the repo)

- Default branch: `main`.
- Settings → Branches: protect `main` and `dev`; require a pull request and the **build / build** status check before merging.
- Settings → Actions → General → Workflow permissions: allow workflows to create releases (the `release` workflow requests `contents: write` itself, which works unless the org restricts the token to read-only).
