// Browsing a phone's folders one at a time, without scanning the phone first.
// A listing is kept in memory with everything it found, and every action
// names an item of a listing, never a raw path from the page.

import { spawn } from 'node:child_process';
import { parseStatLine, relSegments, runAdb, shQuote } from './adb.js';
import { pullPlan, safeName } from './pull.js';
import { LIST_END, scanPhone } from './scan-phone.js';
import { createTree } from './tree.js';

const SHARED = '/storage/emulated/0';
const KEEP = 30;
const listings = new Map();
let nextId = 1;

/** The usual other spellings of shared storage, as the one Android's media index uses. */
export const canonical = (path) => path.replace(/^\/(?:sdcard|mnt\/sdcard|storage\/self\/primary)(?=\/|$)/, SHARED);

export const childPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/** The folders offered beside the list: [path below shared storage, label]. */
export const PLACES = [
  ['', 'Internal storage'], ['DCIM/Camera', 'Camera'], ['DCIM', 'DCIM'], ['DCIM/Screenshots', 'Screenshots'], ['Pictures', 'Pictures'],
  ['Pictures/Screenshots', 'Screenshots'], ['Movies', 'Movies'], ['Download', 'Download'], ['Documents', 'Documents'], ['Music', 'Music'], ['Recordings', 'Recordings'],
  ['Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images', 'WhatsApp pictures'], ['Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video', 'WhatsApp videos'],
];

/** Prints which of PLACES exist, and the names in /storage (memory cards are there beside "emulated" and "self"). */
export const placesCommand = () => `${PLACES.map(([p]) => `[ -d ${shQuote(`${SHARED}/${p}`)} ] && echo ${shQuote(`P|${p}`)}`).join('; ')}; ls -1 /storage | while read -r n; do echo "S|$n"; done`;

export function parsePlaces(text) {
  const lines = text.split(/\r?\n/);
  const there = new Set(lines.filter((l) => l.startsWith('P|')).map((l) => l.slice(2)));
  const out = PLACES.filter(([p]) => there.has(p)).map(([p, label]) => ({ label, path: p ? `${SHARED}/${p}` : SHARED }));
  for (const l of lines) {
    const n = l.startsWith('S|') ? l.slice(2).trim() : '';
    if (/^[\w-]{4,40}$/.test(n) && n !== 'emulated' && n !== 'self') out.push({ label: `Memory card ${n}`, path: `/storage/${n}` });
  }
  return out;
}

/** One folder's own entries as "hexmode|size|mtime|path" lines, after the phone's hardware serial and before the end mark. */
export const folderCommand = (path) => {
  const q = shQuote(path === '/' ? '/' : `${path}/`);
  return `echo "HW|$(getprop ro.serialno)"; find -H ${q} -mindepth 1 -maxdepth 1 -print0 | xargs -0 stat -c '%f|%s|%Y|%n'; echo ${LIST_END}`;
};

/** folderCommand's output -> { hw, entries: Map(name -> { name, dir, size, mtime }), ended }. */
export function parseFolder(path, text) {
  const entries = new Map();
  let hw = '';
  let ended = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === LIST_END) ended = true;
    else if (line.startsWith('HW|')) hw = line.slice(3).trim();
    else {
      const e = parseStatLine(line);
      const segs = e && relSegments(path, e.path);
      if (segs?.length !== 1 || (!e.dir && !e.file) || segs[0] === '.' || segs[0] === '..') continue;
      entries.set(segs[0], { name: segs[0], dir: e.dir, size: e.dir ? 0 : e.size, mtime: e.mtime });
    }
  }
  return { hw, entries, ended };
}

