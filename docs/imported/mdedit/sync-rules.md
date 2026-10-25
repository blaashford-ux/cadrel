# Mobile app and sync rules

Status: **Android and Windows sync built and in use; sharing for review (section 11) built, awaiting a real two-account test.** Decisions are recorded below. Built: the planner, the sync engine (tested with two simulated devices), the Drive REST client, the sync service, Google sign-in for Android (Play Services) and for Windows (browser loopback + PKCE, token encrypted with Windows DPAPI). Still to verify on real hardware: sign-in, and (section 9) that the Windows and Android clients see each other's files under `drive.file`.

## 1. Decisions

| # | Decision |
|---|---|
| 1 | Mobile app is **Android first**, built with **Capacitor**, reusing the React / Milkdown renderer; a **full editor** except desktop-only features |
| 2 | Sync is **built in, over the Google Drive API** (no Drive for Desktop dependency); **Option B**: the same sync engine runs in the Windows app and the Android app |
| 3 | Conflicts **keep both versions** for prose |
| 4 | **Windows-compliant file and folder names are enforced on every device** |
| 5 | Always have the latest version available; sign in once per device, no manual folder setup |
| 6 | Free for users (Drive API within quota; Play Store one-time fee is the developer's) |
| 7 | Build on the Milestone 8 (0.3.0) project model: Root Folder → Projects → subfolders |

## 2. Principles

1. The local folder is the truth on each device. Sync is a separate step and never blocks editing.
2. Never lose prose: chapter text is kept in both versions, never silently overwritten.
3. Sync often and cheaply, and show its state (up to date / syncing / conflict).
4. Files stay plain files on disk. Nothing is locked in.

## 3. When it syncs

| Moment | What happens |
|---|---|
| App opens or returns to the foreground | Pull, using Drive's incremental change list (a page token, not a full scan) |
| Before a file opens for editing | Quick check; if Drive is newer and the local copy is clean, pull first |
| A few seconds after a save | Upload that file |
| While the app is open | Light polling about every 30-60 s, plus pull-to-refresh / Sync now |
| App in the background (Android) | Best effort: a periodic background job (about 15 min at best, may be delayed by the OS) |
| A file changes remotely while open | Existing external-change logic: clean file reloads, file with unsaved edits shows the conflict banner |

## 4. Rules by file type

| File | Synced? | On conflict |
|---|---|---|
| `*.md` | Yes | **Keep both.** The version already on Drive keeps the name; the version arriving from the other device is saved beside it as `Name (conflict - Device - YYYY-MM-DD).md` and flagged in the app |
| `.mdedit/progress*.json` | Yes | **Merge per day:** earliest `start` for each date, then re-record the current total after sync (the history repairs itself) |
| `.mdedit/edited.json` | Yes | **Merge per chapter:** marks from both devices are kept (a union); where both changed the same chapter the newer change wins, so an unmark isn't undone by the other device |
| `.mdedit/review/*.json` (review notes) | Yes | **Merge note by note** (same rule as sharing: match by note id, the newer change wins, replies are united), so notes made on the PC and the phone both survive |
| `.mdedit/project.json`, `*.export.json` | Yes | **Last writer wins**; the older version stays in Drive revision history. A conflict copy would confuse the project scan and orphan-sidecar detection |
| Cover images and other small non-text files | Yes | Last writer wins |
| Portable settings (templates, defaults) | Yes, as a file in the Root | Last writer wins. Move these out of the desktop's local `settings.json` |
| `Exports/` outputs (EPUB, PDF, DOCX) | No by default (optional toggle) | n/a. Large and regenerable |
| Temp / `.bak` files from atomic writes, drafts, session state, window prefs, theme | Never | Per device |

**Detecting a conflict.** For each file, remember the Drive version (md5 checksum / head revision) and the local content hash from the last sync. A conflict is both sides changed since then. Equal hashes are never a conflict, so touching a file without changing it makes no copy.

## 5. Deletes, renames, collisions

* **Delete:** if only one side changed, the delete propagates (Drive trash and an app trash keep it recoverable). Delete versus edit: the edit wins and the file returns.
* **Rename / move:** tracked by Drive file ID, so it stays a rename.
* **Whole projects:** new projects appear on the other device. Deleting a project never propagates automatically; the receiving device asks first.
* **Selective sync:** none in v1. Text is small, so everything syncs.

## 6. Windows-compliant names (enforced everywhere)

* One shared validator (extend the Milestone 8 project-name rules to every file and folder): illegal characters `< > : " / \ | ? *` and control characters; reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9); no trailing dot or space; case-insensitive collision check; Unicode NFC; name length cap (about 120) so paths stay under 260.
* Creating and renaming (desktop and phone) validate live.
* Names arriving from Drive that are invalid (made in the Drive web UI, say) are **renamed to a compliant name locally and on Drive by file ID**, so all devices converge. A case-insensitive clash gets a numbered suffix. The user sees a short notice.
* Conflict-copy names use the same rules (no colons).

