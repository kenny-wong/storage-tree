import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as browse from '../api/browse.js';
import { canonical, childPath, folderCommand, getListing, listFolder, mediaCommand, parseFolder, parseMedia, parsePlaces, pick, planOf } from '../lib/browse.js';
import { openedPlace, readThumb, tidyOpened, tidyThumbs, writeThumb } from '../lib/browse-store.js';
import { batches, exifPreview, headCommand, mediaKind, packPreviews, parseHeads, previews, withOrientation } from '../lib/preview.js';
import { removeManyOnPhone } from '../lib/remove.js';
import { LIST_END } from '../lib/scan-phone.js';
import { getTask } from '../lib/tasks.js';
import { arrange, canOpen, canView, countText, crumbsOf, formatLength, hasPreview, select, typeName, unpackPreviews, windowOf } from '../public/browse-list.js';

const temp = (t) => {
  const d = mkdtempSync(join(tmpdir(), 'storage-tree-browse-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const DIR = '/storage/emulated/0/Pics';
const line = (name, { dir = false, size = 10, mtime = 1000, at = DIR } = {}) => `${dir ? '41f8' : '81b0'}|${size}|${mtime}|${at}/${name}`;
const listing = (...lines) => ['HW|PHONE1', ...lines, LIST_END, ''].join('\r\n');
const runOf = (stdout, stderr = '') => async () => ({ code: 0, stdout, stderr });
const make = (...lines) => listFolder({ adb: 'adb', serial: 'S1', path: DIR, run: runOf(listing(...lines)) });

/* ---------- listing ---------- */

test('a folder listing keeps its own entries only, whatever is in their names', () => {
  const { hw, entries, ended } = parseFolder(DIR, listing(line("it's | a photo.jpg"), line('sub', { dir: true, size: 3452 }), line('deep/file.jpg'), line('x', { at: '/storage/emulated/0/Other' }), line('..', { dir: true }), 'a1ff|5|1000|/storage/emulated/0/Pics/link', 'rubbish'));
  assert.equal(hw, 'PHONE1');
  assert.equal(ended, true);
  assert.deepEqual([...entries.values()], [{ name: "it's | a photo.jpg", dir: false, size: 10, mtime: 1000 }, { name: 'sub', dir: true, size: 0, mtime: 1000 }]);
  assert.equal(parseFolder(DIR, line('a.jpg')).ended, false);
  assert.match(folderCommand("/sdcard/a'b"), /find -H '\/sdcard\/a'\\''b\/' -mindepth 1 -maxdepth 1/);
  assert.match(folderCommand('/'), /find -H '\/' /);
});

test('listing a folder: empty is fine; missing, private and cut off are errors', async () => {
  const at = (out, err) => listFolder({ adb: 'adb', serial: 'S1', path: DIR, run: runOf(out, err) });
  assert.equal((await at(listing(), 'stat: Needs 1 argument (see "stat --help")\n')).entries.size, 0);
  await assert.rejects(at(listing(), "find: '/x/': No such file or directory\n"), /There is no folder/);
  await assert.rejects(at(listing(), "find: '/x/': Permission denied\n"), /keeps .* private/);
  await assert.rejects(at('HW|P\n81b0|1|1|/storage/emulated/0/Pics/a.jpg\n'), /stopped before the end/);
  await assert.rejects(at('', 'adb: device offline'), /device offline/);
});

test('listings are kept for a while, and items are picked by name from them', async () => {
  const first = await make(line('a.jpg'), line('b.jpg'));
  assert.equal(getListing(first.id), first);
  assert.deepEqual(pick(first, ['b.jpg', 'b.jpg']).map((e) => e.name), ['b.jpg']);
  for (const bad of [[], null, ['a.jpg', 'c.jpg'], ['../a.jpg'], [5], 'a.jpg']) assert.equal(pick(first, bad), null);
  for (let i = 0; i < 31; i++) await make();
  assert.equal(getListing(first.id), null);
});

test('paths: other spellings of shared storage, and the root', () => {
  assert.equal(canonical('/sdcard/DCIM'), '/storage/emulated/0/DCIM');
  assert.equal(canonical('/storage/self/primary'), '/storage/emulated/0');
  assert.equal(canonical('/sdcardx'), '/sdcardx');
  assert.equal(childPath('/', 'x'), '/x');
  assert.equal(childPath('/a', 'x'), '/a/x');
});

test('places: the folders a phone has, and its memory cards', () => {
  assert.deepEqual(parsePlaces('P|\r\nP|DCIM/Camera\r\nS|emulated\r\nS|self\r\nS|1A2B-3C4D\r\nS|bad name\r\n'), [
    { label: 'Internal storage', path: '/storage/emulated/0' }, { label: 'Camera', path: '/storage/emulated/0/DCIM/Camera' }, { label: 'Memory card 1A2B-3C4D', path: '/storage/1A2B-3C4D' },
  ]);
});

test('Android’s media index: names with commas, empty values, and only this folder', () => {
  const m = parseMedia(DIR, [
    `Row: 0 _id=12, media_type=1, width=4000, height=3000, duration=NULL, _data=${DIR}/a, width=3.jpg`,
    `Row: 1 _id=13, media_type=3, width=NULL, height=, duration=4871, _data=${DIR}/v.mp4`,
    'Row: 2 _id=14, media_type=1, width=1, height=1, duration=NULL, _data=/storage/emulated/0/PicsX/no.jpg',
    `Row: 3 _id=15, media_type=1, width=1, height=1, duration=NULL, _data=${DIR}/sub/no.jpg`, 'No result found.',
  ].join('\r\n'));
  assert.deepEqual([...m], [['a, width=3.jpg', { id: '12', video: false, w: 4000, h: 3000, ms: 0 }], ['v.mp4', { id: '13', video: true, w: 0, h: 0, ms: 4871 }]]);
  // ' is doubled for SQL, and then the whole condition is quoted for the phone's shell
  assert.ok(mediaCommand("/a'b").includes(`LIKE '\\''/a'\\'''\\''b/%'\\''`));
});

/* ---------- previews ---------- */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);

/** A JPEG's start with an EXIF block holding an orientation and a preview. */
function photo({ le = true, orientation = 6, preview = JPEG, offset = null } = {}) {
  const t = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 24 + 4);
  const u16 = (v, o) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
  const u32 = (v, o) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
  t.write(le ? 'II' : 'MM', 0, 'latin1');
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18);
  u32(preview ? 26 : 0, 22);
  u16(2, 26);
  u16(0x0201, 28); u16(4, 30); u32(1, 32); u32(offset ?? t.length, 36);
  u16(0x0202, 40); u16(4, 42); u32(1, 44); u32(preview?.length ?? 0, 48);
  const block = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t, preview ?? Buffer.alloc(0)]);
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(block.length + 2, 10);
  return Buffer.concat([head, block, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(50)]);
}

