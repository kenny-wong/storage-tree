// Starting, following and browsing scans.

import { existsSync, statSync } from 'node:fs';
import { lstat, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { findAdb, phonePath, serialParam, shQuote } from '../lib/adb.js';
import { fail, idParam, ok } from '../lib/http.js';
import { formatBytes } from '../public/format.js';
import { pullPlan, pullToPc } from '../lib/pull.js';
import { recycle, removeOnPhone } from '../lib/remove.js';
import { cancelScan, forget, getScan, protectedFolders, scanStatus, sizeProtected, startScan } from '../lib/scans.js';
import { startTask, taskStatus } from '../lib/tasks.js';
import { childrenOf, crumbs, fileTypes, largestFiles } from '../lib/tree.js';

/** What the routes below use to change things; tests swap in stand-ins. */
export const deps = { recycle, removeOnPhone, findAdb, spawnAdb: spawn, statfs, listAsAdmin: undefined };

/** A folder on this PC to scan, or null. "C:" becomes "C:\". */
export function localPath(p) {
  if (typeof p !== 'string' || !p.trim() || /[\x00-\x1f]/.test(p)) return null;
  let t = p.trim().replace(/^"(.*)"$/, '$1');
  if (/^[a-z]:$/i.test(t)) t += '\\';
  if (!isAbsolute(t)) return null;
  return resolve(t);
}

export function create({ body }) {
  if (body?.source === 'local') {
    const path = localPath(body.path);
    if (!path) return fail(400, 'bad-path', 'Give a full folder path, such as C:\\Users or D:.');
    if (!existsSync(path) || !statSync(path).isDirectory()) return fail(400, 'not-found', `There is no folder ${path}.`);
    return ok(scanStatus(startScan({ source: 'local', path, sep })), 201);
  }
  if (body?.source === 'phone') {
    const serial = serialParam(body.serial);
    const path = phonePath(body.path ?? '/storage/emulated/0');
    if (!serial) return fail(400, 'bad-serial', 'Choose a phone first.');
    if (!path) return fail(400, 'bad-path', 'Give a phone folder starting with /, such as /storage/emulated/0.');
    const adb = findAdb();
    if (!adb) return fail(400, 'no-adb', 'adb was not found.');
    const label = typeof body.label === 'string' ? body.label.slice(0, 100) : serial;
    return ok(scanStatus(startScan({ source: 'phone', path, serial, adb, label, sep: '/' })), 201);
  }
  return fail(400, 'bad-source', 'Scan this PC or a phone.');
}

function scanParam(params) {
  const scan = getScan(idParam(params.id));
  return scan ?? null;
}

export function status({ params }) {
  const scan = scanParam(params);
  return scan ? ok(scanStatus(scan)) : fail(404, 'no-scan', 'That scan is gone; scan again.');
}

function finishedScan(params) {
  const scan = scanParam(params);
  if (!scan) return [null, fail(404, 'no-scan', 'That scan is gone; scan again.')];
  if (!scan.tree.finished) return [null, fail(409, 'scanning', 'Still scanning.')];
  return [scan, null];
}

function dirParam(scan, v) {
  const id = idParam(v);
  const d = id == null ? null : scan.tree.dirs[id] ?? null;
  return d && scan.tree.alive(d) ? d : null;
}

/** The folder and (optional) file a request names, checked against the scan: [d, fileName, error]. */
function itemParam(scan, dir, file) {
  const d = dirParam(scan, String(dir ?? ''));
  if (!d) return [null, null, fail(404, 'no-folder', 'No such folder in this scan.')];
  if (file == null || file === '') return [d, null, null];
  if (typeof file !== 'string' || !d.files.some((f) => f.name === file)) return [null, null, fail(404, 'no-file', 'No such file in this scan.')];
  return [d, file, null];
}

/** One folder: its totals, the path down to it and its contents (depth 2 for the treemap). */
export function node({ params, query }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  const d = dirParam(scan, params.nid);
  if (!d) return fail(404, 'no-folder', 'No such folder in this scan.');
  const depth = Math.min(3, Math.max(1, Number(query.get('depth')) || 1));
  const limit = Math.min(5000, Math.max(1, Number(query.get('limit')) || 1000));
  return ok({
    id: d.id,
    name: d.name,
    path: scan.tree.pathOf(d),
    size: d.size,
    count: d.count,
    dirCount: d.dirCount,
    mtime: d.mtime,
    crumbs: crumbs(d),
    children: childrenOf(d, { limit, depth }),
    ...(insideLocked(d) ? { locked: true } : {}),
  });
}

const insideLocked = (d) => {
  for (let n = d; n; n = n.parent) if (n.locked) return true;
  return false;
};

/** Reads the folders this account may not open, as administrator (Windows asks first). This PC's scans only. */
export function readProtected({ params }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  if (scan.source !== 'local') return fail(400, 'not-local', 'Only scans of this PC have protected folders.');
  if (scan.admin?.state === 'running') return fail(409, 'running', 'Already reading the protected folders.');
  if (!protectedFolders(scan).length) return fail(400, 'none', 'This scan has no protected folders left to read.');
  sizeProtected(scan, deps.listAsAdmin);
  return ok(scanStatus(scan), 202);
}

export function largest({ params, query }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  const d = dirParam(scan, query.get('under') ?? '0') ?? scan.tree.root;
  const n = Math.min(2000, Math.max(1, Number(query.get('n')) || 200));
  return ok({ under: d.id, files: largestFiles(scan.tree, n, d) });
}

export function types({ params, query }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  const d = dirParam(scan, query.get('under') ?? '0') ?? scan.tree.root;
  return ok({ under: d.id, size: d.size, types: fileTypes(scan.tree, d) });
}

export function cancel({ params }) {
  return cancelScan(idParam(params.id)) ? ok({ ok: true }) : fail(404, 'no-scan', 'That scan is gone.');
}

export function remove({ params }) {
  return forget(idParam(params.id)) ? ok({ ok: true }) : fail(404, 'no-scan', 'That scan is gone.');
}

/** Shows a scanned folder (or a file in it) in Windows Explorer. This PC's scans only. */
export function reveal({ params, body }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  if (scan.source !== 'local') return fail(400, 'not-local', 'Only folders on this PC can be shown in Explorer.');
  const d = dirParam(scan, String(body?.dir ?? ''));
  if (!d) return fail(404, 'no-folder', 'No such folder in this scan.');
  const file = typeof body?.file === 'string' && d.files.some((f) => f.name === body.file) ? body.file : null;
  const path = scan.tree.pathOf(d, file ?? undefined);
  if (!existsSync(path)) return fail(404, 'gone', `${path} is no longer there.`);
  if (process.platform === 'win32') {
    spawn('explorer.exe', file ? [`/select,${path}`] : [path], { detached: true, stdio: 'ignore' }).unref();
  }
  return ok({ ok: true, path });
}

/**
 * Deletes a file or folder the scan found: to the Recycle Bin on this PC, for
 * good on a phone. The scan's totals are updated without scanning again.
 */
export async function removeItem({ params, body }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  const [d, file, bad] = itemParam(scan, body?.dir, body?.file);
  if (bad) return bad;
  if (!file && !d.parent) return fail(400, 'root', 'The scanned folder itself can’t be deleted here; open the folder above it instead.');
  const path = scan.tree.pathOf(d, file ?? undefined);
  const size = file ? d.files.find((f) => f.name === file).size : d.size;
  const forget = () => (file ? scan.tree.removeFile(d, file) : scan.tree.removeDir(d));
  try {
    if (scan.source === 'local') {
      let st;
      try {
        st = await lstat(path);
      } catch {
        forget();
        return fail(404, 'gone', `${path} is no longer there.`);
      }
      if (st.isSymbolicLink() || st.isDirectory() !== !file) return fail(409, 'changed', `${path} has changed since the scan; scan again.`);
      await deps.recycle([path]);
    } else {
      const adb = deps.findAdb();
      if (!adb) return fail(400, 'no-adb', 'adb was not found.');
      await deps.removeOnPhone({ adb, serial: scan.serial, path });
    }
  } catch (e) {
    return fail(409, 'not-deleted', e.message);
  }
  forget();
  return ok({ ok: true, path, size, parent: file ? d.id : d.parent.id, recycled: scan.source === 'local', scan: scanStatus(scan) });
}

/** The nearest folder of `path` that exists (for free space before a copy). */
function existingAncestor(path) {
  let p = path;
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) return null;
    p = up;
  }
  return p;
}

