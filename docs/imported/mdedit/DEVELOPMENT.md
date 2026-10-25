# Developing MDEdit

## Run and build
```
npm install
npm test          # chapter engine tests
npm run dev       # Electron + Vite
npm run dist      # Windows installer (run on Windows / CI)
npm run dev:mobile      # the phone UI in a browser (an in-memory demo library and a demo Drive)
npm run android:sync    # build the phone bundle and copy it into the Android project (the APK itself is built by CI)
```

Google sign-in needs the app's OAuth clients: the Windows build reads the Desktop client secret from `MDEDIT_GOOGLE_CLIENT_SECRET`
(a repository secret `GOOGLE_DESKTOP_CLIENT_SECRET` in CI) and the Android build is signed with the keystore in the `ANDROID_KEYSTORE_*`
repository secrets. See [sync-rules.md](sync-rules.md) for how sync behaves and [RELEASING.md](RELEASING.md) for releases.


## AI reviewers (MCP)
`src/shared/agent/` holds the tools (read chapters, add notes), `mcp/` the MCP and REST servers, `skills/` the editing skills, and
`electron/aiRemote.ts` the optional online access. See [AI-REVIEW.md](AI-REVIEW.md) for how it works and [the plan](milestone-9-ai-review-plan.md) for why.

```
npm run build:electron     # also builds dist-electron/mcp/mdedit-mcp.js (the server; the installer unpacks it beside app.asar)
npm run build:skills       # after editing skills/*/SKILL.md: refreshes mcp/skills.generated.ts (a test fails if it is stale)
node dist-electron/mcp/mdedit-mcp.js --http   # try the online door locally
```
Notes anchor to the editor's plain text, so `src/shared/agent/flatten.ts` must stay in step with `flatten` in `src/renderer/reviewPlugin.ts`; `src/renderer/flattenParity.test.ts` checks it against the real editor parser.

## Tests

`npm test` runs everything. Some suites use external tools and skip themselves if they are missing:

- PDF integration (real Electron + Paged.js): needs `xvfb-run` and the Electron binary (`node node_modules/electron/install.js`).
- epubcheck: needs Java and `pip install epubcheck`.
- DOCX → LibreOffice round trip: needs `libreoffice-writer` (a bare `soffice` install can't open documents).


## Packaging the Windows installer

```
npm ci
npm run dist          # → release/MDEdit-Setup-<version>.exe  (run on Windows or in CI)
```

- **Installer:** NSIS, per-user (no admin rights needed), lets you choose the folder, creates Desktop and Start-menu shortcuts. Uninstalling
  leaves your settings and drafts in `%APPDATA%\MDEdit`.
- **Icon:** `assets/branding/app-icon-source.jpg` is the master. `python scripts/make_icons.py` (needs `pip install pillow`) regenerates
  `build/icon.ico`, `build/icon.png` and `assets/icon.png` with rounded corners.
- **Open with / double-click:** the installer registers MDEdit as an editor for `.md` and `.markdown` (it appears in *Open with*; Windows
  decides the default). Opening a file starts MDEdit on that file's folder; if MDEdit is already running, the file opens as a tab in the
  existing window instead (**one window per user**). If it is in another folder and you have unsaved edits, you get the usual
  Save / Don't Save / Cancel prompt first.
- **Smoke test:** `MDEdit.exe --smoke-test=result.json` exports a small book to EPUB, PDF and DOCX with the bundled fonts and layout engine
  and exits 0 on success. CI runs it against the freshly built Windows package, which is the only way to prove the installed app can export.
- **Code signing:** the installer is **unsigned** until you provide a certificate, so Windows SmartScreen will say "unknown publisher" the first
  time. To sign, add the repository secrets `WIN_CSC_LINK` (a base64 `.pfx`, or a URL) and `WIN_CSC_KEY_PASSWORD`; the workflow signs automatically
  when they exist. A standard code-signing certificate removes the "unknown publisher" name; SmartScreen reputation still builds up over time
  unless you use an EV certificate.
- **Not included:** auto-update, a portable build, other platforms.


Releases: see [RELEASING.md](RELEASING.md).
