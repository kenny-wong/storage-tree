// Background tasks (copies to this PC): list, cancel, dismiss, show the result in Explorer.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fail, idParam, ok } from '../lib/http.js';
import { cancelTask, dismissTask, getTask, listTasks } from '../lib/tasks.js';

export const list = () => ok({ tasks: listTasks() });

export function cancel({ params }) {
  return cancelTask(idParam(params.id)) ? ok({ ok: true }) : fail(404, 'no-task', 'That task is gone.');
}

export function dismiss({ params }) {
  return dismissTask(idParam(params.id)) ? ok({ ok: true }) : fail(409, 'running', 'A running task can’t be removed; cancel it first.');
}

/** Opens the copied folder (or shows the copied file) in Windows Explorer. */
export function reveal({ params }) {
  const task = getTask(idParam(params.id));
  if (!task?.dest) return fail(404, 'no-task', 'That task is gone.');
  if (!existsSync(task.dest)) return fail(404, 'gone', `${task.dest} is not there (yet).`);
  if (process.platform === 'win32') {
    spawn('explorer.exe', task.isFile ? [`/select,${task.dest}`] : [task.dest], { detached: true, stdio: 'ignore' }).unref();
  }
  return ok({ ok: true, path: task.dest });
}
