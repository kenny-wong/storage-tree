import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { findAdb, hostPortParam, mergeDevices, parseConnect, parseMdns, parsePair, transportOf } from '../lib/adb.js';
import { createTree, largestFiles } from '../lib/tree.js';
import { copyOne, pullPlan, pullToPc, safeName, targetFor } from '../lib/pull.js';
import { removeOnPhone } from '../lib/remove.js';
import { startScan } from '../lib/scans.js';
import { cancelTask, dismissTask, getTask, startTask, taskStatus } from '../lib/tasks.js';
import * as scans from '../api/scans.js';
import * as sources from '../api/sources.js';

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for `adb exec-out cat <file>` that prints the given bytes for each path. */
function fakeCat(files, { delay = 0 } = {}) {
  const calls = [];
  const spawnAdb = (adb, args) => {
    calls.push(args);
    const path = /^cat '(.*)' 2>\/dev\/null$/.exec(args.at(-1))?.[1].replace(/'\\''/g, "'");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      child.killed = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    };
    setTimeout(() => {
      if (child.killed) return;
      child.stdout.end(files[path] ?? Buffer.alloc(0));
      child.stderr.end();
      child.exitCode = 0;
      setTimeout(() => child.emit('close', 0, null), 5);
    }, delay);
    return child;
  };
  return { spawnAdb, calls };
}

const fakeTask = () => ({ bytes: 0, files: 0, skipped: 0, cancelled: false, hooks: new Set(), onCancel(fn) { this.hooks.add(fn); return () => this.hooks.delete(fn); }, errors: [], addError(p, m) { this.errors.push([p, m]); } });

/* ---------- adb: devices and Wi-Fi ---------- */

test('transportOf tells Wi-Fi serials from USB ones', () => {
  assert.equal(transportOf('R5CT1234ABC'), 'usb');
  assert.equal(transportOf('192.168.1.20:5555'), 'wifi');
  assert.equal(transportOf('adb-R5CT1234ABC-x1Y2z3._adb-tls-connect._tcp'), 'wifi');
});

test('mergeDevices shows a phone on USB and Wi-Fi once, using USB', () => {
  const list = [
    { serial: 'adb-R5CT-abc._adb-tls-connect._tcp', state: 'device', model: 'Galaxy S23', product: 'p', device: 'd' },
    { serial: 'R5CT', state: 'device', model: 'Galaxy S23', product: 'p', device: 'd' },
    { serial: '192.168.1.40:5555', state: 'device', model: 'Pixel 7', product: 'q', device: 'e' },
    { serial: 'ZZZ', state: 'unauthorized', model: '', product: '', device: '' },
  ];
  const merged = mergeDevices(list, { 'adb-R5CT-abc._adb-tls-connect._tcp': 'R5CT', R5CT: 'R5CT', '192.168.1.40:5555': 'P7' });
  assert.equal(merged.length, 3);
  assert.equal(merged[0].serial, 'R5CT');
  assert.deepEqual(merged[0].transports, ['usb', 'wifi']);
  assert.deepEqual(merged[0].wifiSerials, ['adb-R5CT-abc._adb-tls-connect._tcp']);
  assert.equal(merged[1].transport, 'wifi');
  assert.equal(merged[2].state, 'unauthorized');
});

test('hostPortParam takes an address and port, nothing else', () => {
  assert.equal(hostPortParam(' 192.168.1.23:41235 '), '192.168.1.23:41235');
  assert.equal(hostPortParam('[fe80::1]:5555'), '[fe80::1]:5555');
  assert.equal(hostPortParam('192.168.1.23'), null);
  assert.equal(hostPortParam('1.2.3.4:99999'), null);
  assert.equal(hostPortParam('a;b:5555'), null);
});

test('parsePair, parseConnect and parseMdns read adb’s answers', () => {
  assert.deepEqual(parsePair('Successfully paired to 192.168.1.23:41235 [guid=adb-R5CT-x1Y2z3]\n'), { ok: true, guid: 'adb-R5CT-x1Y2z3', message: 'Paired with 192.168.1.23:41235.' });
  assert.equal(parsePair('Failed: Wrong password or connection was dropped.\n').ok, false);
  assert.equal(parsePair('Failed: Wrong password or connection was dropped.\n').message, 'Wrong password or connection was dropped.');
  assert.equal(parseConnect('connected to 192.168.1.23:37155\n').ok, true);
  assert.equal(parseConnect('already connected to 192.168.1.23:37155\n').ok, true);
  assert.equal(parseConnect("failed to connect to '192.168.1.23:37155': Connection refused\n").ok, false);
  assert.deepEqual(parseMdns('List of discovered mdns services\nadb-R5CT-x1Y2z3\t_adb-tls-connect._tcp\t192.168.1.23:37155\nadb-R5CT-x1Y2z3\t_adb-tls-pairing._tcp.\t192.168.1.23:41235\n'), [
    { name: 'adb-R5CT-x1Y2z3', service: '_adb-tls-connect._tcp', address: '192.168.1.23:37155' },
    { name: 'adb-R5CT-x1Y2z3', service: '_adb-tls-pairing._tcp', address: '192.168.1.23:41235' },
  ]);
});

test('findAdb uses the app’s own adb only when no other is found', () => {
  const env = { STORAGE_TREE_BUNDLED_ADB: 'B\\adb.exe', PATH: 'P' };
  assert.equal(findAdb(env, (p) => p === 'B\\adb.exe'), 'B\\adb.exe');
  assert.equal(findAdb(env, (p) => p === 'B\\adb.exe' || p === join('P', process.platform === 'win32' ? 'adb.exe' : 'adb')), join('P', process.platform === 'win32' ? 'adb.exe' : 'adb'));
});

test('pair connects to the phone it finds on the network after pairing', async () => {
  const calls = [];
  const run = async (adb, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pair') return { code: 0, stdout: 'Successfully paired to 192.168.1.23:41235 [guid=adb-R5CT-x1Y2z3]\n', stderr: '' };
    if (args[0] === 'mdns') return { code: 0, stdout: 'List of discovered mdns services\nadb-R5CT-x1Y2z3\t_adb-tls-connect._tcp\t192.168.1.23:37155\n', stderr: '' };
    return { code: 0, stdout: 'connected to 192.168.1.23:37155\n', stderr: '' };
  };
  const old = process.env.ADB;
  process.env.ADB = process.execPath; // any file that exists
  try {
    const r = await sources.pair({ body: { address: '192.168.1.23:41235', code: '123 456' } }, run, async () => {});
    assert.equal(r.status, 200);
    assert.equal(r.body.connected, '192.168.1.23:37155');
    assert.deepEqual(calls, ['pair 192.168.1.23:41235 123456', 'mdns services', 'connect 192.168.1.23:37155']);
    assert.equal((await sources.pair({ body: { address: '192.168.1.23:41235', code: '12' } }, run)).status, 400);
  } finally {
    if (old === undefined) delete process.env.ADB;
    else process.env.ADB = old;
  }
});

/* ---------- the tree after a delete ---------- */

function sampleTree() {
  const t = createTree('/sdcard');
  t.addDir([]);
  t.addFile(['DCIM', 'Camera', 'a.jpg'], 3000, 100);
  t.addFile(['DCIM', 'Camera', 'b.jpg'], 2000, 200);
  t.addFile(['DCIM', 'c.png'], 500, 50);
  t.addFile(['Download', 'x.zip'], 7000, 300);
  t.addDir(['Empty']);
  t.finish();
  return t;
}

test('removeFile and removeDir take sizes and counts out of every folder above', () => {
  const t = sampleTree();
  const dcim = t.root.sub.get('DCIM');
  const camera = dcim.sub.get('Camera');
  assert.equal(t.root.size, 12500);
  assert.equal(t.removeFile(camera, 'a.jpg').size, 3000);
  assert.equal(camera.size, 2000);
  assert.equal(dcim.size, 2500);
  assert.equal(t.root.size, 9500);
  assert.equal(t.root.count, 3);
  assert.equal(t.removeFile(camera, 'nope'), null);
  assert.equal(t.removeDir(dcim), true);
  assert.equal(t.root.size, 7000);
  assert.equal(t.root.count, 1);
  assert.equal(t.root.dirCount, 2); // Download, Empty
  assert.equal(t.alive(camera), false);
  assert.equal(t.alive(t.root.sub.get('Download')), true);
  assert.equal(t.removeDir(t.root), false);
  assert.deepEqual(largestFiles(t, 10).map((f) => f.name), ['x.zip']);
});

/* ---------- copying to this PC ---------- */

test('safeName makes phone names usable on Windows', () => {
  assert.equal(safeName('IMG:2024?.jpg'), 'IMG_2024_.jpg');
  assert.equal(safeName('notes.'), 'notes_');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('con.txt'), '_con.txt');
  assert.equal(safeName('console.log'), 'console.log');
  assert.equal(safeName(''), '_');
});

