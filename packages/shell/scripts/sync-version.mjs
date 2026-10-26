// The product version lives in the repository's VERSION file. The installer (and the running app, via app.getVersion())
// takes its version from this package's package.json, so this copies one to the other. A build that is not from `main`
// is a development build, never released as that bare version, so CADREL_DEV_BUILD (set by CI to "dev.<run number>",
// matching the tag release.yml will publish) is appended as a semver pre-release suffix: the app then self-reports a
// version like "0.2.0-dev.17", which is how the updater (see @cadrel/write/src/shared/update.ts, isDevBuild) tells a
// development build from a stable one and offers it only development releases. A build of `main` leaves it unset, so a
// stable release's version is the bare VERSION, exactly as docs/VERSIONING.md documents. `--check` only reports (used by
// the tests and CI); it is never run with CADREL_DEV_BUILD set, since dev builds use `npm run dist`/`pack` directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = fs.readFileSync(path.join(root, '..', '..', 'VERSION'), 'utf8').trim();
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`VERSION "${version}" is not MAJOR.MINOR.FIX`);
const suffix = process.env.CADREL_DEV_BUILD?.trim();
if (suffix && !/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(suffix)) throw new Error(`CADREL_DEV_BUILD "${suffix}" is not a valid semver pre-release identifier`);
const target = suffix ? `${version}-${suffix}` : version;
const file = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.argv.includes('--check')) {
  if (pkg.version !== target) {
    console.error(`packages/shell/package.json is ${pkg.version} but VERSION is ${version}. Run: npm run version:sync -w @cadrel/shell`);
    process.exit(1);
  }
} else if (pkg.version !== target) {
  pkg.version = target;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`shell version set to ${target}`);
}
