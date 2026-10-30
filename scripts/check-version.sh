#!/usr/bin/env bash
# Validates the VERSION file.
#   scripts/check-version.sh            format only (MAJOR.MINOR.FIX, e.g. 1.4.2)
#   scripts/check-version.sh --newer    also require it to be higher than every released vX.Y.Z tag
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(tr -d '[:space:]' < VERSION)"
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "::error file=VERSION::'$version' is not MAJOR.MINOR.FIX (e.g. 0.1.0, no leading zeros, no suffix). See docs/VERSIONING.md."
  exit 1
fi

if [ "${1:-}" = "--newer" ]; then
  # A change that only touches Cadrel Reader (released apart, see check-reader-version.sh) or documentation is not a Cadrel release.
  # What it brings in: against the PR's base, or (a push to main) against the first parent of the merge.
  base="HEAD^1"; [ -n "${GITHUB_BASE_REF:-}" ] && base="origin/${GITHUB_BASE_REF}"
  if changed="$(git diff --name-only "$base" HEAD 2>/dev/null)" && [ -n "$changed" ] && ! grep -qvE '^(packages/reader/|docs/|.*\.md$)' <<<"$changed"; then
    echo "This change only touches Cadrel Reader or documentation, so Cadrel's version need not be raised." >&2
    echo "$version"; exit 0
  fi
  latest="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -V | tail -n1 || true)"
  if [ -n "$latest" ]; then
    top="$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -n1)"
    if [ "$version" = "$latest" ] || [ "$top" != "$version" ]; then
      echo "::error file=VERSION::VERSION is $version but $latest is already released. Bump it (Major, Minor or Fix) before merging to main. See docs/VERSIONING.md."
      exit 1
    fi
  fi
fi
echo "$version"
