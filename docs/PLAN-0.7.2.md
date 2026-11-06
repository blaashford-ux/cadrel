# 0.7.2 plan: additional app variants

**Status: plan, nothing built.** Branch `0.7.2` (from `dev`). Three deliverables, in the order they should ship:

1. **Cadrel Reader**: finish the Windows app and release it, then ship it on Android.
2. **Cadrel Write Mobile**: a phone-only app that is only the writing interface and plugs into a Cadrel Studio.
3. **Android releases** of both (one shared native/CI pipeline).

## Decisions made

| Question | Answer |
|---|---|
| Distribution | **GitHub release APKs only**, updated in-app by `AppUpdate`. No Play Store, so no AAB or Play account. |
| Reader release number | **0.10.0** (`packages/reader/VERSION`). |
| Existing Android project | **None.** The earlier Android builds were produced entirely in GitHub CI, so there is no project, plugin source or keystore to recover. Everything native is created fresh, and no earlier install has to keep updating. |
| Write Mobile scope | It **cannot create or edit projects**; it can only **switch** between them. Interpreted as: no create, rename, duplicate, delete, template or project-settings changes. Writing inside a project (its files and chapters) stays, because that is the app's purpose. If you meant it should also be read-only, say so. |

## What is already there (checked in this repo)

| Thing | State |
|---|---|
| Reader, Windows | `packages/reader` 0.9.0. Reader mode of `@cadrel/write`; installer, smoke tests and `reader-vX.Y.Z` releases are in `build.yml` / `release.yml`. Icon is a placeholder, installer unsigned, invitation-link click untested on a real Windows machine (reader README, "Not done"). |
| Reader, phone | Web bundle builds (`build:mobile`), `capacitor.config.ts` has its own id `com.blaashford.cadrel.reader`. **No `android/` folder anywhere, no APK build in CI.** |
| Write, phone | `packages/write/src/mobile` (Capacitor FS, dialogs, Drive auth, stubs for desktop-only calls). Same gap: no `android/` project. `AppUpdate`, `DriveAuth` and the external-browser plugin are referenced from TypeScript, but their Java sources are not in the repo. |
| Studio protocol | Keys, signed requests and invitations in `@cadrel/kernel` `studioProtocol`; server in `@cadrel/worker`; app-side client in `packages/shell/src/main/studioClient.ts`; service and vault over the wire in `@cadrel/service`. The vault's file contents live in the Studio's R2 bucket. |
| Project scope | `docs/UI-MODEL.md` (Studio, Project, Book) is the model the mobile app should follow. |

Consequence: the Android work is mostly **building the missing native layer once**, then pointing two apps at it.

---

## Phase 0: decisions and spikes (before any code)

Decide these first; each changes the build.

1. **Names and ids** (open). Proposed: *Cadrel Reader* `com.blaashford.cadrel.reader` (already set), *Cadrel Write Mobile* with a new id (`com.blaashford.cadrel.write`; the current `com.blaashford.cadrel` in `packages/write/capacitor.config.ts` is the full-Write phone build and should be retired or kept as a dev id). Pick before the first Play/APK install, since ids cannot change later.
2. ~~Distribution~~ **Decided: GitHub APKs.**
3. **How mobile Write holds a project.** Recommended: a **local cache of the project's files** (app-private storage, the existing `createCapacitorFs`) that syncs with the Studio vault when online. Writing on a train must work. Alternative (live against the server only) is simpler and wrong for a writing tool.
4. **Spike: can a phone sign requests?** Ed25519 key in Android Keystore or in app storage, join via `cadrel://join?...` link, then `GET /v1/me`. This proves the Studio protocol runs unchanged outside Electron (`studioClient.ts` uses Node/Electron APIs; the signing part must move into a shared, platform-neutral module).
5. **Spike: vault over HTTP from a phone.** List a project's files, read one, write one, handle a conflict. Confirm the Worker's vault routes are enough, or list the additions needed (additions only: one Studio serves every build, see `docs/STUDIOS.md`).

Exit: a short note per decision, committed to this file.

---

## Phase 1: Cadrel Reader upgrade and release (Windows)

Goal: Reader out as `reader-v0.10.0`.

