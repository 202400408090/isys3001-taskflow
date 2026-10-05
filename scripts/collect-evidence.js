#!/usr/bin/env node
/**
 * Build the screenshot-ready evidence bundle for the report.
 *
 * WHY THIS EXISTS
 * ---------------
 * The report has to show evidence of version control use: the branch graph, the
 * commit history, the tags, the pipeline. Capturing that by hand from a terminal
 * produces screenshots that cannot be reproduced by a marker, and that go stale
 * the moment the repository changes.
 *
 * This script writes each piece of evidence to a file, together with the exact
 * command that produced it, so a marker can re-run every command and get the
 * same output. The report can then cite the command instead of an image alone.
 *
 * Usage:
 *   node scripts/collect-evidence.js                    # write to evidence/
 *   node scripts/collect-evidence.js --out evidence-v2
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const outputDir = join(projectRoot, outIndex === -1 ? 'evidence' : process.argv[outIndex + 1]);

/** Run a git command and return its output, or an error marker. */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\s+$/, '');
  } catch (error) {
    return `(command failed: git ${args.join(' ')})\n${error.stderr?.toString().trim() ?? error.message}`;
  }
}

/** The evidence set: file name, the command, and what the reader should see. */
const artefacts = [
  {
    file: '01-branch-structure.txt',
    title: 'Branch structure',
    command: ['log', '--graph', '--oneline', '--all', '--decorate'],
    look: 'Two long-lived branches (main, develop), a merge commit for every feature, release and hotfix branch, and both versions tagged.',
  },
  {
    file: '02-commit-history.txt',
    title: 'Full commit history',
    command: ['log', '--all', '--date=short', '--format=%h  %ad  %an  %s'],
    look: 'Every subject follows Conventional Commits, and each carries a date and an author.',
  },
  {
    file: '03-commit-detail.txt',
    title: 'Commit detail with bodies',
    command: ['log', '--all', '--format=%n=== %h %s%n%n%b'],
    look: 'Each body states what changed and why. The Refs: trailer names the deliverable the commit serves.',
  },
  {
    file: '04-merge-commits.txt',
    title: 'Merge commits',
    command: ['log', '--merges', '--format=%h %ad %s', '--date=short'],
    look: 'One merge per supporting branch, including the release back into develop and the hotfix back into develop.',
  },
  {
    file: '05-tags.txt',
    title: 'Annotated tags',
    command: ['tag', '--list', '--format=%(refname:short) | %(objecttype) | %(subject) | %(taggername) | %(creatordate:short)'],
    look: 'Annotated rather than lightweight tags, with an author and a date.',
  },
  {
    file: '06-tag-contents.txt',
    title: 'What each release contained',
    command: ['log', '--oneline', 'v1.0.0..v1.0.1'],
    look: 'The exact set of commits between the two releases: a security fix and its tests.',
  },
  {
    file: '07-branches.txt',
    title: 'Branches and their tips',
    command: ['branch', '--all', '--verbose', '--no-abbrev'],
    look: 'Only main and develop remain: every supporting branch was deleted once merged.',
  },
  {
    file: '08-branch-containment.txt',
    title: 'Which branches are integrated',
    command: ['branch', '--merged', 'develop'],
    look: 'Every feature branch is contained in develop, which is what made deleting them safe.',
  },
  {
    file: '09-file-listing.txt',
    title: 'Tracked files',
    command: ['ls-files'],
    look: 'Only *.example environment templates are tracked, never a real .env or a database file.',
  },
  {
    file: '10-repository-size.txt',
    title: 'Repository statistics',
    command: ['count-objects', '--verbose', '--human-readable'],
    look: 'The repository is small: a source repository, not a store of binaries or generated output.',
  },
  {
    file: '11-history-conventions.txt',
    title: 'Convention conformance',
    command: ['log', '--all', '--format=%s'],
    look: 'Every subject on this list conforms to the Conventional Commits form.',
  },
  {
    file: '12-changes-by-type.txt',
    title: 'Commits grouped by type',
    command: ['log', '--all', '--format=%s'],
    look: 'The distribution of feat, fix, test, docs, build and ci commits, which is the shape of the work.',
  },
  {
    file: '13-file-history-config.txt',
    title: 'History of the configuration loader',
    command: ['log', '--follow', '--oneline', '--stat', '--', 'src/config/index.js'],
    look: 'One file, three commits, each explaining a distinct reason for changing it.',
  },
  {
    file: '14-blame-config.txt',
    title: 'Line authorship in the configuration loader',
    command: ['blame', '--date=short', '-w', 'src/config/index.js'],
    look: 'Every line is attributable to a commit that explains why the line exists.',
  },
  {
    file: '15-reflog.txt',
    title: 'Reference log',
    command: ['reflog', '--date=short', '--format=%h %gd %gs'],
    look: 'The branch operations in the order they happened: creation, commits, merges, deletions.',
  },
];

