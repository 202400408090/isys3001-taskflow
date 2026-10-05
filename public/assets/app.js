/**
 * TaskFlow client.
 *
 * One module, no framework and no build step, so the deployment artefact is the
 * source. Structure:
 *
 *   state        - the single source of truth for what is on screen
 *   render*      - pure functions from state to markup
 *   handlers     - update state, call the API, re-render
 *
 * Rendering assigns `innerHTML` from escaped values. All user-supplied text
 * passes through `escapeHtml`, which is the client-side counterpart of the
 * server's output discipline: a task title containing markup is displayed as
 * text, never executed.
 */

import { api, ApiError, fieldErrorsFrom, getApiKey, setApiKey } from './api.js';

/* ==========================================================================
   State
   ========================================================================== */

const PAGE_SIZE = 20;

const state = {
  tasks: [],
  total: 0,
  offset: 0,
  hasMore: false,
  summary: null,
  meta: null,
  filters: { status: '', priority: '', search: '' },
  editingId: null,
  busy: false,
  loading: true,
  /** Field-level messages keyed by field name, plus `_form` for form-wide ones. */
  errors: {},
  flash: null,
};

const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const STATUS_LABELS = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

const PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/* ==========================================================================
   Utilities
   ========================================================================== */

/** Escape text for interpolation into markup. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Today as YYYY-MM-DD in the browser's own time zone. */
function today() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Present a due date relative to today, so the list is readable at a glance. */
function describeDueDate(dueDate, status) {
  if (!dueDate) return null;

  const reference = today();
  if (status !== 'done' && dueDate < reference) {
    const days = Math.round((Date.parse(reference) - Date.parse(dueDate)) / 86_400_000);
    return { text: `Overdue by ${days} day${days === 1 ? '' : 's'} (${dueDate})`, overdue: true };
  }

  if (dueDate === reference) return { text: `Due today (${dueDate})`, overdue: false };

  const days = Math.round((Date.parse(dueDate) - Date.parse(reference)) / 86_400_000);
  return { text: `Due in ${days} day${days === 1 ? '' : 's'} (${dueDate})`, overdue: false };
}

/** Guard against an unexpected status value producing an unstyled badge. */
function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

/* ==========================================================================
   Markup
   ========================================================================== */

function renderSummary() {
  if (!state.summary) return '';
  const { total, byStatus, overdue } = state.summary;

  const tiles = [
    { label: 'Total', value: total },
    { label: STATUS_LABELS.todo, value: byStatus.todo ?? 0 },
    { label: STATUS_LABELS.in_progress, value: byStatus.in_progress ?? 0 },
    { label: STATUS_LABELS.done, value: byStatus.done ?? 0 },
    { label: 'Overdue', value: overdue, overdue: true },
  ];

  return `
    <section class="summary" aria-label="Task summary">
      ${tiles
        .map(
          (tile) => `
        <div class="summary__tile${tile.overdue ? ' summary__tile--overdue' : ''}">
          <div class="summary__value">${Number(tile.value) || 0}</div>
          <div class="summary__label">${escapeHtml(tile.label)}</div>
        </div>`,
        )
        .join('')}
    </section>`;
}

function renderFieldError(field) {
  return `<span class="field__error" id="error-${field}" role="alert">${escapeHtml(state.errors[field] ?? '')}</span>`;
}

