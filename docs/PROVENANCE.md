# Provenance of imported code

Cadrel starts from two existing apps. They were imported with `git archive` at the commits below (history stays in the original repositories, which remain as archives). Each import was first run unchanged to prove its test suite passes in the new location; later changes are in Cadrel's own history.

| Source | Repository | Commit | Imported to |
|---|---|---|---|
| MDEdit 0.3.0 | `blaashford-ux/MDEdit` | `b2e695d29f4135accff45f81d5f14e46bf131a0c` | `packages/write` (app), notes in `docs/imported/mdedit/` |
| BookScout 0.6.3 | `blaashford-ux/bookscout` | `739a9807b0d32c960e3f26ad392ed95c312e8904` | `packages/market-*`, `fixtures/`, notes in `docs/imported/bookscout/` |

## Mapping

| Original | Cadrel package | Notes |
|---|---|---|
| MDEdit (whole app: `electron/`, `src/`) | `@cadrel/write` | split into `manuscript`, `export` and `mod-write` as the shell takes over (M0) |
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

Not imported: the original CI workflows (replaced by Cadrel's), lock files (Cadrel has one), and each repository's `.gitignore` and tool configuration where they duplicate Cadrel's.
