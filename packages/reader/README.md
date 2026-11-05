# Cadrel Reader

For beta readers: open an invitation from an author, read the manuscript, and leave comments and suggestions. Nothing else. It is a separate app from Cadrel, so readers don't need the suite, and it can be updated without it.

- **Can:** open an invitation (the link, or **Open invitation…** and paste), read in the chapter view, Find, comment on or suggest a change to a selection, sync your notes back through Google Drive, change the look, update itself.
- **Can't:** write or change the manuscript, make or manage projects, share, export, import, connect an AI, open arbitrary folders. These are not just hidden: the Windows app doesn't register their channels, and the phone app replaces their calls with a refusal.
- **Invitations to edit** (a collaborator's) are refused up front with a note to use Cadrel instead.

## How it is built

Reader is not a copy of Write. It imports Write's code (`@cadrel/write`), so a fix to the review, merge or editor code reaches both apps, and runs it in **reader mode**:

| Piece | Where |
|---|---|
| Capabilities (`reader: true`, everything authoring off) | `packages/write/src/shared/api.ts` (`READER_CAPABILITIES`) |
| The screens (Shared with me, read-only editor, Notes) | `packages/write/src/renderer` (`ReaderHome.tsx`, and the `caps.reader` checks in `App.tsx`) |
| Windows: module in reader mode, blocked channels, short menu | `packages/write/electron` (`readerMode.ts`, `module.ts`, `menu.ts`) |
| Windows: window, data folder, `cadrel-reader:` links, single instance | `electron/main.ts` |
| Phone: entry, own storage folder, author calls refused | `src/mobile/main.tsx`, `packages/write/src/shared/readerApi.ts` |
| Version, installer, tags | `VERSION`, `package.json` (`build`), `scripts/`, [docs/RELEASING.md](../../docs/RELEASING.md) |

## Develop

```
npm run dev -w @cadrel/reader            # Electron + Vite (port 5175)
npm run build -w @cadrel/reader          # main process + window
npm run dist -w @cadrel/reader           # Windows installer (run on Windows / CI)
npm run dev:mobile -w @cadrel/reader     # the phone UI in a browser (an in-memory demo library and Drive)
npm test -w @cadrel/reader
```

`electron packages/reader --smoke-test=<file.json>` starts the built app headless and checks that it is in reader mode (CI runs it).

## Not done

- **The Android app is not built from this repository.** `npm run build:mobile` makes the phone's web bundle and `capacitor.config.ts` has Reader's own id (`com.blaashford.cadrel.reader`), but the native Android project (the `android/` folder with the Google sign-in, update and external-browser plugins, and its manifest) is not in this repository, nor is an APK build in CI. Reader needs its own native project made from Write's, with: that app id, the `cadrel-reader://` scheme in its manifest (for the picker's hand-back and for invitation links), and the `CadrelReader-*.apk` file name the updater looks for.
- **The icon is Write's**, as a placeholder (`assets/icon.png`, `build/icon.*`).
- **Code signing**, as for Cadrel: the installer is unsigned until the certificate secrets exist.
- Clicking an invitation link on Windows is registered by the installer; it has been tested here only as far as the link reaching the window (`electron/inviteArg.test.ts`), not by a real click on a Windows machine.
