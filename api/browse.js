// The Browse tab: listing one phone folder at a time, previews, opening,
// saving to this PC and deleting. Items are named by a listing's id and their
// names in it; a raw path is only ever used to list a folder.

import { existsSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { findAdb, phonePath, runAdb, serialParam, shQuote } from '../lib/adb.js';
import { canonical, childPath, getListing, keepListing, listFolder, mediaOf, parsePlaces, pick, placesCommand, planOf } from '../lib/browse.js';
import { browseDir, openedPlace, readList, readThumb, saveList, tidyLists, tidyOpened, tidyThumbs, writeThumb } from '../lib/browse-store.js';
import { fail, idParam, ok } from '../lib/http.js';
import { adbBytes, IMAGE_TYPES, mediaKind, packPreviews, previews } from '../lib/preview.js';
import { pullToPc, safeName } from '../lib/pull.js';
import { removeManyOnPhone } from '../lib/remove.js';
import { startTask, taskStatus } from '../lib/tasks.js';
import { extOf } from '../lib/tree.js';
import { canOpen } from '../public/browse-list.js';
import { formatBytes } from '../public/format.js';
import { existingAncestor, localPath } from './scans.js';

/** What the routes use to reach the phone and Windows; tests swap in stand-ins. */
export const deps = { findAdb, run: runAdb, spawnAdb: spawn, adbBytes, statfs, removeManyOnPhone, openFile };

const MAX_BATCH = 64;
const MAX_KEPT = 512 * 1024; // a preview the page made small
let tidied = false;

/** Opens a file in its usual Windows program. The path goes through the environment, so nothing in a name is read as a command. */
function openFile(path) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return resolve();
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:STORAGE_TREE_OPEN'], {
      windowsHide: true, timeout: 30_000, env: { ...process.env, STORAGE_TREE_OPEN: path },
    }, (err, _out, stderr) => (err ? reject(new Error(stderr.split(/\r?\n/)[0] || 'Windows could not open it.')) : resolve()));
  });
}

const noAdb = () => fail(400, 'no-adb', 'adb was not found.');

/** The usual folders this phone has, and its memory cards. */
export async function places({ query }) {
  const serial = serialParam(query.get('serial'));
  if (!serial) return fail(400, 'bad-serial', 'Choose a phone first.');
  const adb = deps.findAdb();
  if (!adb) return noAdb();
  const r = await deps.run(adb, ['-s', serial, 'shell', placesCommand()], { timeout: 20_000 });
  return ok({ places: parsePlaces(r.stdout) });
}

export async function list({ body }) {
  const serial = serialParam(body?.serial);
  const given = phonePath(body?.path);
  if (!serial) return fail(400, 'bad-serial', 'Choose a phone first.');
  if (!given || given.split('/').some((s) => s === '.' || s === '..')) return fail(400, 'bad-path', 'Give a phone folder starting with /, such as /storage/emulated/0.');
  const adb = deps.findAdb();
  if (!adb) return noAdb();
  if (!tidied) {
    tidied = true;
    Promise.all([tidyThumbs(), tidyOpened(), tidyLists()]).catch(() => {});
  }
  const path = canonical(given);
  // `saved`: the list kept on this PC, at once, without asking the phone (null when there is none).
  if (body.saved) {
    const s = await readList(serial, path);
    if (!s) return ok({ saved: null });
    const l = keepListing({ adb, serial, hw: s.hw, path, entries: new Map(s.entries.map((e) => [e.name, e])), media: s.media && new Map(s.media), stale: true });
    return ok({ id: l.id, path, entries: s.entries, saved: s.saved, media: s.media ? mediaBody(l, new Map(s.media)) : null });
  }
  try {
    const l = await listFolder({ adb, serial, path, run: deps.run });
    saveList(serial, path, { hw: l.hw, entries: [...l.entries.values()] });
    return ok({ id: l.id, path: l.path, entries: [...l.entries.values()] }, 201);
  } catch (err) {
    return fail(409, 'not-listed', err.message);
  }
}

/** The listing a request is about: [listing, error]. */
function listingParam(params) {
  const l = getListing(idParam(params.id));
  return l ? [l, null] : [null, fail(404, 'no-listing', 'This folder’s list is out of date; reload it.')];
}

function itemsParam(params, names, { fresh = false } = {}) {
  const [l, err] = listingParam(params);
  if (err) return [null, null, err];
  if (fresh && l.stale) return [null, null, fail(409, 'stale', 'Still checking this folder on the phone; try again in a moment.')];
  const items = pick(l, names);
  return items ? [l, items, null] : [null, null, fail(404, 'no-item', 'That isn’t in this folder’s list; reload it.')];
}

