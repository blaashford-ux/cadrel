# BookScout

A private, local-first research notebook for Amazon **Kindle** books (amazon.com). A Chrome extension sends the pages you choose to a Windows desktop app; the app stores them, parses everything on the page, keeps rank/price/review history, analyses what top books in a category have in common, and shares the library with Claude or GPT through a local MCP server.

- **Install and use it:** [docs/user-guide.md](docs/user-guide.md)
- **Design and plan:** [docs/plan.md](docs/plan.md), [what Amazon's pages contain](docs/capture-fields.md)
- **Build, test, release:** [docs/release.md](docs/release.md) · [performance](docs/performance.md) · [security notes](docs/security.md)

## Develop

```
npm install
npm run typecheck
npm test                                  # xvfb-run -a npm test on a headless Linux box
npm run start -w @cadrel/market-desktop       # builds, then launches the app
```

Then load `packages/extension` as an unpacked extension in `chrome://extensions` and pair it with the code from the app's Settings.

| Package | What it is |
|---|---|
| `packages/core` | Page parsers (list and book pages), privacy scrubber, text and content analysis (pure functions) |
| `packages/library` | On-disk layout, SQLite index, ingest, search, analysis over the library, exports, maintenance |
| `packages/server` | Loopback HTTP ingest server for the extension |
| `packages/extension` | Chrome (MV3) extension |
| `packages/text` | PDF/EPUB/DOCX extraction and OCR |
| `packages/embedder` | Local embedding model |
| `packages/mcp` | MCP server for Claude / GPT |
| `packages/desktop` | Electron app (UI, packaging) |