test('the preview inside a photo is found in both byte orders, with its orientation', () => {
  for (const le of [true, false]) {
    const p = exifPreview(photo({ le, orientation: 6 }));
    assert.ok(p.jpeg.equals(JPEG));
    assert.equal(p.orientation, 6);
  }
  assert.equal(exifPreview(photo({ orientation: 77 })).orientation, 1);
});

test('no preview: none inside, damaged, cut short, or not a JPEG', () => {
  assert.equal(exifPreview(photo({ preview: null })), null);
  assert.equal(exifPreview(photo({ offset: 999_999 })), null);
  assert.equal(exifPreview(photo().subarray(0, 120)), null);
  assert.equal(exifPreview(photo().subarray(0, 24)), null);
  assert.equal(exifPreview(Buffer.from('not a picture')), null);
  assert.equal(exifPreview(Buffer.alloc(0)), null);
});

test('a preview is given the photo’s orientation', () => {
  assert.equal(withOrientation(JPEG, 1), JPEG);
  const out = withOrientation(JPEG, 8);
  assert.equal(out.readUInt16BE(0), 0xffd8);
  const len = out.readUInt16BE(4);
  assert.equal(len, 34);
  assert.equal(out.readUInt16BE(2 + 2 + len), 0xffdb); // the picture goes on right after the block
  assert.equal(out.toString('latin1', 6, 10), 'Exif');
  assert.equal(out.readUInt16BE(6 + 6 + 8 + 2 + 8), 8);
});