/** The page's form of Android's index: { name: [width, height, ms] }. */
const mediaBody = (_l, index) => Object.fromEntries([...index].map(([name, m]) => [name, [m.w, m.h, m.ms]]));

/** Android's index of the listing's folder, asked once; a fresh answer is saved with the folder's list. */
function mediaFor(l) {
  const asked = !l.media;
  const p = mediaOf(l, deps.run);
  if (asked && !l.stale) {
    p.then((index) => saveList(l.serial, l.path, { hw: l.hw, entries: [...l.entries.values()], media: [...index] })).catch(() => {});
  }
  return p;
}

/** Dimensions and lengths of the folder's photos and videos, from Android's index. */
export async function media({ params }) {
  const [l, err] = listingParam(params);
  if (err) return err;
  return ok({ media: mediaBody(l, await mediaFor(l)) });
}

/** Keeps a preview the page made small from a whole picture, so it isn't read whole again. */
export async function keep({ params, body }) {
  const [l, items, err] = itemsParam(params, [body?.name]);
  if (err) return err;
  const [e] = items;
  const data = typeof body?.data === 'string' && body.data.length < MAX_KEPT * 1.4 ? Buffer.from(body.data, 'base64') : null;
  if (e.dir || !mediaKind(e.name) || !data || data.length < 100 || data.length > MAX_KEPT || data.readUInt16BE(0) !== 0xffd8) return fail(400, 'bad-preview', 'That isn’t a small JPEG preview.');
  await writeThumb(l.hw, childPath(l.path, e.name), e, data);
  return ok({ kept: true });
}

