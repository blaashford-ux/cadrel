# Releasing MDEdit

Pushing a version tag builds the Windows installer, tests it, and publishes it as a GitHub Release anyone can download.

## Cut a release

From an up-to-date branch whose CI is green:

```bash
npm version 0.2.0          # bumps package.json + package-lock.json, commits "0.2.0", tags v0.2.0
git push origin HEAD --follow-tags
```

`npm version patch | minor | major` also works. A version with a hyphen (`0.3.0-beta.1`) is published as a **pre-release**.

Then watch **Actions → release**. It runs four things in order:

1. **Check the tag matches `package.json`.** A mismatch fails immediately with an explanation, so you never ship a mislabelled installer.
2. **The same pipeline as every push** (`build.yml`): typecheck, the full test suite (including real Electron PDF layout, epubcheck and DOCX
   checks), the Windows installer build, and a **smoke test of the freshly built Windows app** (it exports an EPUB, PDF and DOCX).
3. **Publish.** Only if everything above passed, it creates the release `MDEdit 0.2.0` with the installer, a `SHA256SUMS.txt`, install
   instructions (including the SmartScreen note), and auto-generated "What's changed" notes from the commits and PRs since the last release.

Everyone can then download from **https://github.com/blaashford-ux/MDEdit/releases/latest** (no GitHub account needed for public repos).

## If something goes wrong

- **The release job failed after the tag was pushed.** Fix the problem, then either re-run the failed workflow run (it replaces the files of an
  existing release rather than failing), or delete the tag and release and tag again:
  `git push origin :refs/tags/v0.2.0` · `git tag -d v0.2.0` · then re-run the steps above.
- **Wrong notes.** Edit the release on GitHub; the files are unaffected.
- **Un-publish.** Delete the release in the GitHub UI (and the tag, if you don't want it to exist).

## Code signing (removes the "unknown publisher" SmartScreen warning)

Add two repository secrets (Settings → Secrets and variables → Actions): `WIN_CSC_LINK` (a base64-encoded `.pfx` code-signing certificate, or
a URL to it) and `WIN_CSC_KEY_PASSWORD`. The build signs the installer automatically when they exist; nothing else changes. Without them the
installer is unsigned and the release notes explain the warning to users.

## Not set up yet

Auto-update inside the app, a portable build, macOS/Linux installers, and publishing to winget/Chocolatey.

## Releasing without a local tag push

Actions tab → **release** → **Run workflow** (branch `main`). It releases the version in `package.json`,
creates the `vX.Y.Z` tag itself, and publishes the installer.

## Re-cutting a release

If a release went out from the wrong commit (say a last-minute fix landed after it), run the **release** workflow
from the Actions tab with **recut** ticked. It deletes the existing release and its tag, then builds and publishes
the version in `package.json` again from the commit you ran it on. Downloads of the old release disappear.