test('pullPlan lists every file and folder to copy with phone paths', () => {
  const t = sampleTree();
  const dcim = t.root.sub.get('DCIM');
  const plan = pullPlan(t, dcim);
  assert.equal(plan.name, 'DCIM');
  assert.equal(plan.totalBytes, 5500);
  assert.deepEqual(plan.files.map((f) => [f.remote, f.rel.join('/')]).sort(), [
    ['/sdcard/DCIM/Camera/a.jpg', 'Camera/a.jpg'],
    ['/sdcard/DCIM/Camera/b.jpg', 'Camera/b.jpg'],
    ['/sdcard/DCIM/c.png', 'c.png'],
  ]);
  assert.deepEqual(plan.dirs.map((d) => d.join('/')).sort(), ['', 'Camera']);
  assert.equal(pullPlan(t, t.root).name, 'sdcard');
  const one = pullPlan(t, dcim, 'c.png');
  assert.equal(one.isFile, true);
  assert.equal(one.files[0].remote, '/sdcard/DCIM/c.png');
  assert.equal(pullPlan(t, dcim, 'nope'), null);
});

test('targetFor skips a same-size file and never overwrites a different one', async () => {
  const sizes = { 'D:\\a.jpg': 10, 'D:\\a (2).jpg': 99, 'D:\\b': 5 };
  const statFn = async (p) => {
    if (!(p in sizes)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return { size: sizes[p] };
  };
  assert.equal(await targetFor('D:\\new.jpg', 10, statFn), 'D:\\new.jpg');
  assert.equal(await targetFor('D:\\a.jpg', 10, statFn), null);
  assert.equal(await targetFor('D:\\a.jpg', 20, statFn), 'D:\\a (3).jpg');
  assert.equal(await targetFor('D:\\a.jpg', 99, statFn), null);
  assert.equal(await targetFor('D:\\b', 6, statFn), 'D:\\b (2)');
});

test('pullToPc copies a folder, keeps dates, skips what is there and leaves no .part files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-pull-'));
  try {
    const t = sampleTree();
    const { spawnAdb, calls } = fakeCat({
      '/sdcard/DCIM/Camera/a.jpg': Buffer.alloc(3000, 1),
      '/sdcard/DCIM/Camera/b.jpg': Buffer.alloc(2000, 2),
      '/sdcard/DCIM/c.png': Buffer.alloc(500, 3),
    });
    mkdirSync(join(dir, 'DCIM'));
    writeFileSync(join(dir, 'DCIM', 'c.png'), Buffer.alloc(500)); // same size: skipped
    const task = fakeTask();
    const top = await pullToPc({ adb: 'adb', serial: 'X', plan: pullPlan(t, t.root.sub.get('DCIM')), dest: dir, task, spawnAdb, lanes: 2 });
    assert.equal(top, join(dir, 'DCIM'));
    assert.equal(readFileSync(join(dir, 'DCIM', 'Camera', 'a.jpg')).length, 3000);
    assert.equal(readFileSync(join(dir, 'DCIM', 'Camera', 'b.jpg'))[0], 2);
    assert.equal(Math.round(statSync(join(dir, 'DCIM', 'Camera', 'b.jpg')).mtimeMs / 1000), 200);
    assert.equal(task.files, 3);
    assert.equal(task.skipped, 1);
    assert.equal(task.bytes, 5500);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 3), ['-s', 'X', 'exec-out']);
    assert.ok(!readdirSync(join(dir, 'DCIM', 'Camera')).some((n) => n.endsWith('.part')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that comes back short is reported and not saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-pull-'));
  try {
    const { spawnAdb } = fakeCat({ '/sdcard/x.bin': Buffer.alloc(10) });
    const task = fakeTask();
    await assert.rejects(copyOne({ adb: 'adb', serial: 'X', remote: '/sdcard/x.bin', target: join(dir, 'x.bin'), size: 20, mtime: 0, task, spawnAdb }), /Got 10 of 20 bytes/);
    await assert.rejects(copyOne({ adb: 'adb', serial: 'X', remote: '/sdcard/none', target: join(dir, 'none'), size: 5, mtime: 0, task, spawnAdb }), /would not send/);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(task.bytes, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling a copy stops it and removes the half file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-pull-'));
  try {
    const { spawnAdb } = fakeCat({ '/sdcard/big.bin': Buffer.alloc(100) }, { delay: 200 });
    const task = startTask({ kind: 'pull', label: 'big.bin' }, (t) => copyOne({ adb: 'adb', serial: 'X', remote: '/sdcard/big.bin', target: join(dir, 'big.bin'), size: 100, mtime: 0, task: t, spawnAdb }));
    await tick(30);
    assert.equal(dismissTask(task.id), false); // still running
    cancelTask(task.id);
    await tick(60);
    assert.equal(getTask(task.id).state, 'cancelled');
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(dismissTask(task.id), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('taskStatus reports errors and the final state', async () => {
  const task = startTask({ kind: 'pull', label: 'x' }, async (t) => { t.addError('/a', 'nope'); });
  await tick();
  const s = taskStatus(task);
  assert.equal(s.state, 'done-errors');
  assert.deepEqual(s.errors, [{ path: '/a', message: 'nope' }]);
});

/* ---------- deleting ---------- */

test('removeOnPhone runs rm -rf on the quoted path and checks it is gone', async () => {
  const seen = [];
  await removeOnPhone({ adb: 'adb', serial: 'X', path: "/sdcard/it's", run: async (adb, args) => { seen.push(args); return { code: 0, stdout: '', stderr: '' }; } });
  assert.deepEqual(seen[0].slice(0, 3), ['-s', 'X', 'shell']);
  assert.match(seen[0][3], /^rm -rf '\/sdcard\/it'\\''s';/);
  await assert.rejects(removeOnPhone({ adb: 'adb', serial: 'X', path: '/sdcard/a', run: async () => ({ code: 0, stdout: 'STILL-THERE\n', stderr: '' }) }), /did not delete/);
  await assert.rejects(removeOnPhone({ adb: 'adb', serial: 'X', path: '/sdcard/a', run: async () => ({ code: 1, stdout: '', stderr: "rm: /sdcard/a: Permission denied\n" }) }), /Permission denied/);
});

async function phoneScan() {
  const scan = startScan({ source: 'phone', path: '/sdcard', serial: 'X', adb: 'adb', label: 'Pixel' }, {
    scanPhone: async ({ tree }) => {
      tree.addFile(['DCIM', 'a.jpg'], 3000, 100);
      tree.addFile(['DCIM', 'b.jpg'], 2000, 100);
      tree.addFile(['x.zip'], 7000, 100);
      return { method: 'stat' };
    },
  });
  await tick();
  return scan;
}

test('deleting from a phone scan updates the totals; the scanned folder itself is refused', async () => {
  const scan = await phoneScan();
  const removed = [];
  const saved = { ...scans.deps };
  Object.assign(scans.deps, { findAdb: () => 'adb', removeOnPhone: async ({ path }) => { removed.push(path); } });
  try {
    const dcim = scan.tree.root.sub.get('DCIM');
    const r1 = await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: dcim.id, file: 'a.jpg' } });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.size, 3000);
    assert.equal(r1.body.scan.root.size, 9000);
    const r2 = await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: dcim.id } });
    assert.equal(r2.body.parent, 0);
    assert.equal(r2.body.scan.root.size, 7000);
    assert.deepEqual(removed, ['/sdcard/DCIM/a.jpg', '/sdcard/DCIM']);
    assert.equal((await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: dcim.id } })).status, 404); // already gone
    assert.equal((await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: 0 } })).body.error, 'root');
    assert.equal((await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: 0, file: 'missing' } })).status, 404);
    Object.assign(scans.deps, { removeOnPhone: async () => { throw new Error('The phone said: Permission denied'); } });
    const r3 = await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: 0, file: 'x.zip' } });
    assert.equal(r3.status, 409);
    assert.equal(scan.tree.root.size, 7000); // nothing taken out
  } finally {
    Object.assign(scans.deps, saved);
  }
});

