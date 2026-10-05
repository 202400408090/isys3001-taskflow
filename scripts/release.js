#!/usr/bin/env node
/**
 * Release and version management.
 *
 * WHY A SCRIPT AND NOT A LIST OF SHELL COMMANDS
 * ---------------------------------------------
 * The Git Flow release procedure has five steps, two of which people forget:
 * merging back to `develop`, and regenerating the changelog before tagging. A
 * procedure that is remembered is a procedure that is sometimes skipped, and
 * the failure is silent - the tag exists, the changelog is simply wrong.
 *
 * This script cannot forget. Every step is printed as it runs, and any step that
 * fails aborts the sequence with the repository left in a described state.
 *
 * Usage:
 *   node scripts/release.js status
 *   node scripts/release.js plan 1.1.0
 *   node scripts/release.js bump 1.1.0
 *   node scripts/release.js release 1.1.0
 *   node scripts/release.js tag 1.1.0
 *   node scripts/release.js verify
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = join(projectRoot, 'VERSION');
const packageFile = join(projectRoot, 'package.json');

const SEMVER = /^\d+\.\d+\.\d+$/;

class StepFailure extends Error {
  constructor(step, cause) {
    super(`${step} failed: ${cause}`);
    this.name = 'StepFailure';
    this.step = step;
  }
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const options = {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  };

  try {
    const output = execFileSync(command, args, options);
    return capture ? output.trim() : '';
  } catch (error) {
    if (allowFailure) return null;
    throw new StepFailure(`${command} ${args.join(' ')}`, error.stderr?.toString().trim() || error.message);
  }
}

const git = (args, options) => run('git', args, options);

/**
 * Run the test suite.
 *
 * The runner is invoked directly rather than through `npm test`, because npm is
 * not guaranteed to be on the PATH - a Node.js installation can exist without
 * it, and on Windows the executable is a shell script that cannot be spawned
 * directly. Using `process.execPath` means the suite runs with the interpreter
 * that is already executing this script, which is also the interpreter the
 * application will run under.
 */
function runTests() {
  return run(process.execPath, ['--test', 'tests/**/*.test.js'], { capture: false });
}

function step(message) {
  process.stdout.write(`\n  → ${message}\n`);
}

function done(message) {
  process.stdout.write(`    ✓ ${message}\n`);
}

function warn(message) {
  process.stdout.write(`    ! ${message}\n`);
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
}

function isClean() {
  return git(['status', '--porcelain'], { capture: true }) === '';
}

function tags() {
  return git(['tag', '--list', 'v*'], { capture: true }).split('\n').filter(Boolean);
}

function currentVersion() {
  return existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '0.0.0';
}

/* ==========================================================================
   Commands
   ========================================================================== */

