#!/usr/bin/env node
/**
 * Build the container image with the build metadata applied.
 *
 * WHY THIS IS A SCRIPT
 * --------------------
 * The metadata has three parts - the version, the commit and the build time -
 * and all three must be passed as build arguments on every build. Doing that by
 * hand is where a "which commit is actually deployed?" question comes from: the
 * image is built, the argument is omitted, and the container reports
 * `unknown` forever.
 *
 * Using a script also keeps the invocation identical on PowerShell, Bash and in
 * the pipeline, which a `$(...)` substitution inside package.json does not.
 *
 * Usage:
 *   node scripts/build-image.js
 *   node scripts/build-image.js --tag myregistry.example.edu/taskflow:1.0.0
 *   node scripts/build-image.js --print     # show the command without running it
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read the version, falling back to package.json and then to a placeholder. */
function readVersion() {
  try {
    const version = readFileSync(join(projectRoot, 'VERSION'), 'utf8').trim();
    if (version) return version;
  } catch {
    /* fall through to package.json */
  }

  try {
    return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Short commit SHA, or a clear placeholder outside a repository. */
function readCommit() {
  try {
    return (
      execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

/** True when the working tree has uncommitted changes. */
function isDirty() {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const version = readVersion();
const commit = readCommit();
const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
// A suffix marks a build that contains work not yet in a commit, so an image
// built from a dirty tree is never mistaken for the tagged revision.
const dirtySuffix = isDirty() ? '-dirty' : '';
const repository = tagIndex === -1 ? 'isys3001/taskflow' : args[tagIndex + 1].replace(/:[^:]*$/, '');
const tag = tagIndex === -1 ? `${repository}:${version}${dirtySuffix}` : args[tagIndex + 1];

const command = [
  'build',
  '--tag', tag,
  '--tag', `${repository}:latest`,
  '--build-arg', `APP_VERSION=${version}`,
  '--build-arg', `GIT_COMMIT=${commit}${dirtySuffix}`,
  '--build-arg', `BUILD_TIME=${builtAt}`,
  '--build-arg', 'NODE_ENV=production',
  '--file', 'Dockerfile',
  '.',
];

process.stdout.write('\n  Container image build\n');
process.stdout.write(`  ${'-'.repeat(64)}\n`);
process.stdout.write(`  version      ${version}\n`);
process.stdout.write(`  commit       ${commit}${dirtySuffix}\n`);
process.stdout.write(`  built at     ${builtAt}\n`);
process.stdout.write(`  tag          ${tag}\n`);
if (dirtySuffix) {
  process.stdout.write(`  ! the working tree has uncommitted changes; the tag is suffixed -dirty\n`);
}
process.stdout.write('\n');

if (args.includes('--print')) {
  process.stdout.write(`  docker ${command.join(' ')}\n\n`);
  process.exit(0);
}

try {
  execFileSync('docker', command, { cwd: projectRoot, stdio: ['ignore', 'inherit', 'inherit'] });
} catch (error) {
  if (error.code === 'ENOENT') {
    process.stderr.write(
      '\n  The `docker` executable is not on the PATH.\n' +
        '  Install Docker Desktop, or build the image from a machine that has it.\n' +
        '  The exact command is available with: node scripts/build-image.js --print\n\n',
    );
    process.exit(1);
  }
  process.stderr.write(`\n  The image build failed (exit ${error.status ?? 'unknown'}).\n\n`);
  process.exit(1);
}

process.stdout.write('\n  Image built.\n');
process.stdout.write('  Run it with:\n');
process.stdout.write(
  `    docker run --rm -p 3000:8080 -e API_KEY=<a-key-of-at-least-16-chars> -e CORS_ORIGINS=http://localhost:3000 ${tag}\n`,
);
process.stdout.write('  Then verify it with:\n');
process.stdout.write('    node scripts/smoke-test.js\n\n');
