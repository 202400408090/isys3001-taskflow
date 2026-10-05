#!/usr/bin/env node
/**
 * Insert sample tasks so a freshly deployed environment is demonstrable.
 *
 * Usage:
 *   npm run seed              # insert the sample set (refuses if tasks exist)
 *   npm run seed -- --force   # delete existing tasks first
 *
 * The seed is idempotent by refusal rather than by duplication: running it twice
 * does not create forty tasks, and it never silently destroys data without
 * `--force`.
 */

import { createTask, deleteAllTasks, taskSummary } from '../src/models/task.model.js';
import { bootstrap, heading, row } from './lib/environment.js';

const help = `
Insert sample tasks.

Usage: node scripts/seed.js [options]

Options:
  --force      Delete every existing task first
  --count <n>  Insert only the first n sample tasks
  --help, -h   Show this message
`;

const { config, logger, db, helpRequested } = bootstrap({ name: 'seed' });

if (helpRequested) {
  process.stdout.write(help);
  process.exit(0);
}

/** Dates relative to today, so the sample data is always meaningfully dated. */
function relativeDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const SAMPLE_TASKS = [
  {
    title: 'Set up the Git repository and branching model',
    description: 'Initialise main and develop, and document the Git Flow conventions in CONTRIBUTING.md.',
    status: 'done',
    priority: 'high',
    dueDate: relativeDate(-14),
  },
  {
    title: 'Externalise configuration into environment layers',
    description: 'Defaults, .env, .env.<NODE_ENV> and the process environment, with validation at start-up.',
    status: 'done',
    priority: 'urgent',
    dueDate: relativeDate(-7),
  },
  {
    title: 'Write the deployment configuration',
    description: 'Dockerfile, Docker Compose, health checks and the release procedure.',
    status: 'done',
    priority: 'high',
    dueDate: relativeDate(-3),
  },
  {
    title: 'Draft the configuration management report',
    description:
      'Branching strategy, evidence of version control use, deployment configuration and the GenAI declaration.',
    status: 'in_progress',
    priority: 'urgent',
    dueDate: relativeDate(2),
  },
  {
    title: 'Draft the request for proposal',
    description: 'Scope, mandatory requirements, evaluation criteria and the proposed procurement schedule.',
    status: 'in_progress',
    priority: 'urgent',
    dueDate: relativeDate(4),
  },
  {
    title: 'Collect screenshots for the report appendix',
    description: 'Repository, network graph, branching, pull request, pipeline run, tag and release pages.',
    status: 'todo',
    priority: 'high',
    dueDate: relativeDate(5),
  },
  {
    title: 'Review the test suite coverage report',
    description: 'Confirm every module has a case and that no branch is left unexercised.',
    status: 'todo',
    priority: 'medium',
    dueDate: relativeDate(6),
  },
  {
    title: 'Verify the container image builds from a clean checkout',
    description: 'Clone into an empty directory and run the documented quick-start instructions verbatim.',
    status: 'todo',
    priority: 'medium',
    dueDate: relativeDate(8),
  },
  {
    title: 'Compare three hosting options against the selection criteria',
    description: 'Weighted scoring against cost, free tier, deployment model and learning value.',
    status: 'todo',
    priority: 'low',
    dueDate: relativeDate(9),
  },
  {
    title: 'Confirm the rollback runbook works against staging',
    description: 'Deploy the previous tag and verify that the documented procedure recovers the service.',
    status: 'blocked',
    priority: 'medium',
    dueDate: relativeDate(11),
  },
  {
    title: 'Produce the final PDF submissions',
    description: 'Two files named per the assessment convention, Arial 12 point, 1.5 line spacing.',
    status: 'todo',
    priority: 'high',
    dueDate: relativeDate(14),
  },
  {
    title: 'Read the marking rubric again before submitting',
    description: 'Check that every criterion has visible evidence in the report or the repository.',
    status: 'todo',
    priority: 'low',
    dueDate: relativeDate(-1),
  },
];

const force = process.argv.includes('--force');
const countIndex = process.argv.indexOf('--count');
const requestedCount = countIndex === -1 ? SAMPLE_TASKS.length : Number(process.argv[countIndex + 1]);

heading('Seed sample data');
row('environment', config.env);
row('database', config.database.isInMemory ? ':memory:' : config.database.path);

const existing = taskSummary(db);

if (existing.total > 0 && !force) {
  process.stdout.write(
    `\n  The database already contains ${existing.total} task(s).\n` +
      '  Nothing was changed. Re-run with --force to replace them.\n\n',
  );
  db.close();
  process.exit(0);
}

if (existing.total > 0) {
  const removed = deleteAllTasks(db);
  row('removed', `${removed} existing task(s)`);
}

const limit = Number.isFinite(requestedCount) && requestedCount > 0 ? Math.min(requestedCount, SAMPLE_TASKS.length) : SAMPLE_TASKS.length;

for (const sample of SAMPLE_TASKS.slice(0, limit)) {
  createTask(db, { description: '', ...sample }, { logger });
}

const summary_ = taskSummary(db);
process.stdout.write('\n');
row('inserted', limit);
row('total tasks', summary_.total);
row('overdue', summary_.overdue);
process.stdout.write('\n  Seed complete.\n\n');

db.close();
process.exit(0);
