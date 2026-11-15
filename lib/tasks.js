// Background tasks (copies from a phone to this PC), kept in memory while the
// app runs. The page polls the list to show progress; each can be cancelled.

const KEEP_DONE = 20;
const MAX_ERRORS = 100;
const tasks = new Map();
let nextId = 1;

/**
 * Starts `run(task)` and returns the task at once. `run` updates the task's
 * counters, checks `task.cancelled` and registers `task.onCancel(fn)` hooks.
 */
export function startTask({ kind, label, dest = null, isFile = false }, run) {
  const task = {
    id: nextId++,
    kind,
    label,
    dest,
    isFile,
    state: 'running',
    started: Date.now(),
    finished: null,
    bytes: 0,
    totalBytes: 0,
    files: 0,
    totalFiles: 0,
    skipped: 0,
    current: null,
    error: null,
    errors: [],
    errorCount: 0,
    cancelled: false,
    cancelHooks: new Set(),
    onCancel(fn) {
      this.cancelHooks.add(fn);
      return () => this.cancelHooks.delete(fn);
    },
    addError(path, message) {
      this.errorCount++;
      if (this.errors.length < MAX_ERRORS) this.errors.push({ path, message });
    },
  };
  tasks.set(task.id, task);
  const done = [...tasks.values()].filter((t) => t.state !== 'running');
  for (const t of done.slice(0, Math.max(0, done.length - KEEP_DONE))) tasks.delete(t.id);
  Promise.resolve()
    .then(() => run(task))
    .then(() => { task.state = task.cancelled ? 'cancelled' : task.errorCount ? 'done-errors' : 'done'; },
      (err) => { task.state = task.cancelled ? 'cancelled' : 'failed'; task.error = err.message; })
    .finally(() => { task.finished = Date.now(); task.current = null; task.cancelHooks.clear(); });
  return task;
}

export const getTask = (id) => tasks.get(id) ?? null;

export function cancelTask(id) {
  const task = tasks.get(id);
  if (!task) return false;
  if (task.state === 'running') {
    task.cancelled = true;
    for (const fn of task.cancelHooks) fn();
  }
  return true;
}

/** Removes a finished task from the list. */
export function dismissTask(id) {
  const task = tasks.get(id);
  if (!task || task.state === 'running') return false;
  return tasks.delete(id);
}

export const runningTasks = () => [...tasks.values()].filter((t) => t.state === 'running');

export function taskStatus(t) {
  return {
    id: t.id,
    kind: t.kind,
    label: t.label,
    dest: t.dest,
    isFile: t.isFile,
    state: t.state,
    seconds: ((t.finished ?? Date.now()) - t.started) / 1000,
    bytes: t.bytes,
    totalBytes: t.totalBytes,
    files: t.files,
    totalFiles: t.totalFiles,
    skipped: t.skipped,
    current: t.current,
    error: t.error,
    errorCount: t.errorCount,
    errors: t.errors.slice(0, 30),
  };
}

export const listTasks = () => [...tasks.values()].reverse().map(taskStatus);
