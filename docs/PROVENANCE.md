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
