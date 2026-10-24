# Changelog

Versions are `MAJOR.MINOR.FIX`; see [docs/VERSIONING.md](docs/VERSIONING.md). Newest first.

## Unreleased

- Kernel (`@cadrel/kernel`): capability catalogue, the twelve default roles (tested cell for cell against `docs/PERMISSIONS.md`), the permission engine (`can` / `explain`, scopes, teams, expiry, confidential projects, workflow-state denial), role guardrails, and the vault check-out / check-in / undo / force-release logic.
- Studio server (`@cadrel/worker`) skeleton on Cloudflare with D1 and R2 (`cadrel-dev-*` for dev, `cadrel-*` for production), vault migration, and a health endpoint; deployed from the release workflow.
- Plan: PDM-style vault, Cloudflare, shared captures, Windows only, roles and permissions design.

## 0.1.0

- Repository set up: `main` and `dev` branches, build on every pull request, release from `main`, pre-release from `dev`, versioning document.