/** What toybox's head -v prints for these files ([path, Buffer or null when missing]). */
const heads = (files, max) => Buffer.concat(files.filter(([, b]) => b).flatMap(([p, b], i) => [Buffer.from(`${i ? '\n' : ''}==> ${p} <==\n`), b.subarray(0, max)]));

test('several files in one answer: cut, short, empty and missing ones', () => {
  const files = [['/a', Buffer.alloc(50, 1)], ['/gone', null], ['/b', Buffer.from('x\n==> no <==\n')], ['/empty', Buffer.alloc(0)], ['/c', Buffer.from('end')]];
  const paths = files.map(([p]) => p);
  for (const sizes of [[50, 9, 13, 0, 3], [], [12, 9, 99, 4, 3]]) { // known, unknown, and changed since the listing
    const out = parseHeads(heads(files, 20), paths, 20, sizes);
    assert.deepEqual(out.map((b) => b?.length ?? null), [20, null, 13, 0, 3]);
  }
  assert.deepEqual(parseHeads(heads(files.slice(1), 20), paths.slice(1), 20, []).map((b) => b?.length ?? null), [null, 13, 0, 3]);
  assert.deepEqual(parseHeads(Buffer.alloc(0), ['/a', '/b'], 20), [null, null]);
  assert.equal(headCommand(["/it's"], 5), "head -v -c 5 '/it'\\''s' 2>/dev/null");
});

test('commands stay short enough for the phone, and answers small enough to hold', () => {
  const g = batches(['a'.repeat(30), 'b'.repeat(30), 'c'], (x) => x, () => 1, { paths: 60 });
  assert.deepEqual(g.map((x) => x.length), [1, 2]);
  assert.deepEqual(batches([5, 6, 1, 50], String, (x) => x, { bytes: 10 }).map((x) => x.length), [1, 2, 1]);
  assert.deepEqual(batches([], String, () => 1), []);
});