function renderForm() {
  const disabled = state.busy ? 'disabled' : '';
  const formError = state.errors._form
    ? `<div class="alert alert--error" role="alert">${escapeHtml(state.errors._form)}</div>`
    : '';

  return `
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Add a task</h2>
      </div>
      <div class="panel__body">
        ${formError}
        <form id="create-form" novalidate>
          <div class="field-grid">
            <div class="field field--wide">
              <label for="title">Title <span aria-hidden="true">*</span></label>
              <input
                id="title" name="title" type="text" maxlength="200" required
                autocomplete="off" placeholder="What needs to be done?"
                aria-invalid="${state.errors.title ? 'true' : 'false'}"
                aria-describedby="error-title"
              />
              ${renderFieldError('title')}
            </div>

            <div class="field field--wide">
              <label for="description">Description</label>
              <textarea
                id="description" name="description" maxlength="2000"
                placeholder="Optional detail"
                aria-invalid="${state.errors.description ? 'true' : 'false'}"
                aria-describedby="error-description"
              ></textarea>
              ${renderFieldError('description')}
            </div>

            <div class="field">
              <label for="priority">Priority</label>
              <select id="priority" name="priority">
                ${PRIORITIES.map(
                  (priority) =>
                    `<option value="${priority}"${priority === 'medium' ? ' selected' : ''}>${PRIORITY_LABELS[priority]}</option>`,
                ).join('')}
              </select>
              ${renderFieldError('priority')}
            </div>

            <div class="field">
              <label for="status">Status</label>
              <select id="status" name="status">
                ${STATUSES.map(
                  (status) => `<option value="${status}">${STATUS_LABELS[status]}</option>`,
                ).join('')}
              </select>
              ${renderFieldError('status')}
            </div>

            <div class="field">
              <label for="dueDate">Due date</label>
              <input
                id="dueDate" name="dueDate" type="date"
                aria-invalid="${state.errors.dueDate ? 'true' : 'false'}"
                aria-describedby="error-dueDate"
              />
              ${renderFieldError('dueDate')}
            </div>
          </div>

          <div class="form-actions">
            <button type="submit" ${disabled}>${state.busy ? 'Saving…' : 'Add task'}</button>
            <button type="reset" class="secondary" ${disabled}>Clear</button>
          </div>
        </form>
      </div>
    </section>`;
}