function status() {
  const version = currentVersion();
  const packageVersion = JSON.parse(readFileSync(packageFile, 'utf8')).version;
  const branch = currentBranch();
  const releaseTags = tags();

  process.stdout.write('\n  Repository status\n');
  process.stdout.write(`  ${'-'.repeat(60)}\n`);
  process.stdout.write(`  branch                    ${branch}\n`);
  process.stdout.write(`  VERSION                   ${version}\n`);
  process.stdout.write(`  package.json version      ${packageVersion}\n`);
  process.stdout.write(`  release tags              ${releaseTags.length}${releaseTags.length ? ` (latest ${releaseTags[releaseTags.length - 1]})` : ''}\n`);
  process.stdout.write(`  working tree              ${isClean() ? 'clean' : 'MODIFIED'}\n`);

  const branches = git(['branch', '--format=%(refname:short)'], { capture: true }).split('\n').filter(Boolean);
  const supporting = branches.filter((name) => /^(feature|release|hotfix)\//.test(name));
  process.stdout.write(`  supporting branches       ${supporting.length ? supporting.join(', ') : 'none'}\n`);

  const drift = version !== packageVersion;
  if (drift) {
    process.stdout.write(
      '\n  ! VERSION and package.json disagree. Both are written by `release.js bump`; a\n' +
        '    manual edit to one of them is the usual cause.\n',
    );
  }

  const suggestions = [
    ['feature /*', 'branches', /^feature\//],
    ['release /*', 'branches', /^release\//],
    ['hotfix /*', 'branches', /^hotfix\//],
  ]
    .filter(([label, , pattern]) => supporting.some((name) => pattern.test(name)))
    .map(([label]) => label);

  if (suggestions.length > 0) {
    process.stdout.write(`\n  Open supporting branches: ${suggestions.join(', ')}\n`);
    process.stdout.write('  Finish or delete each one with the procedure in CONTRIBUTING.md § 1.\n');
  }

  process.stdout.write('\n');
  process.exit(drift ? 1 : 0);
}

/** Work out the next version and list the commits that would be included. */
function plan(target) {
  const version = target ?? suggestVersion();
  if (!SEMVER.test(version)) {
    process.stderr.write(`\n  "${version}" is not a semantic version (expected MAJOR.MINOR.PATCH).\n\n`);
    process.exit(1);
  }

  const latest = tags().sort().at(-1) ?? null;
  const range = latest ? `${latest}..HEAD` : 'HEAD';
  const commits = git(['log', '--no-merges', '--format=%h %s', range], { capture: true })
    .split('\n')
    .filter(Boolean);

  const counts = { feat: 0, fix: 0, other: 0 };
  for (const line of commits) {
    const subject = line.slice(line.indexOf(' ') + 1);
    if (/^feat/.test(subject)) counts.feat += 1;
    else if (/^fix/.test(subject)) counts.fix += 1;
    else counts.other += 1;
  }

  process.stdout.write('\n  Release plan\n');
  process.stdout.write(`  ${'-'.repeat(60)}\n`);
  process.stdout.write(`  current version           ${currentVersion()}\n`);
  process.stdout.write(`  proposed version          ${version}\n`);
  process.stdout.write(`  previous tag              ${latest ?? '(none)'}\n`);
  process.stdout.write(`  commits since             ${commits.length}  (${counts.feat} feat, ${counts.fix} fix, ${counts.other} other)\n`);

  if (commits.length === 0) {
    process.stdout.write('\n  ! No commits since the previous tag. A release with no changes produces an\n');
    process.stdout.write('    empty changelog section, which looks like an error to a reader.\n');
  } else {
    process.stdout.write('\n  Included commits:\n');
    for (const line of commits) process.stdout.write(`    ${line}\n`);
  }

  const bumpKind = latest
    ? counts.feat > 0
      ? 'a MINOR bump (new features are present)'
      : counts.fix > 0
        ? 'a PATCH bump (only fixes are present)'
        : 'a PATCH bump (neither features nor fixes are present)'
    : 'the first release'
  process.stdout.write(`\n  Semantic versioning suggests ${bumpKind}.\n\n`);
  process.exit(0);
}

/** Suggest the next minor version from the current state. */
function suggestVersion() {
  const [major, minor] = currentVersion().split('.').map(Number);
  return `${major}.${Number.isFinite(minor) ? minor + 1 : 1}.0`;
}

/** Write the version into VERSION and package.json. */
function bump(version, { commit = true, tolerateCurrent = false } = {}) {
  if (!SEMVER.test(version)) {
    process.stderr.write(`\n  "${version}" is not a semantic version (expected MAJOR.MINOR.PATCH).\n\n`);
    process.exit(1);
  }

  const previous = currentVersion();

  if (previous === version) {
    // The first release is the case that matters: the repository has to declare
    // *some* version from its first commit, so the version file already holds
    // the number the first tag will carry. Refusing here would make the very
    // first release impossible.
    if (tolerateCurrent) {
      warn(`VERSION already reads ${version}; the version files need no change`);
      return;
    }
    process.stderr.write(
      `\n  The version is already ${version}; nothing to change. Choose a different number.\n\n`,
    );
    process.exit(1);
  }

  step(`writing VERSION: ${previous} -> ${version}`);
  writeFileSync(versionFile, `${version}\n`, 'utf8');
  done('VERSION updated');

  step('writing package.json version');
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
  packageJson.version = version;
  // Preserve the two-space indentation and the trailing newline that the rest of
  // the repository uses, so the diff shows one changed line and nothing else.
  writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  done('package.json updated');

  if (commit) {
    step('committing the version bump');
    git(['add', 'VERSION', 'package.json']);
    git(['commit', '--message', `chore(release): ${version}`]);
    done(`committed as "chore(release): ${version}"`);
  }
}

/** Run the whole documented release sequence. */
function release(version) {
  if (!SEMVER.test(version)) {
    process.stderr.write(`\n  "${version}" is not a semantic version (expected MAJOR.MINOR.PATCH).\n\n`);
    process.exit(1);
  }

  if (!isClean()) {
    process.stderr.write(
      '\n  The working tree has uncommitted changes. Commit or stash them before releasing,\n' +
        '  otherwise the release branch will contain work that is not described by its commits.\n\n',
    );
    process.exit(1);
  }

  if (tags().includes(`v${version}`)) {
    process.stderr.write(`\n  Tag v${version} already exists. Choose a different version.\n\n`);
    process.exit(1);
  }

  const branch = currentBranch();
  const resumeBranch = `release/${version}`;
  const hotfixResumeBranch = `hotfix/${version}`;

  // Resuming. A release can stop part-way - the suite fails, the network drops,
  // the operator is interrupted - and the sequence is designed so the repository
  // is left in a consistent, described state when it does. Refusing to continue
  // from that state would waste the work the abort deliberately preserved, so
  // re-running the command on the release branch picks the sequence up where it
  // stopped instead of starting over.
  const resuming = branch === resumeBranch || branch === hotfixResumeBranch;

  if (!resuming && !['develop', 'main'].includes(branch)) {
    process.stderr.write(
      `\n  A release is cut from develop (or main for a hotfix); the current branch is ${branch}.\n` +
        '  To resume a stopped release, check out its release or hotfix branch and re-run.\n' +
        '  See CONTRIBUTING.md § 1.\n\n',
    );
    process.exit(1);
  }

  const isHotfix = resuming ? branch === hotfixResumeBranch : branch === 'main';
  const releaseBranch = isHotfix ? hotfixResumeBranch : resumeBranch;

  process.stdout.write(`\n  ${isHotfix ? 'Hotfix' : 'Release'} ${version}${resuming ? ' (resuming)' : ''}\n`);
  process.stdout.write(`  ${'-'.repeat(60)}\n`);

  if (resuming) {
    step(`already on ${releaseBranch}; continuing from the current state`);
    done('the branch and its commits are kept');
  } else {
    step(`creating ${releaseBranch} from ${branch}`);
    git(['switch', '--create', releaseBranch]);
    done(`on ${releaseBranch}`);
  }

  bump(version, { tolerateCurrent: true });

  step('regenerating CHANGELOG.md from the Git history');
  // Runs under the same interpreter as this script, for the same reason the test
  // runner does: `node` is not guaranteed to be resolvable as a bare command.
  run(process.execPath, ['scripts/generate-changelog.js']);
  done('CHANGELOG.md regenerated');

  if (!isClean()) {
    step('committing the regenerated changelog');
    git(['add', 'CHANGELOG.md']);
    git(['commit', '--message', `docs(changelog): regenerate for ${version}`]);
    done('changelog committed');
  } else {
    warn('the changelog was already current; nothing to commit');
  }

  step('running the test suite before the version is published');
  try {
    runTests();
    done('the suite passes');
  } catch (error) {
    process.stderr.write(
      `\n  ${error.message}\n\n` +
        `  The release is aborted. The repository is left on ${releaseBranch} with the version\n` +
        '  bumped and the changelog regenerated, so the failure can be fixed and the release\n' +
        '  resumed by re-running this command after checking out the branch.\n\n',
    );
    process.exit(1);
  }

  step('merging into main');
  git(['switch', 'main']);
  git(['merge', '--no-ff', releaseBranch, '--message', `${isHotfix ? 'hotfix' : 'release'}: ${version}`]);
  done('main updated');

  step(`tagging v${version}`);
  git(['tag', '--annotate', `v${version}`, '--message', `${isHotfix ? 'Hotfix' : 'Release'} ${version}`]);
  done(`annotated tag v${version} created`);

  step('merging back into develop');
  git(['switch', 'develop']);
  git(['merge', '--no-ff', releaseBranch, '--message', `merge: ${releaseBranch} back into develop`]);
  done('develop updated, so the release cannot be reverted by the next one');

  step(`deleting ${releaseBranch}`);
  git(['branch', '--delete', releaseBranch]);
  done('supporting branch removed');

  step('returning to develop');
  git(['switch', 'develop']);
  done('on develop');

  process.stdout.write(
    `\n  ${isHotfix ? 'Hotfix' : 'Release'} ${version} complete.\n` +
      `  ${'-'.repeat(60)}\n` +
      '  Next:\n' +
      `    git push origin main develop\n` +
      `    git push origin v${version}\n` +
      '  The pipeline builds and publishes from the tag. See docs/deployment.md.\n\n',
  );
}

/** Tag the current commit without running the rest of the sequence. */
function tag(version) {
  if (!SEMVER.test(version)) {
    process.stderr.write(`\n  "${version}" is not a semantic version.\n\n`);
    process.exit(1);
  }
  if (currentBranch() !== 'main') {
    process.stderr.write('\n  Tags are created on main only. See CONTRIBUTING.md § 1.\n\n');
    process.exit(1);
  }
  if (tags().includes(`v${version}`)) {
    process.stderr.write(`\n  Tag v${version} already exists.\n\n`);
    process.exit(1);
  }

  step(`tagging v${version}`);
  git(['tag', '--annotate', `v${version}`, '--message', `Release ${version}`]);
  done('tag created');
  process.stdout.write(`\n  Push it with: git push origin v${version}\n\n`);
}

/** Verify that the repository is in a state a release could be cut from. */
function verify() {
  const checks = [];
  const check = (name, run_) => {
    try {
      const detail = run_();
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  };

  check('the working tree is clean', () => {
    if (!isClean()) throw new Error('uncommitted changes are present');
    return 'clean';
  });

  check('VERSION and package.json agree', () => {
    const packageVersion = JSON.parse(readFileSync(packageFile, 'utf8')).version;
    if (packageVersion !== currentVersion()) throw new Error(`${currentVersion()} vs ${packageVersion}`);
    return currentVersion();
  });

  check('no development verification database was committed', () => {
    const tracked = git(['ls-files', 'data'], { capture: true, allowFailure: true }) ?? '';
    if (tracked.trim()) throw new Error(`data/ is tracked: ${tracked.split('\n').slice(0, 3).join(', ')}`);
    return 'data/ is untracked';
  });

  check('no real environment file was committed', () => {
    const tracked = (git(['ls-files'], { capture: true }) ?? '')
      .split('\n')
      .filter((file) => /^\.env(\..+)?$/.test(file) && !file.endsWith('.example'));
    if (tracked.length > 0) throw new Error(`committed: ${tracked.join(', ')}`);
    return 'only *.example templates are tracked';
  });

  check('no secret-looking value is present in the tracked templates', () => {
    const suspicious = [];
    for (const file of ['.env.example', '.env.development.example', '.env.staging.example', '.env.production.example']) {
      const path = join(projectRoot, file);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const match = /^(API_KEY|SECRET|TOKEN|PASSWORD)\s*=\s*(.+)$/i.exec(line.trim());
        if (!match) continue;
        const value = match[2].trim();
        const placeholder = /^(|replace-.*|<.*>|your-.*|changeme.*)$/i.test(value);
        if (!placeholder) suspicious.push(`${file}: ${match[1]}`);
      }
    }
    if (suspicious.length > 0) throw new Error(suspicious.join('; '));
    return 'every value is a placeholder';
  });

  check('the current branch is main or develop', () => {
    const branch = currentBranch();
    if (!['main', 'develop'].includes(branch)) throw new Error(`on ${branch}`);
    return branch;
  });

  check('the latest tag is reachable from main', () => {
    const latest = tags().sort().at(-1);
    if (!latest) return 'no tags yet';
    const reachable = git(['merge-base', '--is-ancestor', latest, 'main'], { allowFailure: true });
    if (reachable === null) throw new Error(`${latest} is not an ancestor of main`);
    return latest;
  });

  process.stdout.write('\n  Release readiness\n');
  process.stdout.write(`  ${'-'.repeat(60)}\n`);
  for (const entry of checks) {
    process.stdout.write(`  ${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name.padEnd(48)} ${entry.detail}\n`);
  }

  const failed = checks.filter((entry) => !entry.ok);
  process.stdout.write(`\n  ${checks.length - failed.length} passed, ${failed.length} failed\n\n`);
  process.exit(failed.length > 0 ? 1 : 0);
}

/* ==========================================================================
   Entry point
   ========================================================================== */

const [command, argument] = process.argv.slice(2);

const usage = `
  Release and version management.

  Usage: node scripts/release.js <command> [version]

  Commands:
    status            Report the current version, branch and open supporting branches
    plan [version]    List the commits a release would include and suggest a bump
    bump <version>    Write the version into VERSION and package.json, and commit it
    release <version> Run the whole documented release sequence
    tag <version>     Annotated-tag the current commit on main
    verify            Check the repository is in a release-ready state

  The sequence run by \`release\`:
    1. create release/<version> (or hotfix/<version> from main)
    2. bump VERSION and package.json
    3. regenerate CHANGELOG.md from the history
    4. run the test suite
    5. merge --no-ff into main and annotated-tag it
    6. merge --no-ff back into develop
    7. delete the supporting branch

  See CONTRIBUTING.md section 1 and docs/deployment.md.
`;

switch (command) {
  case 'status':
    status();
    break;
  case 'plan':
    plan(argument);
    break;
  case 'bump':
    if (!argument) {
      process.stderr.write('\n  bump requires a version, for example: bump 1.1.0\n\n');
      process.exit(1);
    }
    bump(argument);
    status();
    break;
  case 'release':
    if (!argument) {
      process.stderr.write('\n  release requires a version, for example: release 1.1.0\n\n');
      process.exit(1);
    }
    release(argument);
    break;
  case 'tag':
    if (!argument) {
      process.stderr.write('\n  tag requires a version, for example: tag 1.1.0\n\n');
      process.exit(1);
    }
    tag(argument);
    break;
  case 'verify':
    verify();
    break;
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    process.stdout.write(usage);
    process.exit(0);
    break;
  default:
    process.stderr.write(`\n  Unknown command "${command}".\n${usage}`);
    process.exit(1);
}
