// Small pictures of a phone's photos and videos, without reading the files
// whole: cameras put a preview in the first part of a JPEG (EXIF), and Android
// keeps its own thumbnail of most photos and nearly every video. Many files
// are read by one adb command, because starting a command costs more than the
// bytes do. No phone or disk here except through `exec`, so it can be tested.

import { execFile } from 'node:child_process';
import { shQuote } from './adb.js';
import { extOf } from './tree.js';

export const HEAD = 128 * 1024; // an EXIF block is at most 64 KB and sits at the front
const ANDROID_THUMB = 1024 * 1024;
const WHOLE = 12 * 1024 * 1024;

/** Pictures the page can show itself, with their content types. Not SVG: it can hold scripts. */
export const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
const ANY_IMAGE = new Set([...Object.keys(IMAGE_TYPES), 'heic', 'heif', 'dng', 'tif', 'tiff']);
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'webm', 'm4v', '3gp', 'mts', 'm2ts', 'mpg', 'mpeg']);

/** 'image', 'video' or null: what a thumbnail is tried for. */
export const mediaKind = (name) => {
  const e = extOf(name);
  return ANY_IMAGE.has(e) ? 'image' : VIDEO.has(e) ? 'video' : null;
};

/** The preview inside the first bytes of a JPEG -> { jpeg, orientation }, or null. */
export function exifPreview(b) {
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    const len = b.readUInt16BE(p + 2);
    if (marker === 0xda || len < 2) return null; // the picture itself starts
    if (marker === 0xe1 && b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      try {
        return readTiff(b.subarray(p + 10, Math.min(b.length, p + 2 + len)));
      } catch {
        return null; // offsets outside the block: a damaged file
      }
    }
    p += 2 + len;
  }
  return null;
}

function readTiff(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const first = u32(4);
  const count = u16(first);
  let orientation = 1;
  for (let i = 0; i < count; i++) {
    const e = first + 2 + i * 12;
    if (u16(e) === 0x0112) orientation = u16(e + 8);
  }
  const second = u32(first + 2 + count * 12);
  if (!second) return null;
  let off = 0;
  let len = 0;
  for (let i = 0, n = u16(second); i < n; i++) {
    const e = second + 2 + i * 12;
    if (u16(e) === 0x0201) off = u32(e + 8);
    if (u16(e) === 0x0202) len = u32(e + 8);
  }
  if (!off || len < 100 || off + len > t.length || t.readUInt16BE(off) !== 0xffd8) return null;
  return { jpeg: Buffer.from(t.subarray(off, off + len)), orientation: orientation >= 1 && orientation <= 8 ? orientation : 1 };
}

