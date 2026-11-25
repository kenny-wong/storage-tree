// What browsing keeps on this PC: previews already fetched (so a folder seen
// before needs nothing from the phone), the folders' lists (so a big folder
// shows at once, even after a restart, while the phone is asked again) and
// copies of files that were opened.
// Both live in "browse" in the app's data folder and are tidied up here.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX = 600 * 1024 * 1024;
const KEEP = 450 * 1024 * 1024;
const OPENED_DAYS = 2;
const LISTS = 300;

export const browseDir = () => process.env.STORAGE_TREE_BROWSE_DIR || join(process.env.LOCALAPPDATA || tmpdir(), 'Storage Tree', 'browse');

const keyOf = (hw, path, e) => createHash('sha256').update(`${hw}\0${path}\0${e.size}\0${e.mtime}`).digest('hex').slice(0, 32);

const thumbFile = (root, hw, path, e) => {
  const k = keyOf(hw, path, e);
  return join(root, 'thumbs', k.slice(0, 2), `${k}.jpg`);
};

/** A kept preview, or null. A file that changed on the phone has another size or date, so another name here. */
export async function readThumb(hw, path, e, root = browseDir()) {
  const f = thumbFile(root, hw, path, e);
  try {
    const data = await readFile(f);
    const now = new Date();
    utimes(f, now, now).catch(() => {}); // the least recently seen go first
    return data;
  } catch {
    return null;
  }
}

export async function writeThumb(hw, path, e, data, root = browseDir()) {
  const f = thumbFile(root, hw, path, e);
  try {
    await mkdir(join(f, '..'), { recursive: true });
    const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, f).catch(() => unlink(tmp).catch(() => {}));
  } catch { /* a full or read-only disk: previews are only fetched again */ }
}

/** Keeps the previews under MAX by deleting the least recently seen. */
export async function tidyThumbs(root = browseDir(), { max = MAX, keep = KEEP } = {}) {
  const files = [];
  const top = join(root, 'thumbs');
  for (const d of await readdir(top).catch(() => [])) {
    for (const n of await readdir(join(top, d)).catch(() => [])) {
      const f = join(top, d, n);
      const s = await stat(f).catch(() => null);
      if (s?.isFile()) files.push({ f, size: s.size, at: s.mtimeMs });
    }
  }
  let total = files.reduce((s, x) => s + x.size, 0);
  if (total <= max) return 0;
  files.sort((a, b) => a.at - b.at);
  let gone = 0;
  for (const x of files) {
    if (total <= keep) break;
    await unlink(x.f).catch(() => {});
    total -= x.size;
    gone++;
  }
  return gone;
}

const listFile = (root, serial, path) => join(root, 'lists', `${createHash('sha256').update(`${serial}\0${path}`).digest('hex').slice(0, 32)}.json`);

/**
 * Saves a folder's list as the phone last gave it: { hw, entries, media }
 * (`media` as [name, { id, video, w, h, ms }] pairs, or null when not known yet).
 * By the adb serial, so the same phone over Wi-Fi has lists of its own.
 */
export async function saveList(serial, path, { hw, entries, media = null }, root = browseDir()) {
  const f = listFile(root, serial, path);
  try {
    await mkdir(join(f, '..'), { recursive: true });
    const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify({ serial, path, hw, entries, media, saved: Date.now() }));
    await rename(tmp, f).catch(() => unlink(tmp).catch(() => {}));
  } catch { /* a full or read-only disk: the phone is asked as before */ }
}

/** A saved list, or null. Anything that doesn't look like one of ours is ignored. */
export async function readList(serial, path, root = browseDir()) {
  try {
    const v = JSON.parse(await readFile(listFile(root, serial, path), 'utf8'));
    if (v?.serial !== serial || v.path !== path || !Array.isArray(v.entries) || typeof v.hw !== 'string') return null;
    const entries = v.entries.filter((e) => typeof e?.name === 'string' && e.name && !e.name.includes('/') && Number.isFinite(e.size) && Number.isFinite(e.mtime) && typeof e.dir === 'boolean');
    const media = Array.isArray(v.media) ? v.media.filter((m) => Array.isArray(m) && typeof m[0] === 'string' && typeof m[1]?.id === 'string') : null;
    return { hw: v.hw, entries, media, saved: Number(v.saved) || 0 };
  } catch {
    return null;
  }
}

/** Keeps the newest LISTS saved lists. */
export async function tidyLists(root = browseDir(), keep = LISTS) {
  const top = join(root, 'lists');
  const files = [];
  for (const n of await readdir(top).catch(() => [])) {
    const s = await stat(join(top, n)).catch(() => null);
    if (s?.isFile()) files.push({ f: join(top, n), at: s.mtimeMs });
  }
  files.sort((a, b) => b.at - a.at);
  for (const x of files.slice(keep)) await unlink(x.f).catch(() => {});
  return Math.max(0, files.length - keep);
}

const openedName = (hw, path, e) => `${e.size}-${e.mtime}-${keyOf(hw, path, e).slice(0, 12)}`;
/** Is this still the phone's version? (Copies get the phone's date, to the second.) */
const untouched = (s, size, mtime) => s.size === size && (!mtime || Math.abs(s.mtimeMs / 1000 - mtime) < 2);

/**
 * Where a file is copied to be opened: { dir, file, ready }. `ready` when an
 * unchanged copy is already there. A copy the user has edited is never
 * replaced; a new one gets its own folder.
 */
export async function openedPlace(hw, path, e, name, root = browseDir()) {
  for (let i = 0; i < 100; i++) {
    const dir = join(root, 'opened', `${openedName(hw, path, e)}${i ? `_${i}` : ''}`);
    const file = join(dir, name);
    const s = await stat(file).catch(() => null);
    if (!s) return { dir, file, ready: false };
    if (untouched(s, e.size, e.mtime)) return { dir, file, ready: true };
  }
  throw new Error('Too many edited copies of this file');
}

/** Deletes opened copies older than two days that were not changed since. Edited ones stay. */
export async function tidyOpened(root = browseDir(), now = Date.now()) {
  const top = join(root, 'opened');
  let gone = 0;
  for (const d of await readdir(top).catch(() => [])) {
    const m = /^(\d+)-(\d+)-[0-9a-f]{12}(?:_\d+)?$/.exec(d);
    const dir = join(top, d);
    const st = m && await stat(dir).catch(() => null);
    if (!st?.isDirectory() || now - st.birthtimeMs < OPENED_DAYS * 86_400_000) continue;
    const names = await readdir(dir).catch(() => []);
    const stats = await Promise.all(names.map((n) => stat(join(dir, n)).catch(() => null)));
    if (!stats.every((s, i) => s?.isFile() && (untouched(s, Number(m[1]), Number(m[2])) || /^storagetree-[0-9a-f]{12}\.part$/.test(names[i])))) continue;
    for (const n of names) await unlink(join(dir, n)).catch(() => {}); // fails while a program has it open: next time
    if (await rmdir(dir).then(() => true, () => false)) gone++;
  }
  return gone;
}
