// The product version lives in the repository's VERSION file. The installer takes its version from this package's
// package.json, so this copies one to the other. `--check` only reports (used by the tests and CI).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = fs.readFileSync(path.join(root, '..', '..', 'VERSION'), 'utf8').trim();
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`VERSION "${version}" is not MAJOR.MINOR.FIX`);
const file = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (process.argv.includes('--check')) {
  if (pkg.version !== version) {
    console.error(`packages/shell/package.json is ${pkg.version} but VERSION is ${version}. Run: npm run version:sync -w @cadrel/shell`);
    process.exit(1);
  }
} else if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`shell version set to ${version}`);
}