test('deleting from this PC sends the real path to the Recycle Bin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-del-'));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'f.txt'), 'hello');
    writeFileSync(join(dir, 'top.txt'), 'x');
    const scan = startScan({ source: 'local', path: dir, sep });
    for (let i = 0; i < 100 && !scan.tree.finished; i++) await tick(10);
    const binned = [];
    const saved = { ...scans.deps };
    Object.assign(scans.deps, { recycle: async (paths) => { binned.push(...paths); for (const p of paths) rmSync(p, { recursive: true }); } });
    try {
      const sub = scan.tree.root.sub.get('sub');
      const r = await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: sub.id } });
      assert.equal(r.status, 200);
      assert.equal(r.body.recycled, true);
      assert.deepEqual(binned, [join(dir, 'sub')]);
      assert.equal(existsSync(join(dir, 'sub')), false);
      assert.equal(scan.tree.root.size, 1);
      writeFileSync(join(dir, 'later.txt'), 'y');
      rmSync(join(dir, 'top.txt'));
      const gone = await scans.removeItem({ params: { id: String(scan.id) }, body: { dir: 0, file: 'top.txt' } });
      assert.equal(gone.body.error, 'gone');
      assert.equal(scan.tree.root.size, 0);
    } finally {
      Object.assign(scans.deps, saved);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pull route copies in the background and refuses this PC’s scans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-pullroute-'));
  const scan = await phoneScan();
  const saved = { ...scans.deps };
  const { spawnAdb } = fakeCat({ '/sdcard/DCIM/a.jpg': Buffer.alloc(3000), '/sdcard/DCIM/b.jpg': Buffer.alloc(2000) });
  Object.assign(scans.deps, { findAdb: () => 'adb', spawnAdb });
  try {
    const dcim = scan.tree.root.sub.get('DCIM');
    assert.equal((await scans.pull({ params: { id: String(scan.id) }, body: { dir: dcim.id, dest: 'relative' } })).status, 400);
    const r = await scans.pull({ params: { id: String(scan.id) }, body: { dir: dcim.id, dest: dir } });
    assert.equal(r.status, 201);
    assert.equal(r.body.dest, join(dir, 'DCIM'));
    for (let i = 0; i < 50 && getTask(r.body.id).state === 'running'; i++) await tick(10);
    assert.equal(getTask(r.body.id).state, 'done');
    assert.deepEqual(readdirSync(join(dir, 'DCIM')).sort(), ['a.jpg', 'b.jpg']);
    Object.assign(scans.deps, { statfs: async () => ({ bavail: 1, bsize: 1024 }) });
    assert.equal((await scans.pull({ params: { id: String(scan.id) }, body: { dir: 0, dest: dir } })).body.error, 'no-space');
  } finally {
    Object.assign(scans.deps, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file route streams one phone file with its length', async () => {
  const scan = await phoneScan();
  const saved = { ...scans.deps };
  const { spawnAdb } = fakeCat({ '/sdcard/x.zip': Buffer.alloc(7000, 7) });
  Object.assign(scans.deps, { findAdb: () => 'adb', spawnAdb });
  try {
    const out = scans.file({ params: { id: String(scan.id) }, query: new URLSearchParams({ dir: '0', name: 'x.zip' }) });
    assert.equal(typeof out.raw, 'function');
    const res = new PassThrough();
    const chunks = [];
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.on('data', (c) => chunks.push(c));
    out.raw(res);
    await new Promise((r) => res.on('end', r));
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Length'], '7000');
    assert.equal(Buffer.concat(chunks).length, 7000);
    assert.equal(scans.file({ params: { id: String(scan.id) }, query: new URLSearchParams({ dir: '0', name: 'nope' }) }).status, 404);
  } finally {
    Object.assign(scans.deps, saved);
  }
});
