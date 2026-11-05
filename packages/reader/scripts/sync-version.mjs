// Cadrel Reader's version lives in packages/reader/VERSION, apart from Cadrel's own (the repository's VERSION file), so either app can
// be released without the other. The installer (and the running app, via app.getVersion()) takes its version from this package's
// package.json, so this copies one to the other. A build that is not from `main` is a development build: CADREL_DEV_BUILD (set by CI
// to "dev.<run number>", matching the `reader-v…-dev.N` tag release.yml publishes) is appended as a semver pre-release suffix, which is how
// the updater tells a development build from a stable one. `--check` only reports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`packages/reader/VERSION "${version}" is not MAJOR.MINOR.FIX`);
const suffix = process.env.CADREL_DEV_BUILD?.trim();
if (suffix && !/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(suffix)) throw new Error(`CADREL_DEV_BUILD "${suffix}" is not a valid semver pre-release identifier`);
const target = suffix ? `${version}-${suffix}` : version;
const file = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.argv.includes('--check')) {
  if (pkg.version !== target) {
    console.error(`packages/reader/package.json is ${pkg.version} but packages/reader/VERSION is ${version}. Run: npm run version:sync -w @cadrel/reader`);
    process.exit(1);
  }
} else if (pkg.version !== target) {
  pkg.version = target;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`reader version set to ${target}`);
}
