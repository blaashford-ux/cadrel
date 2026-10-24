# Changelog

Versions are `MAJOR.MINOR.FIX`; see [docs/VERSIONING.md](docs/VERSIONING.md). Newest first.

## Unreleased

- **M0: one app.** MDEdit 0.8.5 and BookScout 0.6.3 are imported (`@cadrel/write`, `@cadrel/market-*`) and run together in a new shell (`@cadrel/shell`): left rail, Home, Dashboard, Write and Market in their own views. Electron 44 and a single pdf.js across the workspace. Windows installer, packaged-app smoke test and CI to build and publish them.

- **One assistant connection.** A single MCP server (`@cadrel/mcp`, name `cadrel`) carries all of Write's tools, resources and editing prompts plus Market's tools. Write's AI Kit and Market's Claude connection both produce the same one `cadrel` Claude Desktop extension. `search_book_text` is Market's former `search_text` (Write keeps `search_text`). The HTTP door serves Write only unless started with `--with-market`.
- Kernel (`@cadrel/kernel`): capability catalogue, the twelve default roles (tested cell for cell against `docs/PERMISSIONS.md`), the permission engine (`can` / `explain`, scopes, teams, expiry, confidential projects, workflow-state denial), role guardrails, and the vault check-out / check-in / undo / force-release logic.
- Studio server (`@cadrel/worker`) skeleton on Cloudflare with D1 and R2 (`cadrel-dev-*` for dev, `cadrel-*` for production), vault migration, and a health endpoint; deployed from the release workflow.
- Plan: PDM-style vault, Cloudflare, shared captures, Windows only, roles and permissions design.

## 0.1.0

- Repository set up: `main` and `dev` branches, build on every pull request, release from `main`, pre-release from `dev`, versioning document.
