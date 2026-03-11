#!/usr/bin/env node
/**
 * Release helper: npm run release [patch|minor|major]
 *
 * 1. Runs tests
 * 2. Bumps version in package.json
 * 3. Commits "chore: release vX.Y.Z"
 * 4. Creates git tag vX.Y.Z
 * 5. Pushes branch + tag  →  GitHub Actions publishes to npm automatically
 *
 * Prerequisites:
 *   - Clean working tree
 *   - NPM_TOKEN secret set in GitHub repo settings
 *   - npm org "aiping" must exist, or the token must own the @aiping scope
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PKG_PATH = resolve(ROOT, 'package.json');

// ── helpers ───────────────────────────────────────────────────────────────────
const run = (cmd, opts = {}) => {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
};
const runOut = (cmd) =>
  execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;

function bumpVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ── main ──────────────────────────────────────────────────────────────────────
const bumpType = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error(red(`Unknown bump type "${bumpType}". Use patch | minor | major.`));
  process.exit(1);
}

// 1. Ensure clean working tree
const status = runOut('git status --porcelain');
if (status) {
  console.error(red('Working tree is not clean. Commit or stash changes first.'));
  console.error(status);
  process.exit(1);
}

// 2. Run tests
console.log(bold('\n▶ Running tests...'));
run('npm test');
console.log(green('✅ Tests passed\n'));

// 3. Bump version
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, bumpType);
pkg.version = newVersion;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(bold(`▶ Version bumped: ${cyan(oldVersion)} → ${green(newVersion)}`));

// 4. Commit
run('npm run build');
run(`git add package.json package-lock.json dist/`);
run(`git commit -m "chore: release v${newVersion}"`);
console.log(green(`✅ Committed release v${newVersion}\n`));

// 5. Tag
run(`git tag v${newVersion}`);
console.log(green(`✅ Created tag v${newVersion}\n`));

// 6. Push branch + tag
console.log(bold('▶ Pushing to GitHub...'));
run('git push');
run('git push --tags');

console.log('');
console.log(bold(green(`🎉  Released v${newVersion}!`)));
console.log(`   GitHub Actions will now build and publish to npm.`);
console.log(`   Watch progress: ${cyan('https://github.com/haoruilee/aiping_router/actions')}`);
console.log('');
console.log('   Once published, users can install with:');
console.log(cyan('   openclaw plugins install @aiping/model_router'));
console.log('');