/** Lists a folder on the phone and keeps the result. Rejects with the reason when it can't be read. */
export async function listFolder({ adb, serial, path, run = runAdb }) {
  const r = await run(adb, ['-s', serial, 'shell', folderCommand(path)], { timeout: 120_000 });
  const { hw, entries, ended } = parseFolder(path, r.stdout);
  if (!ended) throw new Error(r.stderr.trim() || 'The phone stopped before the end of the list. Check the cable and try again.');
  // An empty folder makes stat say "Needs 1 argument"; anything find says is about the folder itself.
  const problem = r.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => /^find: /.test(l));
  if (problem && !entries.size) {
    throw new Error(/No such file/.test(problem) ? `There is no folder ${path} on the phone.` : /Permission denied/.test(problem) ? `Android keeps ${path} private.` : problem.replace(/^find: /, ''));
  }
  const listing = { id: nextId++, adb, serial, hw: hw || serial, path, entries, media: null };
  listings.set(listing.id, listing);
  for (const id of listings.keys()) {
    if (listings.size <= KEEP) break;
    listings.delete(id);
  }
  return listing;
}

/** A kept listing (used again = kept longer), or null. */
export function getListing(id) {
  const l = listings.get(id);
  if (!l) return null;
  listings.delete(id);
  listings.set(id, l);
  return l;
}

/** Asks Android's media index about one folder's photos and videos (`content query`). */
export const mediaCommand = (path) => {
  const p = path.replace(/'/g, "''");
  const where = `media_type IN (1,3) AND _data LIKE '${p}/%' AND _data NOT LIKE '${p}/%/%'`;
  return `content query --uri content://media/external/file --projection _id:media_type:width:height:duration:_data --where ${shQuote(where)}`;
};

/** mediaCommand's output -> Map(name -> { id, video, w, h, ms }). */
export function parseMedia(path, text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^Row: \d+ _id=(\d+), media_type=(\d), width=(\w*), height=(\w*), duration=(\w*), _data=(\/.*)$/.exec(line);
    const segs = m && relSegments(path, m[6]);
    if (segs?.length !== 1) continue; // LIKE treats _ and % in a folder's name as wildcards
    const n = (v) => (/^\d+$/.test(v) ? Number(v) : 0);
    out.set(segs[0], { id: m[1], video: m[2] === '3', w: n(m[3]), h: n(m[4]), ms: n(m[5]) });
  }
  return out;
}

/** The media index's answer for a listing, asked once. An empty Map when the phone has none. */
export function mediaOf(listing, run = runAdb) {
  listing.media ??= run(listing.adb, ['-s', listing.serial, 'shell', mediaCommand(listing.path)], { timeout: 60_000 })
    .then((r) => parseMedia(listing.path, r.stdout));
  return listing.media;
}

/** The entries with these names, or null when one isn't in the listing (or none are named). */
export function pick(listing, names) {
  if (!Array.isArray(names) || !names.length || names.length > 20_000) return null;
  const out = [...new Set(names)].map((n) => (typeof n === 'string' ? listing.entries.get(n) : undefined));
  return out.every(Boolean) ? out : null;
}

/**
 * What copying these items involves, in pullToPc()'s form. Folders are read
 * on the phone first, with everything inside them; `unread` lists what in
 * them Android keeps private.
 */
export async function planOf(listing, items, { spawnAdb = spawn, run = runAdb } = {}) {
  const single = items.length === 1;
  const plan = { name: single ? safeName(items[0].name) : '', isFile: single && !items[0].dir, dirs: [], files: [], totalBytes: 0, unread: [] };
  for (const e of items) {
    const path = childPath(listing.path, e.name);
    const name = safeName(e.name);
    if (!e.dir) {
      plan.files.push({ remote: path, rel: [name], size: e.size, mtime: e.mtime });
      continue;
    }
    const tree = createTree(path, '/');
    const r = await scanPhone({ adb: listing.adb, serial: listing.serial, root: path, tree, onError: (p, message) => plan.unread.push({ path: p, message }), spawnAdb, run });
    if (r.incomplete) throw new Error('The phone stopped before the end of the list. Check the cable and try again.');
    const inner = pullPlan(tree, tree.root);
    const rel = (parts) => (single ? parts : [name, ...parts]);
    plan.dirs.push(...inner.dirs.map(rel));
    plan.files.push(...inner.files.map((f) => ({ ...f, rel: rel(f.rel) })));
  }
  plan.totalBytes = plan.files.reduce((s, f) => s + f.size, 0);
  return plan;
}
