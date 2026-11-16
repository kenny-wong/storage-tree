// Scans in progress or done, kept in memory (the newest few only: a big
// drive's tree takes a few hundred MB).

import { win32 } from 'node:path';
import { existsSync } from 'node:fs';
import { createTree } from './tree.js';
import { scanLocal } from './scan-local.js';
import { scanPhone } from './scan-phone.js';
import { listAsAdmin, listLockedFiles, relParts } from './robocopy.js';

const KEEP = 3;
const MAX_ERRORS = 20_000; // all of them are kept (the page is sent the first 50), so the ones read later can be taken out
const NO_ACCESS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sizeLockedDefault = process.platform === 'win32' ? listLockedFiles : async () => [];
const scans = new Map();
let nextId = 1;

export const getScan = (id) => scans.get(id) ?? null;

/**
 * Which scans to drop, given all of them oldest first: everything but the
 * newest `keep`, except that the newest scan of each source stays, so the
 * page's "This PC" and "Phone" tabs can both go back to their last result.
 */
export function toForget(list, keep = KEEP) {
  const newestOf = new Map(list.map((s) => [s.source, s.id]));
  return list.slice(0, Math.max(0, list.length - keep)).filter((s) => newestOf.get(s.source) !== s.id).map((s) => s.id);
}

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
  for (const id of toForget([...scans.values()])) forget(id);

  const onError = (p, code, kind) => {
    scan.errorCount++;
    if (scan.errors.length < MAX_ERRORS) scan.errors.push(kind ? { path: p, code, kind } : { path: p, code });
  };
  const run = source === 'local'
    ? deps.scanLocal({ root: path, tree: scan.tree, onError, isCancelled: () => scan.cancelled })
      .then(async (r) => {
        if (!scan.cancelled) await sizeLockedFiles(scan, deps.listLockedFiles ?? sizeLockedDefault);
        return r;
      })
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

/** Takes the errors of places that were read after all out of the scan's list and count. */
function dropErrors(scan, found) {
  if (!found.size) return;
  const before = scan.errors.length;
  scan.errors = scan.errors.filter((e) => !found.has(e.path.toLowerCase()));
  scan.errorCount -= before - scan.errors.length;
}

/** Files Windows keeps locked (hiberfil.sys, swapfile.sys…): their sizes from a folder listing instead. */
async function sizeLockedFiles(scan, list) {
  const files = scan.errors.filter((e) => e.kind === 'file' && NO_ACCESS.has(e.code));
  if (!files.length) return;
  const groups = new Map();
  for (const e of files) {
    const dir = win32.dirname(e.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(win32.basename(e.path));
  }
  let entries = [];
  try {
    entries = await list(groups);
  } catch {
    return; // they stay listed as not readable
  }
  const wanted = new Set(files.map((e) => e.path.toLowerCase()));
  const found = new Set();
  for (const e of entries) {
    const key = e.path.toLowerCase();
    const segs = relParts(scan.path, e.path);
    if (e.dir || !wanted.has(key) || found.has(key) || !segs?.length) continue;
    scan.tree.addFile(segs, e.size, e.mtime);
    found.add(key);
  }
  dropErrors(scan, found);
}

/** Folders of a finished PC scan that this account may not open (they can be read as administrator). */
export function protectedFolders(scan) {
  if (scan.source !== 'local') return [];
  return scan.errors.filter((e) => e.kind === 'dir' && NO_ACCESS.has(e.code)).map((e) => e.path);
}

function protectedInfo(scan) {
  const all = scan.state === 'done' || scan.state === 'cancelled' ? protectedFolders(scan) : [];
  return { protectedCount: all.length, protectedSample: all.slice(0, 2).map((p) => win32.basename(p)) };
}

/**
 * Reads the protected folders as administrator (Windows asks first) and adds
 * what is in them to the tree, each marked `locked`. Progress and the outcome
 * are in scan.admin.
 */
export async function sizeProtected(scan, list = listAsAdmin) {
  const folders = protectedFolders(scan).filter((f) => existsSync(f));
  scan.admin = { state: 'running', folders: folders.length };
  try {
    const results = await list(folders);
    const before = scan.tree.root.size;
    const found = new Set();
    for (const { folder, entries } of results) {
      const base = relParts(scan.path, folder);
      if (!entries || !base?.length) continue;
      scan.tree.addDir(base);
      scan.tree.markLocked(base);
      for (const e of entries) {
        const segs = relParts(scan.path, e.path);
        if (!segs || segs.length < base.length) continue;
        if (e.dir) scan.tree.addDir(segs);
        else if (segs.length > base.length) scan.tree.addFile(segs, e.size, e.mtime);
      }
      found.add(folder.toLowerCase());
    }
    scan.tree.finish();
    dropErrors(scan, found);
    scan.admin = { state: 'done', folders: folders.length, read: found.size, bytes: scan.tree.root.size - before };
  } catch (err) {
    scan.admin = { state: 'failed', folders: folders.length, message: err.message };
  }
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
    errors: scan.errors.slice(0, 50).map(({ path, code }) => ({ path, code })),
    ...protectedInfo(scan),
    admin: scan.admin ?? null,
    root: scan.tree.finished ? { id: root.id, name: root.name, size: root.size, count: root.count, dirCount: root.dirCount, mtime: root.mtime } : null,
  };
}