/** Copies a phone file or folder the scan found into a folder on this PC, as a background task. */
export async function pull({ params, body }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  if (scan.source !== 'phone') return fail(400, 'not-phone', 'Only a phone’s files can be saved to this PC.');
  const [d, file, bad] = itemParam(scan, body?.dir, body?.file);
  if (bad) return bad;
  const dest = localPath(body?.dest);
  if (!dest) return fail(400, 'bad-dest', 'Give a full folder path on this PC, such as C:\\Users\\you\\Downloads.');
  if (existsSync(dest) && !statSync(dest).isDirectory()) return fail(400, 'bad-dest', `${dest} is a file, not a folder.`);
  const adb = deps.findAdb();
  if (!adb) return fail(400, 'no-adb', 'adb was not found.');
  const plan = pullPlan(scan.tree, d, file);
  const base = existingAncestor(dest);
  if (base) {
    try {
      const s = await deps.statfs(base);
      const free = s.bavail * s.bsize;
      if (plan.totalBytes > free) return fail(400, 'no-space', `This needs ${formatBytes(plan.totalBytes)} but ${base} has only ${formatBytes(free)} free.`);
    } catch { /* free space unknown: try anyway */ }
  }
  const what = file ?? (d.parent ? d.name : scan.path);
  const task = startTask({ kind: 'pull', label: `${what} from ${scan.label}`, dest: join(dest, plan.name), isFile: plan.isFile },
    (t) => pullToPc({ adb, serial: scan.serial, plan, dest, task: t, spawnAdb: deps.spawnAdb }));
  return ok(taskStatus(task), 201);
}

