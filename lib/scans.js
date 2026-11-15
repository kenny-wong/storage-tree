// Scans in progress or done, kept in memory (the newest few only: a big
// drive's tree takes a few hundred MB).

import { createTree } from './tree.js';
import { scanLocal } from './scan-local.js';
import { scanPhone } from './scan-phone.js';

const KEEP = 3;
const MAX_ERRORS = 200;
const scans = new Map();
let nextId = 1;

export const getScan = (id) => scans.get(id) ?? null;

/** Starts a scan and returns it at once; poll scanStatus() to follow it. */
export function startScan({ source, path, serial = null, label = path, adb = null, sep = '/' }, deps = { scanLocal, scanPhone }) {
  const scan = {
    id: nextId++,
    source,
    path,
    serial,
    label,
    state: 'scanning',
    method: source === 'local' ? 'lstat' : null,
    started: Date.now(),
    finished: null,
    error: null,
    errors: [],
    errorCount: 0,
    cancelled: false,
    child: null,
    tree: createTree(path, sep),
  };
  scans.set(scan.id, scan);
  for (const id of [...scans.keys()].slice(0, Math.max(0, scans.size - KEEP))) forget(id);

  const onError = (p, code) => {
    scan.errorCount++;
    if (scan.errors.length < MAX_ERRORS) scan.errors.push({ path: p, code });
  };
  const run = source === 'local'
    ? deps.scanLocal({ root: path, tree: scan.tree, onError, isCancelled: () => scan.cancelled })
    : deps.scanPhone({ adb, serial, root: path, tree: scan.tree, onError, onChild: (c) => { scan.child = c; } });
  run.then((r) => {
    if (r?.method) scan.method = r.method;
    scan.tree.finish();
    scan.state = scan.cancelled ? 'cancelled' : r?.incomplete ? 'incomplete' : 'done';
    if (scan.state === 'incomplete') scan.error = 'The phone stopped sending before the list was finished (did the USB cable move, or the connection drop?), so this is only part of it. Scan again.';
  }, (err) => {
    scan.tree.finish();
    scan.state = scan.cancelled ? 'cancelled' : 'failed';
    scan.error = err.message;
  }).finally(() => {
    scan.finished = Date.now();
    scan.child = null;
  });
  return scan;
}

export function cancelScan(id) {
  const scan = scans.get(id);
  if (!scan) return false;
  scan.cancelled = true;
  scan.child?.kill();
  return true;
}

export function forget(id) {
  cancelScan(id);
  return scans.delete(id);
}

/** What the page shows while a scan runs and after. */
export function scanStatus(scan) {
  const { root } = scan.tree;
  return {
    id: scan.id,
    source: scan.source,
    path: scan.path,
    serial: scan.serial,
    label: scan.label,
    state: scan.state,
    method: scan.method,
    entries: scan.tree.entries,
    seconds: ((scan.finished ?? Date.now()) - scan.started) / 1000,
    error: scan.error,
    errorCount: scan.errorCount,
    errors: scan.errors.slice(0, 50),
    root: scan.tree.finished ? { id: root.id, name: root.name, size: root.size, count: root.count, dirCount: root.dirCount, mtime: root.mtime } : null,
  };
}