test('previews: inside the photo first, then Android’s own, then the whole picture', async () => {
  const png = Buffer.alloc(300, 3);
  const phone = {
    [`${DIR}/cam.jpg`]: photo({ orientation: 1 }),
    [`${DIR}/shot.jpg`]: JPEG,
    [`${DIR}/new.png`]: png,
    [`${DIR}/clip.mp4`]: Buffer.alloc(5000),
    [`${DIR}/other.mp4`]: Buffer.alloc(5000),
    '/storage/emulated/0/Pictures/.thumbnails/7.jpg': Buffer.concat([JPEG, Buffer.from('7')]),
    '/storage/emulated/0/Movies/.thumbnails/8.jpg': Buffer.concat([JPEG, Buffer.from('8')]),
  };
  const asked = [];
  const exec = async (command) => {
    const max = Number(/-c (\d+)/.exec(command)[1]);
    const paths = [...command.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    asked.push(paths.map((p) => basename(p)));
    return heads(paths.map((p) => [p, phone[p] ?? null]), max);
  };
  let indexed = 0;
  const media = async () => { indexed++; return new Map([['shot.jpg', { id: '7', video: false }], ['clip.mp4', { id: '8', video: true }], ['other.mp4', { id: '9', video: true }]]); };
  const item = (name) => ({ name, path: `${DIR}/${name}`, size: phone[`${DIR}/${name}`].length });
  const out = await previews(['cam.jpg', 'shot.jpg', 'new.png', 'clip.mp4', 'other.mp4'].map(item), { exec, media });
  assert.ok(out.get('cam.jpg').data.equals(JPEG));
  assert.equal(out.get('shot.jpg').data.at(-1), '7'.charCodeAt(0));
  assert.equal(out.get('clip.mp4').data.at(-1), '8'.charCodeAt(0));
  assert.deepEqual([out.get('new.png').whole, out.get('new.png').type], [true, 'image/png']);
  assert.equal(out.has('other.mp4'), false); // a video is never read whole
  assert.deepEqual(asked, [['cam.jpg', 'shot.jpg'], ['7.jpg', '8.jpg', '9.jpg'], ['new.png']]);
  // Photos with their own previews don't wait for Android's index.
  indexed = 0;
  await previews([item('cam.jpg')], { exec, media });
  assert.equal(indexed, 0);
});

test('previews travel in one answer and are taken apart by the page', () => {
  const map = new Map([['é 1.jpg', { data: JPEG, type: 'image/jpeg', whole: false }], ['b.png', { data: Buffer.from('png'), type: 'image/png', whole: true }]]);
  const b = packPreviews(map);
  const out = unpackPreviews(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.deepEqual(out.map((p) => [p.name, p.type, p.whole, p.bytes.length]), [['é 1.jpg', 'image/jpeg', false, JPEG.length], ['b.png', 'image/png', true, 3]]);
  assert.ok(Buffer.from(out[0].bytes).equals(JPEG));
});

test('which files get a preview', () => {
  assert.equal(mediaKind('a.HEIC'), 'image');
  assert.equal(mediaKind('a.mp4'), 'video');
  assert.equal(mediaKind('a.svg'), null);
  assert.equal(hasPreview({ name: 'a.jpg', dir: true }), false);
  assert.equal(hasPreview({ name: 'a.jpg', dir: false }), true);
  assert.equal(hasPreview({ name: 'a.svg', dir: false }), false);
});

/* ---------- what is kept on this PC ---------- */

test('previews are kept until the file changes, and the least recently seen go first', async (t) => {
  const root = temp(t);
  const e = { size: 5, mtime: 9 };
  assert.equal(await readThumb('hw', '/a.jpg', e, root), null);
  await writeThumb('hw', '/a.jpg', e, JPEG, root);
  assert.ok((await readThumb('hw', '/a.jpg', e, root)).equals(JPEG));
  assert.equal(await readThumb('hw', '/a.jpg', { ...e, mtime: 10 }, root), null);
  assert.equal(await readThumb('other phone', '/a.jpg', e, root), null);
  for (let i = 0; i < 4; i++) await writeThumb('hw', `/${i}.jpg`, e, Buffer.alloc(100), root);
  assert.equal(await tidyThumbs(root, { max: 10_000, keep: 100 }), 0);
  assert.ok(await tidyThumbs(root, { max: 300, keep: 250 }) >= 2);
});

test('opened copies: reused while unchanged, never replaced once edited', async (t) => {
  const root = temp(t);
  const e = { size: 4, mtime: 1_700_000_000 };
  const put = (file, text, mtime = e.mtime) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    utimesSync(file, mtime, mtime);
  };
  const one = await openedPlace('hw', '/a.txt', e, 'a.txt', root);
  assert.equal(one.ready, false);
  put(one.file, 'four');
  assert.deepEqual(await openedPlace('hw', '/a.txt', e, 'a.txt', root), { ...one, ready: true });
  put(one.file, 'edited', e.mtime + 500);
  const two = await openedPlace('hw', '/a.txt', e, 'a.txt', root);
  assert.notEqual(two.dir, one.dir);
  put(two.file, 'four');
  const later = Date.now() + 3 * 86_400_000;
  assert.equal(await tidyOpened(root), 0); // too new
  assert.equal(await tidyOpened(root, later), 1);
  assert.equal(existsSync(two.file), false);
  assert.equal(readFileSync(one.file, 'utf8'), 'edited');
  // A folder that isn't one of ours, or holds something else, is left alone.
  put(join(root, 'opened', 'mine', 'x.txt'), 'four');
  assert.equal(await tidyOpened(root, later), 0);
});

/* ---------- saving and deleting ---------- */

/** A phone whose `find | stat` prints these lines. */
const scanOf = (lines) => () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  setImmediate(() => {
    child.stderr.end(`find: ${DIR}/sub/private: Permission denied\n`);
    child.stdout.end(`${lines.join('\n')}\n`);
    setImmediate(() => child.emit('close', 0, null));
  });
  return child;
};

