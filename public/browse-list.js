// The Browse tab's sums (no DOM, so they are unit tested): what is shown in
// which order, what may be opened, and which tiles are on screen.

import { kindOf, KIND_NAMES } from './kinds.js';

export const extOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
};

export const kindOfEntry = (e) => (e.dir ? 'dir' : kindOf(extOf(e.name)));

/** "JPG picture" style type names, as a Type column shows them. */
export function typeName(e) {
  if (e.dir) return 'Folder';
  const ext = extOf(e.name);
  const kind = { image: 'picture', video: 'video', audio: 'audio', document: 'document', archive: 'archive', app: 'app', data: 'data' }[kindOf(ext)] ?? 'file';
  return ext ? `${ext.toUpperCase()} ${kind}` : 'File';
}

// Opened in their Windows programs from here: only kinds that can't run anything by being opened.
const OPENABLE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'dng', 'avif',
  'mp4', 'mov', 'mkv', 'avi', 'wmv', 'webm', 'm4v', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'amr', 'pdf', 'txt', 'csv', 'docx', 'xlsx', 'pptx']);
export const canOpen = (name) => OPENABLE.has(extOf(name));

const VIEWABLE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
/** Shown in the page's own viewer. */
export const canView = (name) => VIEWABLE.has(extOf(name));

export const hasPreview = (e) => !e.dir && (['image', 'video'].includes(kindOfEntry(e))) && extOf(e.name) !== 'svg' && extOf(e.name) !== 'ico';

const collator = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);
const pixels = (m) => (m ? m[0] * m[1] : 0);

export const SORTS = {
  name: byName,
  date: (a, b) => a.mtime - b.mtime,
  size: (a, b) => a.size - b.size,
  type: (a, b) => collator.compare(typeName(a), typeName(b)),
  dims: (a, b, media) => pixels(media[a.name]) - pixels(media[b.name]),
  length: (a, b, media) => (media[a.name]?.[2] ?? 0) - (media[b.name]?.[2] ?? 0),
};

/**
 * The entries to show: folders first (by name, or by date when sorting by
 * date), then files in order; filtered by text in the name and by kind
 * ('all', 'image', 'video', 'other').
 */
export function arrange(entries, { sort = 'date', desc = true, text = '', kind = 'all', hidden = false, media = {} } = {}) {
  const t = text.trim().toLowerCase();
  const shown = entries.filter((e) => {
    if (!hidden && e.name.startsWith('.')) return false;
    if (t && !e.name.toLowerCase().includes(t)) return false;
    if (kind === 'all' || e.dir) return true;
    const k = kindOfEntry(e);
    return kind === 'other' ? k !== 'image' && k !== 'video' : k === kind;
  });
  const cmp = SORTS[sort] ?? byName;
  const way = desc ? -1 : 1;
  return shown.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const c = a.dir && sort !== 'name' && sort !== 'date' ? 0 : way * cmp(a, b, media);
    return c || byName(a, b);
  });
}

/** Where items go in a scrolling area `width` wide, and which of them are near the part on screen. */
export function windowOf({ count, width, height, scrollTop, cellW, cellH, over = 2 }) {
  const cols = Math.max(1, Math.floor(width / cellW));
  const rows = Math.ceil(count / cols);
  const firstRow = Math.max(0, Math.floor(scrollTop / cellH) - over);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + height) / cellH) + over);
  return { cols, rows, total: rows * cellH, first: Math.min(count, firstRow * cols), last: Math.min(count, lastRow * cols), cellW: width / cols };
}

/**
 * The selection after a click: plain = just this one, ctrl = this one on or
 * off, shift = from the anchor to this one (ctrl too = added). `names` is the
 * order shown.
 */
export function select({ names, selected, anchor }, name, { ctrl = false, shift = false } = {}) {
  if (shift && anchor != null && names.includes(anchor)) {
    const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
    return { selected: new Set([...(ctrl ? selected : []), ...names.slice(a, b + 1)]), anchor };
  }
  if (ctrl) {
    const next = new Set(selected);
    if (!next.delete(name)) next.add(name);
    return { selected: next, anchor: name };
  }
  return { selected: new Set([name]), anchor: name };
}

/** The folder path's parts as [label, path], with shared storage as one part. */
export function crumbsOf(path) {
  const shared = /^\/storage\/(emulated\/\d+|[\w-]+)(?=\/|$)/.exec(path);
  const out = [];
  let rest = path;
  let at = '';
  if (shared) {
    at = shared[0];
    out.push([shared[1].startsWith('emulated') ? 'Internal storage' : `Memory card ${shared[1]}`, at]);
    rest = path.slice(at.length);
  } else {
    out.push(['/', '/']);
  }
  for (const s of rest.split('/').filter(Boolean)) {
    at = `${at}/${s}`;
    out.push([s, at]);
  }
  return out;
}

/** 83 000 ms -> "1:23". */
export function formatLength(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  const two = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** Seconds since 1970 -> "14 Nov 2026 09:42". */
export function formatWhen(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}

/** "3 pictures, 1 folder" for a delete or save dialog. */
export function countText(items) {
  const n = { dir: 0, image: 0, video: 0, other: 0 };
  for (const e of items) {
    const k = kindOfEntry(e);
    n[k in n ? k : 'other']++;
  }
  const part = (k, one, many) => (n[k] ? `${n[k].toLocaleString('en-GB')} ${n[k] === 1 ? one : many}` : null);
  return [part('dir', 'folder', 'folders'), part('image', 'picture', 'pictures'), part('video', 'video', 'videos'), part('other', n.dir + n.image + n.video ? 'other file' : 'file', n.dir + n.image + n.video ? 'other files' : 'files')].filter(Boolean).join(', ');
}

/** The previews in one answer from the server (packPreviews): [{ name, type, whole, bytes }]. */
export function unpackPreviews(buffer) {
  const len = new DataView(buffer).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, len)));
  let at = 4 + len;
  return header.map((p) => {
    const bytes = new Uint8Array(buffer, at, p.length);
    at += p.length;
    return { name: p.name, type: p.type, whole: p.whole, bytes };
  });
}

export { KIND_NAMES };