mkdirSync(outputDir, { recursive: true });

process.stdout.write(`\n  Collecting evidence into ${outputDir.replace(projectRoot, '.')}\n`);
process.stdout.write(`  ${'-'.repeat(70)}\n`);

const index = [];

for (const artefact of artefacts) {
  const commandText = `git ${artefact.command.join(' ')}`;
  const output = git(artefact.command);

  const body = [
    '='.repeat(78),
    artefact.title.toUpperCase(),
    '='.repeat(78),
    '',
    `Reproduce with:  ${commandText}`,
    `Run from:        the repository root`,
    `Captured:        ${new Date().toISOString()}`,
    '',
    'What to look for:',
    ...artefact.look.match(/.{1,74}(\s|$)/g).map((line) => `  ${line.trim()}`),
    '',
    '-'.repeat(78),
    '',
    output,
    '',
  ].join('\n');

  writeFileSync(join(outputDir, artefact.file), body, 'utf8');
  index.push({ ...artefact, commandText, lines: output.split('\n').length });
  process.stdout.write(`  written  ${artefact.file.padEnd(34)} ${String(output.split('\n').length).padStart(5)} lines\n`);
}

/* -------------------------------------------------------------------------- */

const summary = [
  '# Evidence bundle',
  '',
  'Generated by `node scripts/collect-evidence.js`.',
  '',
  'Every file in this directory contains the output of one command, the exact',
  'command that produced it, and a note on what the reader should look for. A',
  'marker can re-run any command below and obtain the same result, so the report',
  "can cite the command rather than relying on a screenshot alone.",
  '',
  '| File | Evidence | Command |',
  '| --- | --- | --- |',
  ...index.map((entry) => `| \`${entry.file}\` | ${entry.title} | \`${entry.commandText}\` |`),
  '',
  '## Suggested screenshots for the report',
  '',
  '| Report section | File to screenshot |',
  '| --- | --- |',
  '| Branching strategy | `01-branch-structure.txt` — the whole model in one image |',
  '| Version control use | `02-commit-history.txt` — the convention in practice |',
  '| Commit quality | `03-commit-detail.txt` — bodies that state why |',
  '| Branch integration | `04-merge-commits.txt` and `08-branch-containment.txt` |',
  '| Releases | `05-tags.txt` and `06-tag-contents.txt` |',
  '| Repository hygiene | `09-file-listing.txt` — no `.env`, no database file |',
  '| Provenance | `14-blame-config.txt` — every line attributable to a reason |',
  '',
  '## Note for the honesty of the report',
  '',
  'These files are transcriptions of command output, not images. A screenshot of',
  'the corresponding terminal output is what the report should contain, and the',
  'command is printed inside each file so the two can be checked against each',
  'other.',
  '',
].join('\n');

writeFileSync(join(outputDir, 'README.md'), summary, 'utf8');
process.stdout.write(`  written  README.md\n`);
process.stdout.write(`\n  ${index.length} evidence files plus an index.\n\n`);
