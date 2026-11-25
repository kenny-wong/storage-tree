import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import * as browse from '../api/browse.js';
import { LIST_END } from '../lib/scan-phone.js';
import { createPush, numbered, phoneName, phonePart, pushPlan } from '../lib/push.js';
import { cancelTask, getTask, startTask } from '../lib/tasks.js';
import { canPlay } from '../public/browse-list.js';

const DIR = '/storage/emulated/0/Pics';
const temp = (t) => {
  const d = mkdtempSync(join(tmpdir(), 'storage-tree-push-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await tick(5);
  }
};

/* ---------- playing videos: ranges ---------- */

test('ranges: a start, a start and end, the last bytes; nonsense is refused', () => {
  assert.equal(browse.rangeOf(undefined, 100), null);
  assert.deepEqual(browse.rangeOf('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(browse.rangeOf('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(browse.rangeOf('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(browse.rangeOf('bytes=-30', 100), { start: 70, end: 99 });
  assert.deepEqual(browse.rangeOf('bytes=-300', 100), { start: 0, end: 99 });
  for (const bad of ['bytes=100-', 'bytes=20-10', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6']) assert.equal(browse.rangeOf(bad, 100), false, bad);
  assert.equal(browse.ddCommand("/a b/it's.mp4"), "dd if='/a b/it'\\''s.mp4' bs=1M 2>/dev/null");
  assert.equal(browse.ddCommand('/v.mp4', 1000, 50), "dd if='/v.mp4' bs=1M iflag=skip_bytes,count_bytes skip=1000 count=50 2>/dev/null");
  assert.equal(browse.ddCommand('/v.mp4', 1000), "dd if='/v.mp4' bs=1M iflag=skip_bytes,count_bytes skip=1000 2>/dev/null");
  assert.deepEqual(['a.MP4', 'b.mov', 'c.mkv', 'd.avi', 'e.jpg'].map(canPlay), [true, true, true, false, false]);
});

/** A stand-in for `adb exec-out dd …` that prints the asked part of `bytes`. */
const ddOf = (bytes) => (_adb, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {};
  const skip = Number(/skip=(\d+)/.exec(args.at(-1))?.[1] ?? 0);
  const count = /count=(\d+)/.exec(args.at(-1));
  child.stdout.end(bytes.subarray(skip, count ? skip + Number(count[1]) : undefined));
  child.stdout.on('end', () => { child.exitCode = 0; child.emit('close', 0); });
  return child;
};

function fakeRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.writeHead = (status, headers) => { res.status = status; res.head = headers; return res; };
  res.body = () => Buffer.concat(chunks);
  return res;
}

const withDeps = (t, stand) => {
  const old = { ...browse.deps };
  Object.assign(browse.deps, { findAdb: () => 'adb' }, stand);
  t.after(() => Object.assign(browse.deps, old));
};
const line = (name, { dir = false, size = 10, mtime = 1000 } = {}) => `${dir ? '41f8' : '81b0'}|${size}|${mtime}|${DIR}/${name}`;
const listing = (...lines) => ['HW|PHONE1', ...lines, LIST_END, ''].join('\n');

test('a video is served in the parts the player asks for', async (t) => {
  const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  withDeps(t, { run: async () => ({ code: 0, stdout: listing(line('v.mp4', { size: 1000 }), line('p.jpg', { size: 1000 })), stderr: '' }), spawnAdb: ddOf(video) });
  const { body } = await browse.list({ body: { serial: 'S1', path: DIR } });
  const get = async (name, range) => {
    const res = fakeRes();
    browse.file({ params: { id: String(body.id) }, query: new URLSearchParams({ name }), headers: range ? { range } : {} }).raw(res);
    await new Promise((ok) => res.on('finish', ok));
    return res;
  };
  const part = await get('v.mp4', 'bytes=100-199');
  assert.deepEqual([part.status, part.head['Content-Range'], part.head['Content-Length'], part.head['Content-Type']], [206, 'bytes 100-199/1000', '100', 'video/mp4']);
  assert.ok(part.body().equals(video.subarray(100, 200)));
  const whole = await get('v.mp4');
  assert.deepEqual([whole.status, whole.head['Accept-Ranges'], whole.body().length], [200, 'bytes', 1000]);
  assert.equal((await get('v.mp4', 'bytes=5000-')).status, 416);
  const pic = await get('p.jpg', 'bytes=0-9'); // pictures come whole
  assert.deepEqual([pic.status, pic.body().length], [200, 1000]);
});

/* ---------- copying to the phone: names and the plan ---------- */

test('names a phone can have', () => {
  assert.equal(phoneName('Holiday é.jpg'), 'Holiday é.jpg');
  assert.equal(phoneName('e\u0301.jpg'), 'é.jpg'); // one spelling of accented letters
  for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'tab\there', 'x'.repeat(256), null, 5]) assert.equal(phoneName(bad), null);
  assert.equal(phoneName('é'.repeat(127)), 'é'.repeat(127)); // 254 bytes
  assert.equal(phoneName('é'.repeat(128)), null);
  assert.deepEqual([numbered('a.jpg', 1), numbered('a.jpg', 2), numbered('noext', 3), numbered('.hidden', 2)], ['a.jpg', 'a (2).jpg', 'noext (3)', '.hidden (2)']);
  assert.match(phonePart(`${DIR}/a.jpg`), /^\/storage\/emulated\/0\/Pics\/\.storagetree-[0-9a-f]{12}\.part$/);
});

test('the plan: same file skipped, a different one kept, folders copied into, a file in a folder’s way', () => {
  const there = new Map([
    [`${DIR}/same.jpg`, { dir: false, size: 5 }], [`${DIR}/other.jpg`, { dir: false, size: 9 }], [`${DIR}/other (2).jpg`, { dir: false, size: 1 }],
    [`${DIR}/Trip`, { dir: true, size: 0 }], [`${DIR}/Trip/a.jpg`, { dir: false, size: 3 }], [`${DIR}/Notes`, { dir: false, size: 4 }],
  ]);
  const p = pushPlan(DIR, [
    { rel: ['same.jpg'], size: 5, mtime: 1 }, { rel: ['other.jpg'], size: 5, mtime: 1 }, { rel: ['new.jpg'], size: 2, mtime: 1 },
    { rel: ['Trip', 'a.jpg'], size: 3, mtime: 1 }, { rel: ['Trip', 'Day 2', 'b.jpg'], size: 3, mtime: 1 },
    { rel: ['Notes', 'n.txt'], size: 1, mtime: 1 }, { rel: ['new.jpg'], size: 2, mtime: 1 },
  ], there);
  assert.deepEqual(p.dirs, [`${DIR}/Trip/Day 2`, `${DIR}/Notes (2)`]);
  assert.deepEqual(p.files.map((f) => [f.remote.slice(DIR.length + 1), f.skip]), [
    ['same.jpg', true], ['other (3).jpg', false], ['new.jpg', false], ['Trip/a.jpg', true], ['Trip/Day 2/b.jpg', false], ['Notes (2)/n.txt', false],
    ['new (2).jpg', false], // two sent files of one name both arrive
  ]);
});

/* ---------- copying to the phone: the copy ---------- */

/** A phone for createPush: shell commands answered from `files` (phone path -> size), `adb push` writes the file there. */
function fakePhone({ pushFails = [], slow = 0 } = {}) {
  const files = new Map();
  const shell = [];
  const run = async (_adb, args) => {
    const cmd = args.at(-1);
    shell.push(cmd);
    if (cmd.startsWith('mkdir -p')) return { code: 0, stdout: 'MADE\n', stderr: '' };
    if (cmd.startsWith('stat -c %s')) {
      const p = /'([^']+)'/.exec(cmd)[1];
      return { code: 0, stdout: files.has(p) ? `${files.get(p)}\n` : '', stderr: '' };
    }
    if (cmd.startsWith('rm -f')) {
      files.delete(/'([^']+)'/.exec(cmd)[1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd.startsWith('s=$(stat')) {
      const [part, target] = [...cmd.matchAll(/'((?:[^']|'\\'')+)'/g)].map((m) => m[1].replace(/'\\''/g, "'")).filter((x, i, a) => a.indexOf(x) === i);
      const want = Number(/!= "(\d+)"/.exec(cmd)[1]);
      if (files.get(part) !== want) { files.delete(part); return { code: 0, stdout: 'SIZE 0\n', stderr: '' }; }
      if (files.has(target)) { files.delete(part); return { code: 0, stdout: 'TAKEN\n', stderr: '' }; }
      files.set(target, files.get(part));
      files.delete(part);
      return { code: 0, stdout: 'DONE\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const pushed = [];
  const spawnAdb = (_adb, args) => {
    const [local, remote] = args.slice(-2);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let timer;
    child.kill = () => { clearTimeout(timer); child.emit('close', null); };
    timer = setTimeout(() => {
      if (pushFails.some((f) => phonePart(f) === remote)) {
        child.stderr.end('adb: error: failed to copy: remote couldn\'t create file: Permission denied\n');
        return child.emit('close', 1);
      }
      pushed.push(readFileSync(local, 'utf8'));
      files.set(remote, readFileSync(local).length);
      child.emit('close', 0);
    }, slow);
    return child;
  };
  return { files, shell, run, spawnAdb, pushed };
}

const planOf = (sizes) => ({ dirs: [`${DIR}/new`], files: sizes.map(([name, size, skip = false], i) => ({ i, remote: `${DIR}/${name}`, size, mtime: 1_700_000_000, skip })) });

test('a copy to the phone: folders first, each file pushed, checked and renamed; skips counted', async (t) => {
  const phone = fakePhone();
  const plan = planOf([['a.jpg', 3], ["it's.txt", 2], ['same.jpg', 4, true]]);
  let push;
  const task = startTask({ kind: 'push', label: 'x' }, async () => { await push.start(); await push.done; });
  push = createPush({ adb: 'adb', serial: 'S', plan, task: getTask(task.id), tempDir: temp(t), run: phone.run, spawnAdb: phone.spawnAdb, pollMs: 5 });
  await tick();
  await push.receive(0, Readable.from([Buffer.from('abc')]));
  await push.receive(1, Readable.from([Buffer.from('hi')]));
  await push.receive(2, Readable.from([Buffer.from('ignored')]));
  push.end();
  await until(() => task.state !== 'running');
  assert.equal(task.state, 'done');
  assert.deepEqual([task.files, task.skipped, task.bytes], [3, 1, 9]);
  assert.match(phone.shell[0], /^mkdir -p '\/storage\/emulated\/0\/Pics\/new' && echo MADE$/);
  assert.deepEqual([...phone.files], [[`${DIR}/a.jpg`, 3], [`${DIR}/it's.txt`, 2]]);
  assert.deepEqual(phone.pushed, ['abc', 'hi']);
  assert.ok(phone.shell.some((c) => /mv -n .* && touch -d @1700000000 /.test(c)));
});

test('a file the phone refuses, a short one, and a name taken meanwhile are errors; the rest goes on', async (t) => {
  const phone = fakePhone({ pushFails: [`${DIR}/no.jpg`] });
  const dir = temp(t);
  const plan = planOf([['no.jpg', 2], ['short.jpg', 5], ['taken.jpg', 1], ['ok.jpg', 1]]);
  let push;
  const task = startTask({ kind: 'push', label: 'x' }, async () => { await push.start(); await push.done; });
  push = createPush({ adb: 'adb', serial: 'S', plan, task: getTask(task.id), tempDir: dir, run: phone.run, spawnAdb: phone.spawnAdb, pollMs: 5 });
  await tick();
  await push.receive(0, Readable.from([Buffer.from('no')]));
  await assert.rejects(push.receive(1, Readable.from([Buffer.from('abc')])), /Got 3 of 5 bytes/);
  phone.files.set(`${DIR}/taken.jpg`, 7); // someone else's file appears
  await push.receive(2, Readable.from([Buffer.from('t')]));
  await push.receive(3, Readable.from([Buffer.from('k')]));
  push.end();
  await until(() => task.state !== 'running');
  assert.equal(task.state, 'done-errors');
  assert.deepEqual(task.errors.map((e) => [e.path.slice(DIR.length + 1), e.message.split(' ')[0]]), [['no.jpg', 'failed'], ['taken.jpg', 'A']]);
  assert.equal(phone.files.get(`${DIR}/taken.jpg`), 7);
  assert.equal(phone.files.get(`${DIR}/ok.jpg`), 1);
  assert.ok(![...phone.files.keys()].some((k) => k.includes('.storagetree-')));
  await until(() => readdirSync(dir).length === 0);
});

test('cancelling stops the push under way, removes its half file and refuses more', async (t) => {
  const phone = fakePhone({ slow: 300 });
  const dir = temp(t);
  const plan = planOf([['big.mp4', 4], ['next.mp4', 4]]);
  let push;
  const task = startTask({ kind: 'push', label: 'x' }, async () => { await push.start(); await push.done; });
  push = createPush({ adb: 'adb', serial: 'S', plan, task: getTask(task.id), tempDir: dir, run: phone.run, spawnAdb: phone.spawnAdb, pollMs: 5 });
  await tick();
  await push.receive(0, Readable.from([Buffer.from('1234')]));
  await tick(30);
  cancelTask(task.id);
  await until(() => task.state !== 'running');
  assert.equal(task.state, 'cancelled');
  await assert.rejects(push.receive(1, Readable.from([Buffer.from('5678')])), /Cancelled|over/);
  assert.equal(phone.files.size, 0);
  assert.ok(phone.shell.some((c) => c.startsWith('rm -f') && c.includes('.storagetree-')));
  await until(() => readdirSync(dir).length === 0);
});

test('a copy whose page goes away ends by itself', async (t) => {
  const phone = fakePhone();
  let push;
  const task = startTask({ kind: 'push', label: 'x' }, async () => { await push.start(); await push.done; });
  push = createPush({ adb: 'adb', serial: 'S', plan: planOf([['a', 1]]), task: getTask(task.id), tempDir: temp(t), run: phone.run, spawnAdb: phone.spawnAdb, idleMs: 30 });
  await until(() => task.state !== 'running');
  assert.deepEqual([task.state, task.error], ['failed', 'The page stopped sending files.']);
});

/* ---------- the routes: rename, new folder, copy ---------- */

test('rename and new folder: checked names, never over something there, the list follows', async (t) => {
  const asked = [];
  const answers = [];
  withDeps(t, { run: async (_adb, args) => {
    const cmd = args.at(-1);
    if (cmd.startsWith('echo "HW|')) return { code: 0, stdout: listing(line('a.jpg'), line('b.jpg'), line('Trip', { dir: true })), stderr: '' };
    asked.push(cmd);
    return answers.shift() ?? { code: 0, stdout: 'OK\n', stderr: '' };
  } });
  const { body } = await browse.list({ body: { serial: 'S1', path: DIR } });
  const params = { id: String(body.id) };
  const ren = (name, to) => browse.rename({ params, body: { name, to } });
  for (const bad of ['', 'x/y', '..', 'a'.repeat(300)]) assert.equal((await ren('a.jpg', bad)).status, 400);
  assert.equal((await ren('a.jpg', 'b.jpg')).body.error, 'exists');
  assert.equal((await ren('gone.jpg', 'c.jpg')).status, 404);
  assert.equal(asked.length, 0);
  assert.deepEqual((await ren('a.jpg', ' A day out.jpg ')).body, { name: 'A day out.jpg' });
  assert.match(asked[0], /mv -n '\/storage\/emulated\/0\/Pics\/a\.jpg' '\/storage\/emulated\/0\/Pics\/A day out\.jpg'/);
  assert.equal((await ren('a.jpg', 'x.jpg')).status, 404); // gone from the list under its old name
  answers.push({ code: 0, stdout: 'EXISTS\n', stderr: '' });
  assert.match((await ren('b.jpg', 'c.jpg')).body.message, /already there/);
  answers.push({ code: 1, stdout: '', stderr: 'mv: bad: Read-only file system\n' });
  assert.match((await ren('b.jpg', 'c.jpg')).body.message, /The phone said: bad: Read-only/);
  const mk = (name) => browse.makeFolder({ params, body: { name } });
  assert.equal((await mk('Trip')).body.error, 'exists');
  assert.equal((await mk('a/b')).status, 400);
  const made = await mk('New folder');
  assert.deepEqual([made.status, made.body.entry.name, made.body.entry.dir], [201, 'New folder', true]);
  assert.match(asked.at(-1), /^mkdir '\/storage\/emulated\/0\/Pics\/New folder' && echo OK$/);
  assert.equal((await mk('New folder')).body.error, 'exists');
});

test('copying in through the routes: checked names, free space, then each file', async (t) => {
  const phone = fakePhone();
  process.env.STORAGE_TREE_BROWSE_DIR = temp(t);
  t.after(() => { delete process.env.STORAGE_TREE_BROWSE_DIR; });
  let free = 1_000_000;
  const shellRun = async (adb, args) => {
    const cmd = args.at(-1);
    if (cmd.startsWith('echo "HW|')) return { code: 0, stdout: listing(line('a.jpg', { size: 3 }), line('Trip', { dir: true })), stderr: '' };
    if (cmd.startsWith('df -k')) return { code: 0, stdout: `Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/fuse 100 50 ${Math.floor(free / 1024)} 50% /storage/emulated\n`, stderr: '' };
    if (cmd.startsWith('find -H')) return { code: 0, stdout: `41f8|0|1|${DIR}/Trip\n81b0|2|1|${DIR}/Trip/x.jpg\n`, stderr: '' };
    return phone.run(adb, args);
  };
  withDeps(t, { run: shellRun, spawnAdb: phone.spawnAdb });
  const { body } = await browse.list({ body: { serial: 'S1', path: DIR } });
  const params = { id: String(body.id) };
  const start = (items) => browse.pushStart({ params, body: { items } });
  assert.equal((await start([])).status, 400);
  assert.equal((await start([{ rel: ['..'], size: 1 }])).status, 400);
  assert.equal((await start([{ rel: ['a.jpg'], size: -1 }])).status, 400);
  free = 1024;
  assert.equal((await start([{ rel: ['big.bin'], size: 5000 }])).body.error, 'no-space');
  free = 1_000_000;
  const r = await start([{ rel: ['a.jpg'], size: 3, mtime: 5 }, { rel: ['Trip', 'x.jpg'], size: 2, mtime: 5 }, { rel: ['Trip', 'y.jpg'], size: 1, mtime: 5 }]);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.files, [{ i: 0, skip: true }, { i: 1, skip: true }, { i: 2, skip: false }]);
  const put = (i, text) => browse.pushFile({ params: { task: String(r.body.task.id), i: String(i) }, req: Readable.from([Buffer.from(text)]) });
  assert.equal((await put(0, '')).status, 200);
  assert.equal((await put(1, '')).status, 200);
  assert.equal((await put(2, 'y')).status, 200);
  assert.equal((await put(9, 'z')).status, 409);
  assert.equal(browse.pushEnd({ params: { task: String(r.body.task.id) } }).status, 200);
  const task = getTask(r.body.task.id);
  await until(() => task.state !== 'running');
  assert.deepEqual([task.state, task.skipped, phone.files.get(`${DIR}/Trip/y.jpg`)], ['done', 2, 1]);
  assert.equal((await put(2, 'y')).status, 404); // over
  await tick(20);
  assert.ok(phone.shell.some((c) => c.includes('MEDIA_SCANNER_SCAN_FILE') && c.includes("'file:///storage/emulated/0/Pics/Trip/y.jpg'")));
});

test('the gallery is told about copied pictures, with their paths written as addresses', () => {
  assert.equal(browse.scanCommand(["/sdcard/My Trip/it's #1?.jpg"]), "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file:///sdcard/My%20Trip/it'\\''s%20%231%3F.jpg' >/dev/null 2>&1");
});