test('a copy of several items: folders keep their shape, private places are named', async () => {
  const l = await make(line('a.jpg', { size: 5 }), line('sub', { dir: true }));
  const spawnAdb = scanOf([line('sub', { dir: true }), line('sub/inner', { dir: true }), line('sub/inner/b: c.jpg', { size: 7 }), LIST_END]);
  const both = await planOf(l, pick(l, ['a.jpg', 'sub']), { spawnAdb });
  assert.deepEqual([both.name, both.isFile, both.totalBytes], ['', false, 12]);
  assert.deepEqual(both.files.map((f) => f.rel.join('/')), ['a.jpg', 'sub/inner/b_ c.jpg']);
  assert.deepEqual(both.dirs.map((d) => d.join('/')), ['sub', 'sub/inner']);
  assert.equal(both.files[1].remote, `${DIR}/sub/inner/b: c.jpg`);
  assert.deepEqual(both.unread, [{ path: `${DIR}/sub/private`, message: 'Permission denied' }]);
  const one = await planOf(l, pick(l, ['sub']), { spawnAdb });
  assert.deepEqual([one.name, one.files[0].rel.join('/')], ['sub', 'inner/b_ c.jpg']);
  const file = await planOf(l, pick(l, ['a.jpg']));
  assert.deepEqual([file.name, file.isFile], ['a.jpg', true]);
  await assert.rejects(planOf(l, pick(l, ['sub']), { spawnAdb: scanOf([line('sub', { dir: true })]) }), /stopped before the end/);
});

test('deleting many: in groups, quoted, and it stops where something is left', async () => {
  const calls = [];
  const run = (answer) => async (_adb, args) => { calls.push(args.at(-1)); return { code: 0, stdout: answer(calls.length), stderr: '' }; };
  const paths = ['/a', "/it's", '/c'];
  assert.deepEqual(await removeManyOnPhone({ adb: 'adb', serial: 'S', paths, run: run(() => 'CHECKED\r\n'), group: 2 }), { left: [], error: null });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^rm -rf '\/a' '\/it'\\''s'; if \[ -e '\/a' \]/);
  calls.length = 0;
  const part = await removeManyOnPhone({ adb: 'adb', serial: 'S', paths, run: run(() => 'LEFT-1\r\nCHECKED\r\n'), group: 2 });
  assert.deepEqual(part.left, ["/it's", '/c']);
  assert.equal(calls.length, 1);
  // The phone went away: nothing is taken as deleted.
  const cut = await removeManyOnPhone({ adb: 'adb', serial: 'S', paths, run: run(() => ''), group: 2 });
  assert.deepEqual(cut.left, paths);
  assert.match(cut.error, /stopped answering/);
});

/* ---------- routes ---------- */

const withDeps = (t, stand) => {
  const old = { ...browse.deps };
  Object.assign(browse.deps, { findAdb: () => 'adb' }, stand);
  t.after(() => Object.assign(browse.deps, old));
};

test('routes take items of a listing, never paths', async (t) => {
  let removed = null;
  withDeps(t, { run: runOf(listing(line('a.jpg'), line('b.jpg'))), removeManyOnPhone: async ({ paths }) => { removed = paths; return { left: [`${DIR}/b.jpg`], error: 'The phone said: no' }; } });
  const bad = (body) => browse.list({ body }).then((r) => r.status);
  assert.equal(await bad({ serial: 'S1', path: '/sdcard/../data' }), 400);
  assert.equal(await bad({ serial: 'S1', path: 'DCIM' }), 400);
  assert.equal(await bad({ serial: 'S 1; rm', path: DIR }), 400);
  const r = await browse.list({ body: { serial: 'S1', path: '/sdcard/Pics/' } });
  assert.deepEqual([r.status, r.body.path, r.body.entries.length], [201, DIR, 2]);
  const params = { id: String(r.body.id) };
  for (const names of [['/etc/passwd'], ['../x'], []]) assert.equal((await browse.remove({ params, body: { names } })).status, 404);
  assert.equal(removed, null);
  const gone = await browse.remove({ params, body: { names: ['a.jpg', 'b.jpg'] } });
  assert.deepEqual(removed, [`${DIR}/a.jpg`, `${DIR}/b.jpg`]);
  assert.deepEqual(gone.body, { deleted: ['a.jpg'], left: 1, error: 'The phone said: no' });
  assert.equal((await browse.remove({ params, body: { names: ['a.jpg'] } })).status, 404); // no longer listed
  assert.equal((await browse.remove({ params: { id: '999999' }, body: { names: ['a.jpg'] } })).body.error, 'no-listing');
  assert.equal(browse.thumbs({ params, body: { names: Array(65).fill('b.jpg') } }).status, 400);
});