/** Previews of up to 64 items in one answer (packPreviews), from this PC's store or the phone. Stops when the page goes elsewhere. */
export function thumbs({ params, body }) {
  if (body?.names?.length > MAX_BATCH) return fail(400, 'too-many', `Ask for at most ${MAX_BATCH} previews at once.`);
  const [l, items, err] = itemsParam(params, body?.names);
  if (err) return err;
  return {
    async raw(res) {
      const stop = new AbortController();
      res.on('close', () => stop.abort());
      const out = new Map();
      const wanted = [];
      await Promise.all(items.map(async (e) => {
        if (e.dir || !mediaKind(e.name)) return;
        const path = childPath(l.path, e.name);
        const data = await readThumb(l.hw, path, e);
        if (data) out.set(e.name, { data, type: 'image/jpeg', whole: false });
        else wanted.push({ ...e, path });
      }));
      if (wanted.length && !stop.signal.aborted) {
        const got = await previews(wanted, {
          exec: (command) => (stop.signal.aborted ? Promise.resolve(Buffer.alloc(0)) : deps.adbBytes(l.adb, l.serial, command, { signal: stop.signal })),
          media: () => mediaFor(l),
        });
        for (const [name, p] of got) {
          out.set(name, p);
          if (!p.whole) writeThumb(l.hw, childPath(l.path, name), l.entries.get(name) ?? { size: 0, mtime: 0 }, p.data);
        }
      }
      if (stop.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(packPreviews(out));
    },
  };
}

/** One file's bytes: a picture to show in the viewer, or (`download=1`, and anything else) for dragging into Explorer. */
export function file({ params, query }) {
  const [l, items, err] = itemsParam(params, [query.get('name')]);
  if (err) return err;
  const [e] = items;
  if (e.dir) return fail(400, 'no-file', 'That is a folder.');
  const type = query.get('download') ? null : IMAGE_TYPES[extOf(e.name)];
  return {
    raw(res) {
      // dd in 1 MB blocks: about twice as fast as cat here
      const child = deps.spawnAdb(l.adb, ['-s', l.serial, 'exec-out', `dd if=${shQuote(childPath(l.path, e.name))} bs=1M 2>/dev/null`], { windowsHide: true });
      res.writeHead(200, {
        'Content-Type': type ?? 'application/octet-stream',
        'Content-Length': String(e.size), // a short transfer then fails in the browser
        'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(e.name)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      let sent = 0;
      child.stdout.on('data', (chunk) => {
        const part = sent + chunk.length > e.size ? chunk.subarray(0, e.size - sent) : chunk;
        sent += part.length;
        if (part.length && !res.write(part)) {
          child.stdout.pause();
          res.once('drain', () => child.stdout.resume());
        }
      });
      child.stderr?.resume();
      child.on('close', () => (sent === e.size ? res.end() : res.destroy()));
      child.on('error', () => res.destroy());
      res.on('close', () => { if (child.exitCode == null) child.kill(); });
    },
  };
}

/** Copies a file to this PC and opens it in its usual Windows program. Only kinds that can't run anything. */
export async function open({ params, body }) {
  const [l, items, err] = itemsParam(params, [body?.name], { fresh: true });
  if (err) return err;
  const [e] = items;
  if (e.dir || !canOpen(e.name)) return fail(400, 'not-openable', 'This kind of file isn’t opened from here; save it to the PC instead.');
  const path = childPath(l.path, e.name);
  try {
    const place = await openedPlace(l.hw, path, e, safeName(e.name));
    if (place.ready) {
      await deps.openFile(place.file);
      return ok({ opened: true });
    }
    const short = await noSpace(e.size, browseDir());
    if (short) return short;
    const plan = { name: safeName(e.name), isFile: true, dirs: [], files: [{ remote: path, rel: [safeName(e.name)], size: e.size, mtime: e.mtime }], totalBytes: e.size };
    const task = startTask({ kind: 'open', label: e.name, dest: place.file, isFile: true }, async (t) => {
      await pullToPc({ adb: l.adb, serial: l.serial, plan, dest: place.dir, task: t, spawnAdb: deps.spawnAdb });
      if (!t.cancelled && !t.errorCount) await deps.openFile(place.file);
    });
    return ok({ opened: false, task: taskStatus(task) }, 201);
  } catch (e2) {
    return fail(409, 'not-opened', e2.message);
  }
}

/** An answer saying the disk is too full for `bytes` at `dest`, or null. */
async function noSpace(bytes, dest) {
  const base = existingAncestor(dest);
  if (!base) return null;
  try {
    const s = await deps.statfs(base);
    const free = s.bavail * s.bsize;
    if (bytes > free) return fail(400, 'no-space', `This needs ${formatBytes(bytes)} but ${base} has only ${formatBytes(free)} free.`);
  } catch { /* free space unknown: try anyway */ }
  return null;
}

/** How much the named items hold (folders are read on the phone), for the Save and Delete dialogs. */
export async function measure({ params, body }) {
  const [l, items, err] = itemsParam(params, body?.names, { fresh: true });
  if (err) return err;
  try {
    const plan = await planOf(l, items, deps);
    return ok({ files: plan.files.length, size: plan.totalBytes, unread: plan.unread.length });
  } catch (e) {
    return fail(409, 'not-read', e.message);
  }
}

/** Copies the named items into a folder on this PC, as a background task. */
export async function pull({ params, body }) {
  const [l, items, err] = itemsParam(params, body?.names, { fresh: true });
  if (err) return err;
  const dest = localPath(body?.dest);
  if (!dest) return fail(400, 'bad-dest', 'Give a full folder path on this PC, such as C:\\Users\\you\\Downloads.');
  if (existsSync(dest) && !statSync(dest).isDirectory()) return fail(400, 'bad-dest', `${dest} is a file, not a folder.`);
  let plan;
  try {
    plan = await planOf(l, items, deps);
  } catch (e) {
    return fail(409, 'not-read', e.message);
  }
  const short = await noSpace(plan.totalBytes, dest);
  if (short) return short;
  const label = items.length === 1 ? items[0].name : `${items.length} items from ${l.path}`;
  const task = startTask({ kind: 'pull', label, dest: plan.name ? join(dest, plan.name) : dest, isFile: plan.isFile },
    (t) => {
      for (const u of plan.unread) t.addError(u.path, u.message);
      return pullToPc({ adb: l.adb, serial: l.serial, plan, dest, task: t, spawnAdb: deps.spawnAdb });
    });
  return ok(taskStatus(task), 201);
}

/** Deletes the named items on the phone for good. What is really gone leaves the listing, also when some could not be deleted. */
export async function remove({ params, body }) {
  const [l, items, err] = itemsParam(params, body?.names, { fresh: true });
  if (err) return err;
  const paths = new Map(items.map((e) => [childPath(l.path, e.name), e]));
  const { left, error } = await deps.removeManyOnPhone({ adb: l.adb, serial: l.serial, paths: [...paths.keys()] });
  const kept = new Set(left);
  const deleted = [...paths].filter(([p]) => !kept.has(p)).map(([, e]) => e.name);
  for (const n of deleted) l.entries.delete(n);
  if (deleted.length) saveList(l.serial, l.path, { hw: l.hw, entries: [...l.entries.values()] });
  return ok({ deleted, left: left.length, error });
}