/**
 * One phone file's bytes, streamed from the phone as they arrive. The page
 * uses it for dragging a file out of the window into Explorer (Chrome's
 * DownloadURL drag), so nothing is copied to a temporary file first.
 */
export function file({ params, query }) {
  const [scan, err] = finishedScan(params);
  if (err) return err;
  if (scan.source !== 'phone') return fail(400, 'not-phone', 'Only a phone’s files are served.');
  const [d, name, bad] = itemParam(scan, query.get('dir'), query.get('name') ?? '');
  if (bad) return bad;
  if (!name) return fail(400, 'no-file', 'Name a file.');
  const adb = deps.findAdb();
  if (!adb) return fail(400, 'no-adb', 'adb was not found.');
  const { size } = d.files.find((f) => f.name === name);
  const remote = scan.tree.pathOf(d, name);
  return {
    raw(res) {
      const child = deps.spawnAdb(adb, ['-s', scan.serial, 'exec-out', `cat ${shQuote(remote)} 2>/dev/null`], { windowsHide: true });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size), // a short transfer then fails in the browser instead of leaving a cut-off file
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      let sent = 0;
      child.stdout.on('data', (chunk) => {
        if (sent + chunk.length > size) chunk = chunk.subarray(0, Math.max(0, size - sent));
        sent += chunk.length;
        if (chunk.length && !res.write(chunk)) {
          child.stdout.pause();
          res.once('drain', () => child.stdout.resume());
        }
      });
      child.stderr?.resume();
      child.on('close', () => res.end());
      child.on('error', () => res.destroy());
      res.on('close', () => { if (child.exitCode == null) child.kill(); });
    },
  };
}