test('opening copies the file once, with its date, and refuses kinds that can run', async (t) => {
  const root = temp(t);
  process.env.STORAGE_TREE_BROWSE_DIR = root;
  t.after(() => { delete process.env.STORAGE_TREE_BROWSE_DIR; });
  const opened = [];
  let pulls = 0;
  const spawnAdb = (_adb, args) => {
    pulls++;
    const child = new EventEmitter();
    child.pid = 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => { writeFileSync(args.at(-1), '0123456789'); child.emit('close', 0, null); });
    return child;
  };
  withDeps(t, { run: runOf(listing(line('p.jpg', { mtime: 1_700_000_000 }), line('bad.exe'), line('web.html'), line('sub', { dir: true }))), spawnAdb, openFile: async (p) => { opened.push(p); } });
  const { body } = await browse.list({ body: { serial: 'S1', path: DIR } });
  const params = { id: String(body.id) };
  for (const name of ['bad.exe', 'web.html', 'sub']) assert.equal((await browse.open({ params, body: { name } })).status, 400);
  const r = await browse.open({ params, body: { name: 'p.jpg' } });
  assert.equal(r.status, 201);
  const task = getTask(r.body.task.id);
  while (task.state === 'running') await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(task.state, 'done');
  assert.equal(opened.length, 1);
  assert.equal(Math.round(statSync(opened[0]).mtimeMs / 1000), 1_700_000_000);
  assert.deepEqual((await browse.open({ params, body: { name: 'p.jpg' } })).body, { opened: true });
  assert.deepEqual([pulls, opened.length], [1, 2]);
});

/** Collects what a route writes. */
function fakeRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.writeHead = (status, headers) => { res.status = status; res.head = headers; return res; };
  res.body = () => Buffer.concat(chunks);
  return res;
}

test('previews come from this PC the second time; a file is served whole or not at all', async (t) => {
  process.env.STORAGE_TREE_BROWSE_DIR = temp(t);
  t.after(() => { delete process.env.STORAGE_TREE_BROWSE_DIR; });
  let reads = 0;
  const cat = (bytes) => () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = 0;
    child.kill = () => {};
    child.stdout.end(bytes);
    child.stdout.on('end', () => child.emit('close', 0));
    return child;
  };
  const cam = photo({ orientation: 1 });
  withDeps(t, { run: runOf(listing(line('cam.jpg', { size: cam.length }), line('x.html', { size: 4 }))), adbBytes: async () => { reads++; return heads([[`${DIR}/cam.jpg`, cam]], 1e6); }, spawnAdb: cat(cam) });
  const { body } = await browse.list({ body: { serial: 'S1', path: DIR } });
  const params = { id: String(body.id) };
  for (let i = 0; i < 2; i++) {
    const res = fakeRes();
    await browse.thumbs({ params, body: { names: ['cam.jpg', 'x.html'] } }).raw(res);
    await new Promise((ok) => setTimeout(ok, 60));
    const b = res.body();
    assert.deepEqual(unpackPreviews(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)).map((p) => p.name), ['cam.jpg']);
  }
  assert.equal(reads, 1);
  const get = async (q) => {
    const res = fakeRes();
    browse.file({ params, query: new URLSearchParams(q) }).raw(res);
    const how = await new Promise((ok) => { res.on('end', () => ok('end')); res.on('close', () => ok('cut')); });
    return { res, how };
  };
  const shown = await get({ name: 'cam.jpg' });
  assert.deepEqual([shown.how, shown.res.head['Content-Type'], shown.res.body().length], ['end', 'image/jpeg', cam.length]);
  assert.match((await get({ name: 'cam.jpg', download: '1' })).res.head['Content-Disposition'], /^attachment/);
  browse.deps.spawnAdb = cat(Buffer.from('12'));
  const short = await get({ name: 'x.html' });
  assert.deepEqual([short.how, short.res.head['Content-Type']], ['cut', 'application/octet-stream']); // never served as a page
});

/* ---------- the page's sums ---------- */

const E = (name, o = {}) => ({ name, dir: false, size: 1, mtime: 1, ...o });