function renderToolbar() {
  const option = (value, label, selected) =>
    `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  return `
    <section class="panel">
      <div class="panel__body">
        <div class="toolbar">
          <div class="field">
            <label for="filter-search">Search</label>
            <input
              id="filter-search" type="search" maxlength="100"
              value="${escapeHtml(state.filters.search)}"
              placeholder="Title or description"
            />
          </div>
          <div class="field">
            <label for="filter-status">Status</label>
            <select id="filter-status">
              ${option('', 'All statuses', state.filters.status === '')}
              ${STATUSES.map((status) =>
                option(status, STATUS_LABELS[status], state.filters.status === status),
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label for="filter-priority">Priority</label>
            <select id="filter-priority">
              ${option('', 'All priorities', state.filters.priority === '')}
              ${PRIORITIES.map((priority) =>
                option(priority, PRIORITY_LABELS[priority], state.filters.priority === priority),
              ).join('')}
            </select>
          </div>
          <button type="button" class="secondary" id="filter-reset">Reset</button>
        </div>
      </div>
    </section>`;
}

function renderTask(task) {
  const editing = state.editingId === task.id;
  const due = describeDueDate(task.dueDate, task.status);
  const completed = task.status === 'done';

  const dueMeta = due
    ? `<span class="${due.overdue ? 'badge badge--overdue' : ''}">${escapeHtml(due.text)}</span>`
    : '';

  return `
    <li class="task${editing ? ' task--editing' : ''}" data-id="${escapeHtml(task.id)}"
        data-status="${escapeHtml(task.status)}" data-priority="${escapeHtml(task.priority)}">
      <input
        class="task__toggle" type="checkbox" ${completed ? 'checked' : ''}
        data-action="toggle" data-id="${escapeHtml(task.id)}"
        aria-label="${completed ? 'Reopen' : 'Complete'} ${escapeHtml(task.title)}"
      />
      <div>
        <h3 class="task__title">${escapeHtml(task.title)}</h3>
        ${task.description ? `<p class="task__description">${escapeHtml(task.description)}</p>` : ''}
        <div class="task__meta">
          <span class="badge badge--${escapeHtml(task.status)}">${escapeHtml(statusLabel(task.status))}</span>
          <span>${escapeHtml(PRIORITY_LABELS[task.priority] ?? task.priority)} priority</span>
          ${dueMeta}
          <span title="Incremented on every write; used to detect a conflicting update">v${Number(task.version) || 1}</span>
        </div>
      </div>
      <div class="task__actions">
        <button type="button" class="link" data-action="edit" data-id="${escapeHtml(task.id)}" ${editing ? 'disabled' : ''}>Edit</button>
        <button type="button" class="link" data-action="delete" data-id="${escapeHtml(task.id)}">Delete</button>
      </div>
    </li>`;
}

function renderEditPanel() {
  const task = state.tasks.find((candidate) => candidate.id === state.editingId);
  if (!task) return '';

  const disabled = state.busy ? 'disabled' : '';
  const formError = state.errors._form
    ? `<div class="alert alert--error" role="alert">${escapeHtml(state.errors._form)}</div>`
    : '';

  return `
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Edit task</h2>
      </div>
      <div class="panel__body">
        ${formError}
        <form id="edit-form" data-id="${escapeHtml(task.id)}" data-version="${Number(task.version) || 1}" novalidate>
          <div class="field-grid">
            <div class="field field--wide">
              <label for="edit-title">Title <span aria-hidden="true">*</span></label>
              <input id="edit-title" name="title" type="text" maxlength="200" required
                     value="${escapeHtml(task.title)}"
                     aria-invalid="${state.errors.title ? 'true' : 'false'}"
                     aria-describedby="error-title" />
              ${renderFieldError('title')}
            </div>
            <div class="field field--wide">
              <label for="edit-description">Description</label>
              <textarea id="edit-description" name="description" maxlength="2000"
                        aria-invalid="${state.errors.description ? 'true' : 'false'}"
                        aria-describedby="error-description">${escapeHtml(task.description)}</textarea>
              ${renderFieldError('description')}
            </div>
            <div class="field">
              <label for="edit-priority">Priority</label>
              <select id="edit-priority" name="priority">
                ${PRIORITIES.map(
                  (priority) =>
                    `<option value="${priority}"${priority === task.priority ? ' selected' : ''}>${PRIORITY_LABELS[priority]}</option>`,
                ).join('')}
              </select>
            </div>
            <div class="field">
              <label for="edit-status">Status</label>
              <select id="edit-status" name="status">
                ${STATUSES.map(
                  (status) =>
                    `<option value="${status}"${status === task.status ? ' selected' : ''}>${STATUS_LABELS[status]}</option>`,
                ).join('')}
              </select>
            </div>
            <div class="field">
              <label for="edit-dueDate">Due date</label>
              <input id="edit-dueDate" name="dueDate" type="date" value="${escapeHtml(task.dueDate ?? '')}" />
              ${renderFieldError('dueDate')}
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" ${disabled}>${state.busy ? 'Saving…' : 'Save changes'}</button>
            <button type="button" class="secondary" id="edit-cancel" ${disabled}>Cancel</button>
            <span class="task__meta">Saving sends version ${Number(task.version) || 1}; a concurrent change is refused rather than overwritten.</span>
          </div>
        </form>
      </div>
    </section>`;
}

function renderList() {
  if (state.loading) {
    return `<section class="panel"><div class="empty-state">Loading tasks…</div></section>`;
  }

  if (state.tasks.length === 0) {
    const filtered = state.filters.status || state.filters.priority || state.filters.search;
    return `
      <section class="panel">
        <div class="empty-state">
          ${filtered ? 'No task matches the current filters.' : 'No tasks yet. Add the first one above.'}
        </div>
      </section>`;
  }

  const from = state.offset + 1;
  const to = state.offset + state.tasks.length;

  return `
    <section class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Tasks</h2>
        <span class="task__meta">showing ${from}–${to} of ${Number(state.total) || 0}</span>
      </div>
      <div class="panel__body">
        <ul class="task-list">
          ${state.tasks.map(renderTask).join('')}
        </ul>
        <div class="pagination">
          <button type="button" class="secondary" id="page-prev" ${state.offset === 0 ? 'disabled' : ''}>Previous</button>
          <span>Page ${Math.floor(state.offset / PAGE_SIZE) + 1}</span>
          <button type="button" class="secondary" id="page-next" ${state.hasMore ? '' : 'disabled'}>Next</button>
        </div>
      </div>
    </section>`;
}

function renderFlash() {
  if (!state.flash) return '';
  return `<div class="alert alert--${state.flash.kind}" role="status">${escapeHtml(state.flash.message)}</div>`;
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const meta = state.meta;
  const revision = meta?.revision?.commit ? meta.revision.commit.slice(0, 12) : 'unknown';

  root.dataset.state = state.loading ? 'loading' : 'ready';

  root.innerHTML = `
    <header class="masthead">
      <div class="masthead__inner">
        <h1 class="masthead__title">${escapeHtml(meta?.application?.name ?? 'TaskFlow')}</h1>
        ${meta?.environment ? `<span class="masthead__environment">${escapeHtml(meta.environment)}</span>` : ''}
        <span class="masthead__spacer"></span>
        <span class="masthead__revision" title="The exact revision this instance was built from">
          v${escapeHtml(meta?.application?.version ?? '—')} · ${escapeHtml(revision)}
        </span>
      </div>
    </header>
    <main>
      ${renderFlash()}
      ${renderSummary()}
      ${renderEditPanel()}
      ${renderForm()}
      ${renderToolbar()}
      ${renderList()}
    </main>`;

  wireEvents();
}

/* ==========================================================================
   Behaviour
   ========================================================================== */

function flash(kind, message) {
  state.flash = { kind, message };
  // Clear automatically so a stale message cannot be mistaken for a new result.
  window.setTimeout(() => {
    state.flash = null;
    render();
  }, 6000);
}

function clearErrors() {
  state.errors = {};
}

/** Load the list, the summary and the instance description together. */
async function refresh() {
  state.loading = state.tasks.length === 0;
  render();

  try {
    const [list, summary] = await Promise.all([
      api.list({
        limit: PAGE_SIZE,
        offset: state.offset,
        status: state.filters.status,
        priority: state.filters.priority,
        search: state.filters.search,
      }),
      api.summary(),
    ]);

    state.tasks = list.data ?? [];
    state.total = list.meta?.total ?? state.tasks.length;
    state.hasMore = Boolean(list.meta?.hasMore);
    state.summary = summary.data ?? null;

    // An edit may have been open on a task that no longer matches the filter.
    if (state.editingId && !state.tasks.some((task) => task.id === state.editingId)) {
      state.editingId = null;
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    state.tasks = [];
    state.total = 0;
    flash('error', error.message);
  } finally {
    state.loading = false;
    render();
  }
}

async function loadMeta() {
  try {
    const response = await api.meta();
    state.meta = response.data ?? null;
  } catch {
    // The badge is decorative; a failure here must not block the task list.
    state.meta = null;
  }
  render();
}


/** Apply a write, then re-read so the screen reflects the server, not a guess. */
async function mutate(operation, successMessage) {
  state.busy = true;
  clearErrors();
  render();

  try {
    await operation();
    state.busy = false;
    if (successMessage) flash('success', successMessage);
    await refresh();
  } catch (error) {
    state.busy = false;

    if (!(error instanceof ApiError)) {
      flash('error', 'An unexpected client error occurred.');
      render();
      return;
    }

    const knownFields = ['title', 'description', 'status', 'priority', 'dueDate'];
    state.errors = fieldErrorsFrom(error, knownFields);

    // A conflict or an authentication failure is form-wide, whatever the body
    // said, so it is surfaced even when no field was named.
    if (!state.errors._form && (error.code === 'CONFLICT' || error.status === 401 || error.status === 0)) {
      state.errors._form =
        error.code === 'CONFLICT'
          ? 'This task changed since it was loaded. The current values have been refreshed; review and submit again.'
          : error.message;
    }

    render();
    if (Object.keys(state.errors).length === 0) flash('error', error.message);

    // A conflict means our copy of the task is stale, so re-read it.
    if (error.code === 'CONFLICT') await refresh();
  }
}

/** Read a form into the payload shape the API expects. */
function readForm(form) {
  const data = new FormData(form);
  const payload = {
    title: String(data.get('title') ?? '').trim(),
    description: String(data.get('description') ?? '').trim(),
    priority: String(data.get('priority') ?? 'medium'),
    status: String(data.get('status') ?? 'todo'),
  };

  const dueDate = String(data.get('dueDate') ?? '').trim();
  payload.dueDate = dueDate === '' ? null : dueDate;

  return payload;
}

function wireEvents() {
  const createForm = document.getElementById('create-form');
  createForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = readForm(createForm);

    if (!payload.title) {
      state.errors = { title: 'A title is required.' };
      render();
      return;
    }

    mutate(async () => {
      await api.create(payload);
      createForm.reset();
    }, 'Task created.');
  });

  createForm?.addEventListener('reset', () => {
    clearErrors();
    render();
  });

  const editForm = document.getElementById('edit-form');
  editForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = readForm(editForm);
    // Send the version this form was rendered from, so a concurrent write is
    // refused instead of silently overwritten.
    payload.version = Number(editForm.dataset.version);

    mutate(async () => {
      await api.update(editForm.dataset.id, payload);
      state.editingId = null;
    }, 'Task updated.');
  });

  document.getElementById('edit-cancel')?.addEventListener('click', () => {
    state.editingId = null;
    clearErrors();
    render();
  });

  document.getElementById('filter-search')?.addEventListener('input', debounce((event) => {
    state.filters.search = event.target.value.trim();
    state.offset = 0;
    refresh();
  }, 300));

  document.getElementById('filter-status')?.addEventListener('change', (event) => {
    state.filters.status = event.target.value;
    state.offset = 0;
    refresh();
  });

  document.getElementById('filter-priority')?.addEventListener('change', (event) => {
    state.filters.priority = event.target.value;
    state.offset = 0;
    refresh();
  });

  document.getElementById('filter-reset')?.addEventListener('click', () => {
    state.filters = { status: '', priority: '', search: '' };
    state.offset = 0;
    refresh();
  });

  document.getElementById('page-prev')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    refresh();
  });

  document.getElementById('page-next')?.addEventListener('click', () => {
    if (!state.hasMore) return;
    state.offset += PAGE_SIZE;
    refresh();
  });

  // Task actions are delegated from the list, so a re-render never leaves a
  // handler bound to a node that no longer exists.
  document.querySelector('.task-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task) return;

    if (action === 'edit') {
      state.editingId = id;
      clearErrors();
      render();
      document.getElementById('edit-title')?.focus();
      return;
    }

    if (action === 'delete') {
      // Deleting is irreversible, so it is confirmed explicitly.
      if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
      await mutate(async () => {
        await api.remove(id, task.version);
      }, 'Task deleted.');
    }
  });

  document.querySelector('.task-list')?.addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-action="toggle"]');
    if (!toggle) return;

    const task = state.tasks.find((candidate) => candidate.id === toggle.dataset.id);
    if (!task) return;

    const status = toggle.checked ? 'done' : 'todo';
    mutate(async () => {
      await api.update(task.id, { status, version: task.version });
    }, status === 'done' ? 'Task completed.' : 'Task reopened.');
  });
}

/** Delay a call until typing pauses, so a search does not issue one request per keystroke. */
function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

/* ==========================================================================
   Bootstrap
   ========================================================================== */

/**
 * Offer the API key prompt only when the server says writes are authenticated
 * and no key has been stored yet. Asking unconditionally would train the user to
 * dismiss it.
 */
async function maybePromptForApiKey() {
  try {
    const response = await api.meta();
    state.meta = response.data ?? null;

    const requiresKey = Boolean(state.meta?.features?.writeAuthentication);
    if (!requiresKey || getApiKey()) return;

    const supplied = window.prompt(
      'This instance requires an API key for creating, updating and deleting tasks.\n' +
        'Paste the key, or cancel to browse read-only.',
      '',
    );
    if (supplied) setApiKey(supplied.trim());
  } catch {
    /* the banner is informational; failure must not block the list */
  }
}

async function bootstrap() {
  render();
  await maybePromptForApiKey();
  await refresh();
  render();
}

// Exported for a future browser-based test harness. The module also runs on
// import, because index.html loads it directly.
export { state, refresh, render };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
