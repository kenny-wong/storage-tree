// Starting, following and browsing scans.

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { findAdb, phonePath, serialParam } from '../lib/adb.js';
import { fail, idParam, ok } from '../lib/http.js';
import { cancelScan, forget, getScan, scanStatus, startScan } from '../lib/scans.js';
import { childrenOf, crumbs, fileTypes, largestFiles } from '../lib/tree.js';

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
  return id == null ? null : scan.tree.dirs[id] ?? null;
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
  });
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