/** Puts an orientation into a preview, which has none of its own, so the browser turns it as it turns the photo. */
export function withOrientation(jpeg, orientation) {
  if (orientation === 1) return jpeg;
  const exif = Buffer.from([0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

/** The first `max` bytes of each file, in one command. toybox's `head -v` prints "==> path <==" before each. */
export const headCommand = (paths, max) => `head -v -c ${max} ${paths.map(shQuote).join(' ')} 2>/dev/null`;

/**
 * headCommand's output -> an array of Buffers, null where the phone left a
 * file out. `sizes` are the files' sizes when known: the next file's mark is
 * looked for there first, and searched for when the file has changed.
 */
export function parseHeads(out, paths, max, sizes = []) {
  const res = paths.map(() => null);
  const mark = (i, first) => Buffer.from(`${first ? '' : '\n'}==> ${paths[i]} <==\n`);
  const at = (m, pos) => pos + m.length <= out.length && out.compare(m, 0, m.length, pos, pos + m.length) === 0;
  let pos = 0;
  let prev = -1; // the file whose bytes start at `start`
  let start = 0;
  for (let i = 0; i < paths.length; i++) {
    const m = mark(i, prev < 0);
    let here = -1;
    if (prev < 0) here = at(m, 0) ? 0 : -1;
    else {
      const want = sizes[prev] == null ? -1 : start + Math.min(sizes[prev], max);
      here = want >= 0 && at(m, want) ? want : out.indexOf(m, start);
    }
    if (here < 0) continue;
    if (prev >= 0) res[prev] = out.subarray(start, here);
    prev = i;
    start = here + m.length;
    pos = start;
  }
  if (prev >= 0) res[prev] = out.subarray(pos);
  return res;
}

/** Runs a command on the phone and resolves with its raw output (empty when it failed). `signal` stops it. */
export function adbBytes(adb, serial, command, { signal } = {}) {
  return new Promise((resolve) => {
    execFile(adb, ['-s', serial, 'exec-out', command], { encoding: 'buffer', maxBuffer: 1 << 30, timeout: 60_000, windowsHide: true, signal }, (err, out) => resolve(err ? Buffer.alloc(0) : out));
  });
}

/** Cuts items into groups whose quoted paths stay well under the phone's limit for one command (128 KB) and whose bytes stay under `bytes`. */
export function batches(items, pathOf, sizeOf, { paths = 60_000, bytes = 32 * 1024 * 1024 } = {}) {
  const out = [];
  let cur = [];
  let len = 0;
  let sum = 0;
  for (const it of items) {
    const l = Buffer.byteLength(shQuote(pathOf(it))) + 1;
    const s = sizeOf(it);
    if (cur.length && (len + l > paths || sum + s > bytes)) {
      out.push(cur);
      cur = [];
      len = 0;
      sum = 0;
    }
    cur.push(it);
    len += l;
    sum += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

const isJpeg = (b) => b?.length > 100 && b.readUInt16BE(0) === 0xffd8;

/**
 * Previews for `items` ([{ name, path, size }]): Map(name -> { data, type, whole }).
 * The preview inside the photo comes first, then Android's thumbnail, then
 * the whole picture when it is small enough (`whole`, for the page to shrink).
 * `exec(command)` runs on the phone; `media()` gives Android's index of the folder.
 */
export async function previews(items, { exec, media }) {
  const out = new Map();
  const read = async (list, pathOf, max, sizeOf, use) => {
    for (const group of batches(list, pathOf, (x) => Math.min(max, sizeOf(x) ?? max))) {
      const paths = group.map(pathOf);
      const bufs = parseHeads(await exec(headCommand(paths, max)), paths, max, group.map(sizeOf));
      group.forEach((x, i) => bufs[i] && use(x, bufs[i]));
    }
  };
  const left = () => items.filter((x) => !out.has(x.name));

  await read(left().filter((x) => /^jpe?g$/.test(extOf(x.name))), (x) => x.path, HEAD, (x) => x.size, (x, b) => {
    const p = exifPreview(b);
    if (p) out.set(x.name, { data: withOrientation(p.jpeg, p.orientation), type: 'image/jpeg', whole: false });
  });
  if (left().length) {
    const index = await media();
    const known = left().filter((x) => index.has(x.name));
    const thumb = (x) => {
      const m = index.get(x.name);
      const card = /^(\/storage\/(?:emulated\/\d+|[\w-]+))\//.exec(x.path)?.[1] ?? '/storage/emulated/0';
      return `${card}/${m.video ? 'Movies' : 'Pictures'}/.thumbnails/${m.id}.jpg`;
    };
    await read(known, thumb, ANDROID_THUMB, () => undefined, (x, b) => {
      if (isJpeg(b)) out.set(x.name, { data: b, type: 'image/jpeg', whole: false });
    });
  }
  await read(left().filter((x) => IMAGE_TYPES[extOf(x.name)] && x.size > 0 && x.size <= WHOLE), (x) => x.path, WHOLE, (x) => x.size, (x, b) => {
    if (b.length === x.size) out.set(x.name, { data: b, type: IMAGE_TYPES[extOf(x.name)], whole: true });
  });
  return out;
}

/** Several previews as one answer: 4 bytes of header length, a JSON header [{ name, type, length, whole }], then the bytes. */
export function packPreviews(map) {
  const list = [...map];
  const header = Buffer.from(JSON.stringify(list.map(([name, p]) => ({ name, type: p.type, length: p.data.length, whole: p.whole }))));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, ...list.map(([, p]) => p.data)]);
}
