#!/usr/bin/env bash
# Validates Cadrel Reader's version file (packages/reader/VERSION). Reader is released apart from Cadrel, under tags reader-vX.Y.Z.
#   scripts/check-reader-version.sh            format only (MAJOR.MINOR.FIX)
#   scripts/check-reader-version.sh --newer    also require it to be higher than every released reader-vX.Y.Z tag, when this change
#                                              touches Reader (packages/reader or the Write code Reader is built from)
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(tr -d '[:space:]' < packages/reader/VERSION)"
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "::error file=packages/reader/VERSION::'$version' is not MAJOR.MINOR.FIX (e.g. 0.9.0, no leading zeros, no suffix). See docs/VERSIONING.md."
  exit 1
fi

if [ "${1:-}" = "--newer" ]; then
  # What this change brings in: against the PR's base, or (a push to main) against the first parent of the merge.
  base="HEAD^1"; [ -n "${GITHUB_BASE_REF:-}" ] && base="origin/${GITHUB_BASE_REF}"
  if changed="$(git diff --name-only "$base" HEAD 2>/dev/null)" && ! grep -qE '^(packages/reader/|packages/write/)' <<<"$changed"; then
    echo "Reader is untouched by this change, so its version need not be raised." >&2
    echo "$version"; exit 0
  fi
  latest="$(git tag --list 'reader-v[0-9]*.[0-9]*.[0-9]*' | grep -E '^reader-v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^reader-v//' | sort -V | tail -n1 || true)"
  if [ -n "$latest" ]; then
    top="$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -n1)"
    if [ "$version" = "$latest" ] || [ "$top" != "$version" ]; then
      echo "::error file=packages/reader/VERSION::Reader's version is $version but reader-v$latest is already released, and this change touches Reader. Raise packages/reader/VERSION before merging to main. See docs/VERSIONING.md."
      exit 1
    fi
  fi
fi
echo "$version"