- **Upgrade list** (confirm scope with you; these are the known gaps):
  - Real icon (replace `assets/icon.png`, `build/icon.*`).
  - Code signing, or an explicit decision to ship unsigned with SmartScreen guidance on the download page.
  - Test the `cadrel-reader:` link by a real click on Windows (README flags it untested).
  - Reader-side polish found while testing against the current `@cadrel/write` (reader shares its editor and review code, so anything Write changed since 0.9.0 is untested in reader mode).
  - Re-check the invitation page ("Open in Cadrel Reader") against the live GitHub Pages deploy.
- **Release:** raise `packages/reader/VERSION`, add the CHANGELOG entry, PR to `main`. The existing `publish-reader` job does the rest (tag, installer, `SHA256SUMS.txt`).
- **Versioning note:** Reader's version must rise on any change to `packages/write` (VERSIONING.md). The new mobile package below will also depend on `@cadrel/write`, so Write changes now ripple into three release lines; the version checks need extending (Phase 2).

Exit: installer from the release page installs, opens an invitation, comments reach the author through Drive. Updater offers only `reader-v` releases.

---

## Phase 2: shared Android foundation

One piece of work that both Android apps use.

1. **Native project strategy.** Recommended: do not hand-maintain two checked-in `android/` trees. Commit a small `packages/android-native/` holding the Java plugin sources (AppUpdate, DriveAuth, ExternalBrowser) plus manifest and Gradle templates, and have a script run `cap add android` then overlay them for each app (app id, name, icon, URL scheme, APK name). The alternative (check in one full project per app) is simpler to reason about but drifts.
2. **Rebuild the three plugins** to match the TypeScript contracts already in `packages/write/src/mobile/*` (e.g. `AppUpdate.install({url, name, sumsUrl})` with progress events and the first-time install-permission rejection). Unit-test the TypeScript sides that exist; the Java side is covered by the CI install smoke below.
3. **Manifest items:** URL schemes (`cadrel-reader://`, and `cadrel://join` for Write Mobile), `REQUEST_INSTALL_PACKAGES` for the self-updater, network config, adaptive icons.
4. **Signing.** There is no existing keystore, so make a new release keystore per app (generated once, outside CI), store it and its passwords as repository secrets, never commit it. Android updates require the same key forever, so keep an offline backup (this is the single irreversible item in the plan). With no Play Store, there is no Play-managed key to fall back on.
5. **CI.** New `build.yml` job: Node + JDK 17 + Android SDK, `build:mobile`, `cap sync`, `./gradlew assembleRelease`, sign, verify with `apksigner`, run on an emulator (install, launch, one screenshot). Dev builds get the `-dev.N` suffix like the Windows jobs.
6. **Release.** Extend `release.yml`: attach `CadrelReader-<ver>.apk` to `reader-vX` releases (the name the Reader README says the updater expects) and the Write Mobile APK to its own tag; always include `SHA256SUMS.txt`, which `AppUpdate` verifies.
7. **Versioning.** Add `packages/write-mobile/VERSION` and `scripts/check-write-mobile-version.sh`; extend the "touches `packages/write` must raise Reader's version" rule to cover it; update `docs/VERSIONING.md` and `docs/RELEASING.md`.

Exit: a signed Reader APK built by CI installs on a device and updates itself from a later release.

---

## Phase 3: Cadrel Write Mobile (new package `packages/write-mobile`)

A phone app that is the writing interface only, connected to one or more Studios.

### Scope

**In:**
- Join a Studio by invitation link, sign in by key (no passwords), list the Studios the phone has joined and switch between them.
- Pick a **Project** (and Book), per `UI-MODEL.md`; swap between projects from a switcher in the header. This is the only project operation.
- Open files, write, chapter navigation, find, word count and progress, offline editing, background sync with the vault, conflict handling (conflict copies are named per device, as the existing mobile code does).
- Settings: Studio and account (who I am, role, leave Studio), sync (on Wi-Fi only, sync now, last synced, storage used), editor look (font, size, theme), updates, about.

