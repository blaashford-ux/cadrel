#!/usr/bin/env bash
# Builds the release artifact into dist/. Prints nothing but the file names it made.
# PLACEHOLDER: cadrel has no application code yet, so this packages the tracked source.
# Replace the body with the real build (compile, bundle, installer) when there is one;
# keep writing the finished files to dist/ and the workflows will pick them up unchanged.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(scripts/check-version.sh)"
rm -rf dist && mkdir -p dist
git archive --format=zip --prefix="cadrel-${version}/" -o "dist/cadrel-${version}.zip" HEAD
(cd dist && sha256sum ./* > SHA256SUMS.txt)
ls dist
