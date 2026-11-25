// The Browse tab: listing one phone folder at a time, previews, opening,
// saving to this PC and deleting. Items are named by a listing's id and their
// names in it; a raw path is only ever used to list a folder.

import { existsSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { findAdb, parseDf, phonePath, runAdb, serialParam, shQuote } from '../lib/adb.js';
import { canonical, childPath, getListing, keepListing, listFolder, mediaOf, parsePlaces, pick, placesCommand, planOf } from '../lib/browse.js';
import { browseDir, openedPlace, readList, readThumb, saveList, tidyLists, tidyOpened, tidyThumbs, writeThumb } from '../lib/browse-store.js';
import { fail, idParam, ok } from '../lib/http.js';
import { adbBytes, IMAGE_TYPES, mediaKind, packPreviews, previews } from '../lib/preview.js';
import { pullToPc, safeName } from '../lib/pull.js';
import { createPush, phoneContents, phoneName, pushPlan } from '../lib/push.js';
import { removeManyOnPhone } from '../lib/remove.js';
import { getTask, startTask, taskStatus } from '../lib/tasks.js';
import { extOf } from '../lib/tree.js';
import { canOpen, VIDEO_TYPES } from '../public/browse-list.js';
import { formatBytes, formatCount } from '../public/format.js';
import { existingAncestor, localPath } from './scans.js';

/** What the routes use to reach the phone and Windows; tests swap in stand-ins. */
export const deps = { findAdb, run: runAdb, spawnAdb: spawn, adbBytes, statfs, removeManyOnPhone, openFile, createPush };

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

/**
 * The part of a file a Range header asks for: { start, end } (end included),
 * null for the whole file, or false when it can't be given (416).
 */
export function rangeOf(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return false;
  let start;
  let end;
  if (m[1] === '') { // the last n bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]));
  }
  return start <= end && start < size ? { start, end } : false;
}

/** dd reading `length` bytes from `start`, in 1 MB blocks (about twice as fast as cat here). */
export const ddCommand = (path, start = 0, length = null) => {
  const q = shQuote(path);
  if (!start && length == null) return `dd if=${q} bs=1M 2>/dev/null`;
  return `dd if=${q} bs=1M iflag=skip_bytes,count_bytes skip=${start}${length == null ? '' : ` count=${length}`} 2>/dev/null`;
};

/**
 * One file's bytes: a picture or video for the viewer (videos by ranges, so
 * they start at once and can be wound on), or (`download=1`, and anything
 * else) for dragging into Explorer.
 */
export function file({ params, query, headers = {} }) {
  const [l, items, err] = itemsParam(params, [query.get('name')]);
  if (err) return err;
  const [e] = items;
  if (e.dir) return fail(400, 'no-file', 'That is a folder.');
  const ext = extOf(e.name);
  const type = query.get('download') ? null : IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? null;
  const range = VIDEO_TYPES[ext] && type ? rangeOf(headers.range, e.size) : null;
  return {
    raw(res) {
      const head = {
        'Content-Type': type ?? 'application/octet-stream',
        'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(e.name)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(VIDEO_TYPES[ext] ? { 'Accept-Ranges': 'bytes' } : {}),
      };
      if (range === false) {
        res.writeHead(416, { ...head, 'Content-Range': `bytes */${e.size}` }).end();
        return;
      }
      const start = range ? range.start : 0;
      const length = range ? range.end - range.start + 1 : e.size;
      const child = deps.spawnAdb(l.adb, ['-s', l.serial, 'exec-out', ddCommand(childPath(l.path, e.name), start, range ? length : null)], { windowsHide: true });
      res.writeHead(range ? 206 : 200, {
        ...head,
        'Content-Length': String(length), // a short transfer then fails in the browser
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${e.size}` } : {}),
      });
      let sent = 0;
      child.stdout.on('data', (chunk) => {
        const part = sent + chunk.length > length ? chunk.subarray(0, length - sent) : chunk;
        sent += part.length;
        if (part.length && !res.write(part)) {
          child.stdout.pause();
          res.once('drain', () => child.stdout.resume());
        }
      });
      child.stderr?.resume();
      child.on('close', () => (sent === length ? res.end() : res.destroy()));
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

/** The phone's answer to a command that ends with "echo OK" on success, as an error message or null. */
async function phoneDid(l, command, what) {
  const r = await deps.run(l.adb, ['-s', l.serial, 'shell', command], { timeout: 60_000 });
  if (/^OK\r?$/m.test(r.stdout)) return null;
  const said = r.stderr.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  return /^EXISTS\r?$/m.test(r.stdout) ? 'Something of that name is already there.' : said ? `The phone said: ${said.replace(/^(mv|mkdir): /, '')}` : `The phone did not ${what}.`;
}

/** Renames a file or folder; never over something already there. */
export async function rename({ params, body }) {
  const [l, items, err] = itemsParam(params, [body?.name], { fresh: true });
  if (err) return err;
  const [e] = items;
  const to = phoneName(typeof body?.to === 'string' ? body.to.trim() : null);
  if (!to) return fail(400, 'bad-name', 'Give a name without / that is not too long.');
  if (to === e.name) return ok({ name: to });
  if (l.entries.has(to) && to.toLowerCase() !== e.name.toLowerCase()) return fail(409, 'exists', 'Something of that name is already there.');
  const from = shQuote(childPath(l.path, e.name));
  const dest = shQuote(childPath(l.path, to));
  // mv -n leaves an existing file alone; whether it moved is checked, not assumed.
  const problem = await phoneDid(l, `if [ -e ${dest} ] && [ ! ${dest} -ef ${from} ]; then echo EXISTS; else mv -n ${from} ${dest} && [ -e ${dest} ] && ! { [ -e ${from} ] && [ ! ${from} -ef ${dest} ]; } && echo OK; fi`, 'rename it');
  if (problem) return fail(409, 'not-renamed', problem);
  l.entries.delete(e.name);
  l.entries.set(to, { ...e, name: to });
  saveList(l.serial, l.path, { hw: l.hw, entries: [...l.entries.values()] });
  return ok({ name: to });
}

/** Makes a new folder in the listing's folder. */
export async function makeFolder({ params, body }) {
  const [l, err] = listingParam(params);
  if (err) return err;
  if (l.stale) return fail(409, 'stale', 'Still checking this folder on the phone; try again in a moment.');
  const name = phoneName(typeof body?.name === 'string' ? body.name.trim() : null);
  if (!name) return fail(400, 'bad-name', 'Give a name without / that is not too long.');
  if (l.entries.has(name)) return fail(409, 'exists', 'Something of that name is already there.');
  const problem = await phoneDid(l, `mkdir ${shQuote(childPath(l.path, name))} && echo OK`, 'make the folder');
  if (problem) return fail(409, 'not-made', /exists/i.test(problem) ? 'Something of that name is already there.' : problem);
  const e = { name, dir: true, size: 0, mtime: Math.floor(Date.now() / 1000) };
  l.entries.set(name, e);
  saveList(l.serial, l.path, { hw: l.hw, entries: [...l.entries.values()] });
  return ok({ entry: e }, 201);
}

const pushes = new Map(); // task id -> the copy fed by PUT /api/push/:task/:i

/** Free bytes where `path` is on the phone, or null. */
async function phoneFree(l) {
  const r = await deps.run(l.adb, ['-s', l.serial, 'shell', `df -k ${shQuote(l.path)}`], { timeout: 20_000 });
  const rows = parseDf(r.stdout);
  return rows.length ? rows.at(-1).free : null;
}

/** Asks Android to add copied photos and videos to the gallery (a phone only does this by itself for its own camera). */
export const scanCommand = (paths) => paths.map((p) => `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shQuote(`file://${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}`)} >/dev/null 2>&1`).join('; ');

/**
 * Starts a copy from this PC into the listing's folder. `items` are
 * [{ rel: [names], size, mtime }] (rel: the path inside what was dropped). The
 * page then sends each file's bytes to PUT /api/push/:task/:i and ends with
 * POST /api/push/:task/end.
 */
export async function pushStart({ params, body }) {
  const [l, err] = listingParam(params);
  if (err) return err;
  if (l.stale) return fail(409, 'stale', 'Still checking this folder on the phone; try again in a moment.');
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items?.length || items.length > 50_000) return fail(400, 'no-files', 'Choose some files to copy.');
  const clean = [];
  for (const it of items) {
    const rel = Array.isArray(it?.rel) && it.rel.length && it.rel.length <= 64 ? it.rel.map(phoneName) : null;
    if (!rel || rel.includes(null) || !Number.isSafeInteger(it.size) || it.size < 0) return fail(400, 'bad-name', `This name can’t be used on a phone: ${Array.isArray(it?.rel) ? it.rel.join('/') : '?'}`);
    clean.push({ rel, size: it.size, mtime: Number.isFinite(it.mtime) && it.mtime > 0 ? Math.floor(it.mtime) : 0 });
  }
  const tops = [...new Set(clean.filter((it) => it.rel.length > 1).map((it) => it.rel[0]))];
  const there = await phoneContents({ adb: l.adb, serial: l.serial, dest: l.path, entries: l.entries, tops, run: deps.run });
  const plan = pushPlan(l.path, clean, there);
  const bytes = plan.files.filter((f) => !f.skip).reduce((s, f) => s + f.size, 0);
  const free = await phoneFree(l).catch(() => null);
  if (free != null && bytes > free) return fail(400, 'no-space', `This needs ${formatBytes(bytes)} but the phone has only ${formatBytes(free)} free.`);
  const label = clean.length === 1 ? clean[0].rel.at(-1) : tops.length === 1 && clean.every((it) => it.rel[0] === tops[0]) ? tops[0] : `${formatCount(clean.length)} files`;
  let push;
  const task = startTask({ kind: 'push', label: `${label} → ${l.path}`, dest: null }, async (t) => {
    t.totalFiles = plan.files.length;
    t.totalBytes = plan.files.reduce((s, f) => s + f.size, 0);
    try {
      await push.start();
      await push.done;
    } finally {
      pushes.delete(t.id);
      const media = plan.files.filter((f) => !f.skip && mediaKind(f.remote)).map((f) => f.remote);
      if (media.length && !t.cancelled) deps.run(l.adb, ['-s', l.serial, 'shell', scanCommand(media.slice(0, 2000))], { timeout: 10 * 60_000 }).catch(() => {});
    }
  });
  push = deps.createPush({ adb: l.adb, serial: l.serial, plan, task: getTask(task.id), tempDir: join(browseDir(), 'incoming'), run: deps.run, spawnAdb: deps.spawnAdb });
  pushes.set(task.id, push);
  return ok({ task: taskStatus(task), path: l.path, files: plan.files.map((f) => ({ i: f.i, skip: f.skip })) }, 201);
}

/** One file of a copy to the phone, as the request's raw body. */
export async function pushFile({ params, req }) {
  const push = pushes.get(idParam(params.task));
  const i = idParam(params.i);
  if (!push || i == null) {
    req.resume();
    return fail(404, 'no-copy', 'This copy is over.');
  }
  try {
    await push.receive(i, req);
    return ok({ ok: true });
  } catch (err) {
    req.resume();
    return fail(409, 'not-received', err.message);
  }
}
pushFile.rawBody = true;

/** The page has sent every file of a copy. */
export function pushEnd({ params }) {
  const push = pushes.get(idParam(params.task));
  if (!push) return fail(404, 'no-copy', 'This copy is over.');
  push.end();
  return ok({ ok: true });
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
