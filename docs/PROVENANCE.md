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

**Names.** Cadrel has no existing users or data, so nothing carries the old names. The apps are **Cadrel Write** (from MDEdit) and **Cadrel Market** (from BookScout) everywhere: what a person reads; the data folders (everything lives under `%APPDATA%\Cadrel`, with `write` and `market` inside it, beside the studio and the user); the hidden per-project folder (`.cadrel`, not `.mdedit`); the bridges (`window.cadrelWrite`, `window.cadrelMarket`); environment variables (`CADREL_WRITE_ROOT`, `CADREL_MARKET_LIBRARY`, `CADREL_TEST`…); the editing skills (`cadrel-line-edit`, `cadrel-copy-edit`, `cadrel-developmental-edit`); the Google Drive folders (`Cadrel`, `Cadrel Reviews`); the AI Kit and extension files; the installer and release names; package, app and bundle ids (`com.blaashford.cadrel.write`, `com.blaashford.cadrel.market`); and the repository and join-page links (`blaashford-ux/cadrel`). The phone app's source (`src/mobile`) uses the same names. **Migration** of anyone's MDEdit or BookScout data (the `.mdedit` project folders, the old data folders) is deliberately not built; it is designed in `docs/FILES.md` §8 for when it is wanted. **Not yet true:** the join page and releases at the new links do not exist until the beta-reader flow is rebuilt on Cadrel's own pages.

**Added by Cadrel, not from either:** `@cadrel/kernel`, `@cadrel/studio`, `@cadrel/ui`, `@cadrel/mcp`, `@cadrel/shell`, `@cadrel/worker`.

## Bundled fonts (SIL Open Font License 1.1)

The fonts in `packages/write/assets/fonts/` come from the `ofl/` folder of [github.com/google/fonts](https://github.com/google/fonts) (checked out 3 November 2026), except EB Garamond, Crimson Pro and Libre Baskerville, which were bundled earlier. Each family folder carries its upstream `OFL.txt` unchanged, and the first line of that file is the copyright notice. The licence file is installed with the app, copied into every EPUB that embeds the font, and checked by `src/shared/export/fonts.test.ts` (a family without its licence, or with a licence that is not the OFL 1.1, fails the build).

Conditions the app keeps: the copyright notice and licence travel with every copy of the font; the fonts are never sold on their own, only distributed inside the app and the books it exports; a family whose licence names a Reserved Font Name is shipped byte for byte as upstream made it, never as a modified or renamed copy.

| Family (folder) | Used for | How it ships | Reserved Font Name |
|---|---|---|---|
| EB Garamond (`eb-garamond`) | body (default) | four static faces, as before | none |
| Crimson Pro (`crimson-pro`) | body, heading | four static faces, as before | none |
| Libre Baskerville (`libre-baskerville`) | body | four static faces, as before | none |
| Literata (`literata`) | body | four static instances cut from upstream's variable fonts | none |
| Source Serif 4 (`source-serif-4`) | body | four static instances | none |
| Alegreya (`alegreya`) | body, heading | four static instances | none |
| Spectral (`spectral`) | body, heading | upstream's four static files, unchanged | none |
| Gelasio (`gelasio`) | body | four static instances | none |
| Cormorant Garamond (`cormorant-garamond`) | heading | four static instances | none |
| Fraunces (`fraunces`) | heading | four static instances (optical size 72; SOFT and WONK at default) | none |
| Bodoni Moda (`bodoni-moda`) | heading | four static instances (optical size 28) | none |
| Lora (`lora`) | body | upstream's two variable fonts, unmodified | "Lora" |
| Merriweather (`merriweather`) | body | upstream's two variable fonts, unmodified | "Merriweather" |
| Playfair Display (`playfair-display`) | heading | upstream's two variable fonts, unmodified | "Playfair Display" |
| Marcellus (`marcellus`) | heading | upstream's single Regular file, unmodified | "Marcellus" |

Static instances are made by `packages/write/scripts/build-fonts.py` (fontTools; weights 400 and 700, other axes pinned). Cutting an instance from a variable font is a modification under the OFL, which is allowed for families without a Reserved Font Name and the reason the four families above that do name one are not cut.
