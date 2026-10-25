# Provenance of imported code

> **Correction.** The first import of MDEdit was 0.3.0 (`b2e695d`), taken from a stale local checkout; MDEdit's `main` was already 0.8.5. It was replaced by the real `main` before any release. BookScout was checked against upstream and was current.

Cadrel starts from two existing apps. They were imported with `git archive` at the commits below (history stays in the original repositories, which remain as archives). Each import was first run unchanged to prove its test suite passes in the new location; later changes are in Cadrel's own history.

| Source | Repository | Commit | Imported to |
|---|---|---|---|
| MDEdit 0.8.5 | `blaashford-ux/MDEdit` | `f8f13958e2fb060de1a13d66f49e4877f5f94886` (`main`) | `packages/write` (app, MCP server, skills, mobile source), notes in `docs/imported/mdedit/` |
| BookScout 0.6.3 | `blaashford-ux/bookscout` | `739a9807b0d32c960e3f26ad392ed95c312e8904` | `packages/market-*`, `fixtures/`, notes in `docs/imported/bookscout/` |

## Mapping

| Original | Cadrel package | Notes |
|---|---|---|
| MDEdit (whole app: `electron/`, `src/`, `mcp/`, `skills/`, `site/`) | `@cadrel/write` | split into `manuscript`, `export` and `mod-write` as the shell takes over; its MCP server is composed into the single Cadrel server |
| bookscout `packages/core` | `@cadrel/market-core` | parsers, analysis |
| bookscout `packages/library` | `@cadrel/market-library` | library, SQLite schema, search, sales and royalties |
| bookscout `packages/server` | `@cadrel/market-server` | loopback capture server |
| bookscout `packages/text` | `@cadrel/market-text` | extraction and OCR |
| bookscout `packages/embedder` | `@cadrel/market-embedder` | local embeddings |
| bookscout `packages/mcp` | `@cadrel/market-mcp` | MCP server |
| bookscout `packages/extension` | `@cadrel/market-extension` | Chrome extension |
| bookscout `packages/desktop` | `@cadrel/market-desktop` | Electron app, to be absorbed by the shell |
| bookscout `fixtures/` | `fixtures/` | saved real Amazon pages used by the tests |

Package names were changed mechanically (`@bookscout/x` to `@cadrel/market-x`) and sibling-directory paths updated. No behaviour was changed in the import commit.

Not imported from MDEdit: the native `android/` project and the built `dist-mobile/` output (the phone app's source, `src/mobile`, is kept so it still type-checks and its tests run; the phone app itself continues to be built from the MDEdit repository). Not imported from either: the original CI workflows (replaced by Cadrel's), lock files (Cadrel has one), and each repository's `.gitignore` and tool configuration where they duplicate Cadrel's.

## Changes made to the imported code

Beyond the mechanical import, these are the places where Cadrel's copy of MDEdit (`@cadrel/write`) and BookScout (`@cadrel/market-*`) differs from the originals. Everything else is unchanged, and the originals' test suites still pass with the same counts.

**MDEdit (`packages/write`)**
- *Hosting:* `electron/module.ts` holds the app's state and IPC behind a `WriteHost` (window, view, data folder, assets folder, MCP, theme, updater); `electron/main.ts` is the thin standalone entry. Menu, window chrome, PDF export and help take their paths and windows from the host.
- *One AI server:* `mcp/server.ts` exposes `registerWriteTools` and `WRITE_INSTRUCTIONS` so Cadrel's single server can carry MDEdit's tools and prompts unchanged; `src/shared/agent/kit.ts` and `config.ts` can brand the AI Kit (`KitBrand`) so it builds the one `cadrel` Claude Desktop extension. `search_text` keeps its name.
- *Appearance owned by the host:* with `host.theme` set (the shell does), the light/dark choice and custom colours are read from and written to the host, `prefs:get` reports `themeManaged`, Settings → Appearance points to Cadrel's Settings, and a `theme:custom` event recolours the page. Standalone behaviour is unchanged.
- *Look:* the shipped palette (`DEFAULT_THEMES` in `src/shared/theme.ts` and the matching variables in `src/renderer/styles.css`) is Cadrel's slate and stone instead of MDEdit's indigo and cyan. MDEdit's presets are kept. This is the one change that makes Write look different from standalone MDEdit.
- *Export acts on one chosen file*: the open file (toolbar, Ctrl+E) or any file right-clicked in the tree. The "mark for export" step, the Book picker in the dialog and the automatic choice of the first marked file are gone; a file's export settings are created on first use.
- Updates are disabled with a reason when hosted.

**BookScout (`packages/market-*`)**
- *Hosting:* the desktop app's main process is split into `module.ts` (state and IPC behind a `MarketHost`) and a thin standalone entry.
- *One AI server:* `market-mcp` exposes `registerMarketTools`; its `search_text` tool is renamed `search_book_text` (MDEdit already uses `search_text`); the Claude extension and launcher can be branded (`McpBrand`) and the launcher answers the handshake early.
- *Notes:* the preload exposes `hostNotes` and the Analysis and Book pages show a Notes button, only when Cadrel hosts the page.
- `pdfjs-dist` is pinned to 4.10.38 (6.x crashes the Electron app reading a PDF).

**Names.** Everything a person reads in Cadrel calls the two apps **Cadrel Write** (MDEdit) and **Cadrel Market** (BookScout): window titles, menus, dialogs, Help, the AI Kit, the MCP instructions and errors, the editing skills' wording, the Chrome extension, and the default projects folder (`<home>\Cadrel`; the AI server still also looks in `~/MDEdit` for projects made before the rename). What deliberately keeps its old name, because changing it would orphan data or break an outside link: the data folders (`%APPDATA%\mdedit`, `%APPDATA%\BookScout`), the hidden `.mdedit` project folder, code identifiers and environment variables (`window.mdedit`, `MDEDIT_ROOT`, `BOOKSCOUT_LIBRARY`), the skill ids (`mdedit-line-edit`…, which are already installed in people's Claude), the Google Drive folder names (`MDEdit`, `MDEdit Reviews`), and everything in the beta-reader flow that points at the standalone reader app (the invitation text, the join page and release links, the updater), which stays MDEdit until Cadrel has its own reviewer package. The phone app's source (`src/mobile`) is still MDEdit's.

**Added by Cadrel, not from either:** `@cadrel/kernel`, `@cadrel/studio`, `@cadrel/ui`, `@cadrel/mcp`, `@cadrel/shell`, `@cadrel/worker`.