**Out (deliberately):** creating, renaming, duplicating, deleting or configuring projects, Market, Dashboard, Admin, people and roles management, tasks and approvals, export, import and AI connections. The Studio's server already refuses writes from a role that may not write, so a project that role cannot edit opens read-only.

### Work items

1. **Platform-neutral Studio client.** Extract key handling, request signing and the typed calls out of `packages/shell/src/main/studioClient.ts` into a shared package (browser and Node safe, `fetch` injected). The shell keeps using it, so there is one client to keep correct.
2. **A vault-backed `FsPort`.** Write's shared backend already runs on an `FsPort` (`createCoreApi({fs, ...})`). Implement an `FsPort` that reads and writes the local cache and queues changes for the vault, with a sync service shaped like Write's existing Drive `SyncService`. Reuse the permission checks from `@cadrel/service`; the server remains the authority.
3. **Mobile entry in write-mobile mode.** A third capabilities set beside `READER_CAPABILITIES` and `MOBILE_CAPABILITIES` in `packages/write/src/shared/api.ts`, with the renderer's `caps.*` checks hiding everything out of scope. Add the Studio and Project switcher screens and the settings screens to the renderer.
4. **Join and unlock flow.** Handle `cadrel://join?...` (verify the owner fingerprint as `docs/STUDIOS.md` requires), generate and store the key pair (Android Keystore if the spike says it works, otherwise encrypted app storage), show the fingerprint.
5. **Offline and failure behaviour.** Removed from the Studio, key refused, Studio newer than the app (`apiVersion`/`schemaVersion` → ask to update), lost connection mid-save, two devices editing one chapter.
6. **Tests.** Unit tests for the client, the `FsPort`, the sync queue and conflict rules; Worker-side tests for any added vault route; a device smoke test in CI.

### Needs from the Studio server (to confirm in the spike)

Listing a project's files with versions or hashes, reading and writing one file with a base version (so the server can refuse stale writes), and a cheap "what changed since" call. Additions to the Worker only.

Exit: on a real phone, join a Studio from a link, switch between two projects, write offline, reconnect, see the change on the desktop; a removed member is locked out.

---

## Phase 4: release

| Step | Output |
|---|---|
| Reader | `reader-v0.10.0` with installer **and** APK |
| Write Mobile | `write-mobile-v0.1.0` with APK, then an internal/closed test group before wider release |
| Docs | New `packages/write-mobile/README.md`, updates to `ARCHITECTURE.md` (package table), `STUDIOS.md` (phones as members), `RELEASING.md`, `VERSIONING.md`, CHANGELOG 0.7.2 entry |
| Download page | The GitHub Pages site gets Android links for both apps |

Cadrel's own `VERSION` rises to `0.7.2` only when something in the Cadrel line changes (the shared client extraction and any Worker additions do, so expect it to).

---

## Order and rough sizing

| # | Work | Size | Depends on |
|---|---|---|---|
| 0 | Decisions and two spikes | small | none |
| 1 | Reader upgrade and Windows release | small to medium | none, can run in parallel with 0 |
| 2 | Android foundation (plugins, signing, CI) | medium | decision 1 and 2 |
| 2b | Reader APK released | small | 2 |
| 3 | Write Mobile | large (the real work) | 0, 2 |
| 4 | Write Mobile release and docs | small | 3 |

## Risks

- **Keystore loss** makes updates impossible; back it up before the first release.
- **Studio protocol on a phone** is unproven (spike 0.4). If Keystore signing is unavailable we fall back to app-storage keys, which weakens "device-bound" claims in `docs/PERMISSIONS.md`.
- **Three release lines share `@cadrel/write`.** A careless Write change bumps three versions; the CI checks must catch it, not people.
- **The Java plugins have to be written from scratch** from their TypeScript contracts; there is no earlier source anywhere.
- **Offline conflicts** are the part of mobile writing that hurts users if wrong; budget real testing time.
- Nothing has run against a real Cloudflare Studio yet (PLAN.md's open item 1), so Write Mobile inherits that risk.

## Still open

1. App id and name for Write Mobile (Phase 0, item 1).
2. Whether "cannot edit projects" also means the manuscript is read-only (assumed not).
3. Code signing for the Windows Reader installer, or ship unsigned.
