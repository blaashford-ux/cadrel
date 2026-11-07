# Cadrel Write (Android)

Cadrel Write on a phone: **the writing interface on its own, connected to a Cadrel Studio.** Join a Studio with an invitation link, pick a project, write. It can switch between projects and between Studios; it cannot make, rename, move or delete projects or files (that is done in Cadrel on the desktop). Everything else in the app is Write's own editor, chapter view, find, progress and appearance settings.

It is built from `@cadrel/write` the way Cadrel Reader is (the editor, the projects list and the settings are Write's; this package gives them the Studio's files and the phone's storage), and is released as `Cadrel-<version>.apk` on Cadrel's own releases. See [docs/ANDROID.md](../../docs/ANDROID.md).

## What it does

| | |
|---|---|
| **Joins** a Studio | Paste the owner's invitation link (`cadrel://join?...`, or tap it) and a name. The phone checks the address belongs to the owner the link names, makes its own key, and the Studio records the key. No passwords. |
| **Shows** the projects | The projects the person's roles let them see, as folders in the app's own storage. Each is opened by Write like any project. |
| **Writes** | Markdown, plain text and Fountain files, with or without a connection. |
| **Saves** to the Studio | A pass sends each edited file as the next version (check-out, check-in, lock given back at once), when there is a connection, soon after an edit, when the app comes back to the front, and every minute while open. |
| **Keeps both** | If a file changed in two places (a newer version on the Studio, or someone has it checked out), the phone's text becomes a "conflict" file beside the original and is also sent to the Studio as a new file. Nothing is overwritten. |
| **Switches** Studios | Opening another Studio restarts the app into it: one Studio per run, as on the desktop. |

Where it lives: `src/studio/vaultSync.ts` (the sync), `registry.ts` (joined Studios and keys), `studioApi.ts` (join, switch, leave), `guard.ts` (what the editor may do), `src/mobile/main.tsx` (the entry). The Studio screen is `StudioDialog` in Write's renderer, shown instead of the Google Drive dialog when `capabilities.studio` is set. The Studio client is the shared `@cadrel/studio-client`, also used by the desktop shell.

## What it does not do

- **Project folders on a computer are not in the Studio.** The phone shows what is in the Studio's **vault**, so a project's files appear on the phone once they are in the vault (the desktop's Files page). Nothing uploads a project's folder from the desktop on its own yet.
- **Images and other non-text files** stay on the Studio. The phone's storage and editor work with text.
- **No rename or delete.** The vault keeps versions and has neither.
- **No Google Drive, no review sharing, no export.** Beta readers use Cadrel Reader.
- **The phone's key is kept in the app's private storage**, not in the Android Keystore. Losing the phone's storage loses the key; the owner removes that member and invites the person again.
- **Signing in needs Ed25519 in the phone's web engine** (Android System WebView, since 2025). On an older one the join says so in words.

## Develop

```
npm run dev:mobile -w @cadrel/write-mobile     # the join screen in a browser (no device; storage is in memory)
npm run build:mobile -w @cadrel/write-mobile
npm test -w @cadrel/write-mobile               # the sync, run against the real Studio server code
node packages/android-native/prepare.mjs write # the Android project, ready for ./gradlew assembleRelease
```