test('order: folders first, then by the column; text, kind and hidden filters', () => {
  const list = [E('b.jpg', { mtime: 3, size: 9 }), E('a10.mp4', { mtime: 1, size: 5 }), E('a2.txt', { mtime: 2, size: 7 }), E('Zed', { dir: true, mtime: 1 }), E('abc', { dir: true, mtime: 5 }), E('.x', { dir: true })];
  const names = (o) => arrange([...list], o).map((e) => e.name);
  assert.deepEqual(names({ sort: 'name', desc: false }), ['abc', 'Zed', 'a2.txt', 'a10.mp4', 'b.jpg']);
  assert.deepEqual(names({ sort: 'date', desc: true }), ['abc', 'Zed', 'b.jpg', 'a2.txt', 'a10.mp4']);
  assert.deepEqual(names({ sort: 'size', desc: true }), ['abc', 'Zed', 'b.jpg', 'a2.txt', 'a10.mp4']);
  assert.deepEqual(names({ sort: 'length', desc: true, media: { 'a10.mp4': [1, 1, 900] } }).slice(2), ['a10.mp4', 'a2.txt', 'b.jpg']);
  assert.deepEqual(names({ sort: 'name', desc: false, kind: 'video' }), ['abc', 'Zed', 'a10.mp4']);
  assert.deepEqual(names({ sort: 'name', desc: false, kind: 'other', text: 'A' }), ['abc', 'a2.txt']);
  assert.ok(names({ hidden: true }).includes('.x'));
});

test('only the tiles near the screen are drawn', () => {
  const w = windowOf({ count: 10_712, width: 1000, height: 600, scrollTop: 20_000, cellW: 200, cellH: 200 });
  assert.deepEqual([w.cols, w.rows, w.total, w.first, w.last], [5, 2143, 428_600, 490, 525]);
  assert.deepEqual([windowOf({ count: 3, width: 100, height: 600, scrollTop: 0, cellW: 200, cellH: 200 }).cols, windowOf({ count: 0, width: 100, height: 60, scrollTop: 0, cellW: Infinity, cellH: 20 }).last], [1, 0]);
});

test('selecting: plain, ctrl and shift clicks', () => {
  const names = ['a', 'b', 'c', 'd'];
  const at = (s, n, how) => select({ names, ...s }, n, how);
  let s = at({ selected: new Set(), anchor: null }, 'b');
  s = at(s, 'd', { shift: true });
  assert.deepEqual([[...s.selected], s.anchor], [['b', 'c', 'd'], 'b']);
  s = at(s, 'a', { shift: true });
  assert.deepEqual([...s.selected], ['a', 'b']);
  s = at(s, 'd', { ctrl: true });
  assert.deepEqual([...s.selected], ['a', 'b', 'd']);
  s = at(s, 'a', { ctrl: true });
  assert.deepEqual([...s.selected], ['b', 'd']);
  assert.deepEqual([...at({ selected: new Set(), anchor: 'gone' }, 'c', { shift: true }).selected], ['c']);
});

test('path, lengths, counts and kinds in words', () => {
  assert.deepEqual(crumbsOf('/storage/emulated/0/DCIM/Camera'), [['Internal storage', '/storage/emulated/0'], ['DCIM', '/storage/emulated/0/DCIM'], ['Camera', '/storage/emulated/0/DCIM/Camera']]);
  assert.deepEqual(crumbsOf('/storage/1A2B-3C4D'), [['Memory card 1A2B-3C4D', '/storage/1A2B-3C4D']]);
  assert.deepEqual(crumbsOf('/data/local'), [['/', '/'], ['data', '/data'], ['local', '/data/local']]);
  assert.deepEqual([formatLength(0), formatLength(4871), formatLength(83_000), formatLength(3_725_000)], ['', '0:05', '1:23', '1:02:05']);
  assert.equal(countText([E('a', { dir: true }), E('b.jpg'), E('c.jpg'), E('d.zip')]), '1 folder, 2 pictures, 1 other file');
  assert.equal(countText([E('d.zip'), E('e.txt')]), '2 files');
  assert.deepEqual([typeName(E('A.JPG')), typeName(E('x', { dir: true })), typeName(E('noext'))], ['JPG picture', 'Folder', 'File']);
  assert.deepEqual([canView('a.heic'), canOpen('a.heic'), canOpen('a.bat'), canOpen('a.html'), canOpen('a.svg'), canOpen('a.docm')], [false, true, false, false, false, false]);
});