## 7. Setup experience

* Sign in with Google once per device. The app finds or creates the `MDEdit` folder in Drive itself; no folder picker.
* The Root Folder is an ordinary local folder on each device.
* If the Root is inside a Drive for Desktop (or OneDrive / Dropbox) folder, the welcome screen warns that two sync systems would conflict.
* Templates and defaults arrive via the synced settings file, so a new device needs no setup.

## 8. Mobile limitations

* No export (EPUB / PDF / DOCX), no font management, no Explorer-style actions.
* Background sync is delayed and best effort; seeing another device's latest version needs the phone online.
* First sync of a large project takes time: text first, with progress shown.
* Switching later to a broader Drive permission would need Google app verification.

## 9. Open question: the Drive-scope spike

The narrow `drive.file` permission only sees files created (or opened) by the app. Option B depends on the Windows client and the Android client counting as the **same app** to Google, so each sees the other's files. Believed true when both OAuth clients belong to one Google Cloud project; not yet verified. Spike: create a file as one client, list and read it as the other; also test the change-list token, md5 checksums, rename by ID and revision history. If it fails, fall back to a one-time folder picker on the phone (Option A).

## 10. Code implications (when built)

* Split `MdeditApi` (`src/shared/api.ts`) into a core part and a desktop-only part (export, fonts, reveal, Recycle Bin, launch files, native menu), or add capability flags, so mobile can omit the desktop-only calls.
* Shared TypeScript sync engine (`src/shared/sync/`): state store, planner (pure, unit-tested: given local, remote and base state, produce actions), Drive adapter, executor.
* Touch layouts for the Projects home, progress chart and settings.

## 11. Sharing for review (built)

Owners invite reviewers over Google Drive; reviewers read the manuscript and leave comments and suggestions. No Drive folder is shared and nothing needs the broad Drive permission.

* **Owner → Notes → Share…** creates one link per reviewer. MDEdit uploads a snapshot of the project's **active manuscript only** (one JSON "package", readable by anyone with the link; a project with a single prose file needs no choice, otherwise Active Manuscript has to be set first, and the other files, notes and drafts are never uploaded) and a private **comments file** for that reviewer (writable by anyone with *their* link, not re-shareable). Both live in a Drive folder `MDEdit Reviews`, beside (not inside) the synced `MDEdit` folder.
* **Reviewer → Projects → Shared with me → Open invitation…** pastes the link. Google's file picker (a page published from `site/join` with GitHub Pages, shown inside the app) asks them to select the two files; that selection is what gives MDEdit access under the narrow `drive.file` scope. The project downloads into `<Root>/Shared With Me/<Name>` and opens read-only; that folder never syncs to the reviewer's own Drive.
* **Notes** are one JSON file per reviewer (`.mdedit/review/<reviewer>.json`), so reviewers never see each other's notes and can't change the manuscript. Anchors are quoted text plus context, so they follow edits; suggestions apply to the chapter when the owner accepts them. Deleted notes are kept as `deleted` so the deletion merges. Two copies of a file merge by note id (newer wins, replies are united).
* **Exchange** happens a few seconds after a note changes and every minute while a shared project is open. The owner's side also re-uploads the package when the text changes. Removing a reviewer takes their notes one last time, then closes their file; their notes stay in the project.
* **Setup:** Google Cloud project needs the Picker API enabled and a browser API key restricted to the Pages origin and the Picker API (the key is in `site/join/index.html`). GitHub Pages source must be "GitHub Actions"; `.github/workflows/pages.yml` publishes `site/` when it changes on `main`.
* **Phone gotcha:** the picker runs in iframes inside the Android WebView, and Capacitor sends any navigation to a host not in `server.allowNavigation` (`capacitor.config.ts`) to the phone's browser, where Google rejects the key ("The API developer key is invalid"). Keep the Pages host and `docs.google.com` there (a test pins it).
* **Limits:** the picker step is per invitation; invitation links grant access to whoever holds them (revoke by removing the reviewer); no live co-editing; reviewers see the text as of the owner's last upload.
* **Sharing page:** Projects → Sharing lists projects that have reviewers (from the owner's shares, kept in `shares.json` on each device and merged through a small `mdedit-shares.json` in the Drive `MDEdit Reviews` folder, so the PC and the phone list the same reviewers; a reviewer removed on one device stays removed on the others), with open-note counts read from the project's review files. Each reviewer link can be copied plain or as an invitation message (`inviteMessage` in `src/shared/review/link.ts`) that adds a link to the latest release. "Stop sharing" removes every reviewer of a project.
