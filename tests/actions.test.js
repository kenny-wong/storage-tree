import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { findAdb, hostPortParam, mergeDevices, parseConnect, parseMdns, parsePair, transportOf } from '../lib/adb.js';
import { createTree, largestFiles } from '../lib/tree.js';
import { adbPath, claimTarget, copyOne, heldNames, partOf, pathKey, pullError, pullPlan, pullToPc, safeName, targetFor } from '../lib/pull.js';
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

/**
 * A stand-in for `adb pull <phone path> <PC path>` that behaves as the real
 * one was measured to: it replaces the PC file with the bytes and prints its
 * summary to stderr; a missing phone file, or a phone folder pulled onto a
 * file, is an error line and exit code 1 with the PC file left alone.
 *   delay: ms before anything happens      pause: ms between the two halves of the bytes (0 = all at once)
 *   code: exit code after the bytes        folders / silent: phone paths that are folders / that adb skips with code 0
 *   failOnce: phone paths whose first pull fails    before(remote, local): runs just before a successful end
 *   onKill(local): runs when the process is killed  noStart: adb.exe can't be started
 */
function fakePull(files, { delay = 0, pause = 0, code = 0, folders = [], silent = [], failOnce = [], before = null, onKill = null, noStart = false } = {}) {
  const calls = [];
  const failed = new Set();
  const spawnAdb = (adb, args) => {
    calls.push(args);
    const [remote, local] = args.slice(-2);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    if (noStart) {
      child.kill = () => {};
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' })));
      return child;
    }
    child.pid = 4242;
    let done = false;
    let timer = null;
    const end = (exit, text = '', signal = null) => {
      done = true;
      child.stdout.end();
      child.stderr.end(text);
      setTimeout(() => child.emit('close', exit, signal), 5);
    };
    child.kill = () => {
      if (done) return;
      clearTimeout(timer);
      onKill?.(local);
      end(null, '', 'SIGTERM');
    };
    timer = setTimeout(() => {
      if (folders.includes(remote)) return end(1, `adb: error: target '${local}' is not a directory\n`);
      if (silent.includes(remote)) return end(0, `${remote}: 0 files pulled, 0 skipped.\n`);
      const data = files[remote];
      if (data == null) return end(1, `adb: error: failed to stat remote object '${remote}': No such file or directory\n`);
      if (failOnce.includes(remote) && !failed.has(remote)) {
        failed.add(remote);
        return end(1, `adb: error: failed to copy '${remote}' to '${local}': remote read failed\n`);
      }
      const half = pause ? Math.floor(data.length / 2) : data.length;
      rmSync(local, { force: true });
      writeFileSync(local, data.subarray(0, half));
      timer = setTimeout(() => {
        appendFileSync(local, data.subarray(half));
        before?.(remote, local);
        if (code) end(code, `adb: error: failed to copy '${remote}' to '${local}': remote read failed\n${remote}: 0 files pulled, 0 skipped.\n`);
        else end(0, `${remote}: 1 file pulled, 0 skipped. 1.0 MB/s (${data.length} bytes in 0.001s)\n`);
      }, pause);
    }, delay);
    return child;
  };
  return { spawnAdb, calls };
}

const fakeTask =() => ({ bytes: 0, files: 0, skipped: 0, cancelled: false, hooks: new Set(), onCancel(fn) { this.hooks.add(fn); return () => this.hooks.delete(fn); }, errors: [], addError(p, m) { this.errors.push([p, m]); } });

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
    const { spawnAdb, calls } = fakePull({
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
    assert.deepEqual(calls[0].slice(0, 3), ['-s', 'X', 'pull']);
    assert.ok(!readdirSync(join(dir, 'DCIM', 'Camera')).some((n) => n.endsWith('.part')));
    assert.equal(heldNames(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `fn(dir)` with a scratch folder that is removed afterwards. */
async function inDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-pull-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** copyOne with the usual arguments filled in. */
const copy = (dir, spawnAdb, task, remote, name, size, more = {}) => copyOne({ adb: 'adb', serial: 'X', remote, target: join(dir, name), size, mtime: 0, task, spawnAdb, ...more });

test('a file that comes back short, or is not there, is reported and not saved', () => inDir(async (dir) => {
  const { spawnAdb } = fakePull({ '/sdcard/x.bin': Buffer.alloc(10) });
  const task = fakeTask();
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/x.bin', 'x.bin', 20), /Got 10 of 20 bytes/);
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/none', 'none', 5), /^Error: failed to stat remote object '\/sdcard\/none': No such file or directory$/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(task.bytes, 0);
}));

test('cancelling a copy part way stops it, removes the half file and keeps the bytes that arrived', () => inDir(async (dir) => {
  const { spawnAdb } = fakePull({ '/sdcard/big.bin': Buffer.alloc(100) }, { pause: 300 });
  const task = startTask({ kind: 'pull', label: 'big.bin' }, (t) => copy(dir, spawnAdb, t, '/sdcard/big.bin', 'big.bin', 100));
  await tick(40);
  assert.equal(dismissTask(task.id), false); // still running
  assert.deepEqual(readdirSync(dir), [basename(partOf(join(dir, 'big.bin')))]);
  cancelTask(task.id);
  await tick(60);
  assert.equal(getTask(task.id).state, 'cancelled');
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(task.bytes, 50);
  assert.equal(task.errorCount, 0);
  assert.equal(dismissTask(task.id), true);
}));

test('progress follows the growing file and ends at exactly the size', () => inDir(async (dir) => {
  const { spawnAdb } = fakePull({ '/sdcard/v.mp4': Buffer.alloc(100, 7) }, { pause: 120 });
  const target = join(dir, 'v.mp4');
  writeFileSync(partOf(target), Buffer.alloc(999)); // a leftover of a copy that was cut off
  const task = fakeTask();
  const seen = [];
  const watch = setInterval(() => seen.push(task.bytes), 10);
  const got = await copy(dir, spawnAdb, task, '/sdcard/v.mp4', 'v.mp4', 100, { pollMs: 10 });
  clearInterval(watch);
  assert.equal(got, 100);
  assert.equal(task.bytes, 100);
  assert.ok(seen.includes(50), `half way was seen: ${seen}`);
  assert.ok(seen.every((n) => n === 0 || n === 50 || n === 100), `the leftover was not counted: ${seen}`);
  assert.deepEqual(readdirSync(dir), ['v.mp4']);
  assert.equal(readFileSync(target)[0], 7);
}));

test('a folder named like the temporary file is left alone and the file is reported', () => inDir(async (dir) => {
  const { spawnAdb, calls } = fakePull({ '/sdcard/x.bin': Buffer.alloc(10) });
  const part = partOf(join(dir, 'x.bin'));
  mkdirSync(part);
  writeFileSync(join(part, 'mine.txt'), 'keep');
  const task = fakeTask();
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/x.bin', 'x.bin', 10), /Can’t write in /);
  assert.equal(readFileSync(join(part, 'mine.txt'), 'utf8'), 'keep');
  assert.equal(calls.length, 0);
  assert.equal(task.bytes, 0);
}));

test('files named x and x.part side by side are both saved whole', () => inDir(async (dir) => {
  const t = createTree('/sdcard', '/');
  t.addFile(['Download', 'x'], 10, 100);
  t.addFile(['Download', 'x.part'], 20, 100);
  t.finish();
  const { spawnAdb } = fakePull({ '/sdcard/Download/x': Buffer.alloc(10, 1), '/sdcard/Download/x.part': Buffer.alloc(20, 2) }, { pause: 20 });
  const task = fakeTask();
  await pullToPc({ adb: 'adb', serial: 'X', plan: pullPlan(t, t.root.sub.get('Download')), dest: dir, task, spawnAdb, lanes: 2 });
  assert.deepEqual(readdirSync(join(dir, 'Download')).sort(), ['x', 'x.part']);
  assert.equal(readFileSync(join(dir, 'Download', 'x')).length, 10);
  assert.equal(readFileSync(join(dir, 'Download', 'x.part')).length, 20);
  assert.deepEqual(task.errors, []);
}));

test('an empty file is saved; adb ending well without writing anything is not', () => inDir(async (dir) => {
  const { spawnAdb } = fakePull({ '/sdcard/empty': Buffer.alloc(0) }, { silent: ['/sdcard/odd0', '/sdcard/odd5'] });
  const task = fakeTask();
  assert.equal(await copy(dir, spawnAdb, task, '/sdcard/empty', 'empty', 0), 0);
  assert.equal(statSync(join(dir, 'empty')).size, 0);
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/odd0', 'odd0', 0), /Got 1 of 0 bytes/);
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/odd5', 'odd5', 5), /Got 0 of 5 bytes/);
  assert.deepEqual(readdirSync(dir), ['empty']);
  assert.equal(task.bytes, 0);
}));

test('phone names with quotes and spaces reach adb as they are', () => inDir(async (dir) => {
  const remote = '/sdcard/it\'s a "file" & more $(x).txt';
  const { spawnAdb, calls } = fakePull({ [remote]: Buffer.alloc(4) });
  await copy(dir, spawnAdb, fakeTask(), remote, 'saved.txt', 4);
  assert.deepEqual(calls[0], ['-s', 'X', 'pull', remote, partOf(join(dir, 'saved.txt'))]);
  assert.deepEqual(readdirSync(dir), ['saved.txt']);
}));

test('a folder on the phone where the scan saw a file is reported in plain words', () => inDir(async (dir) => {
  const { spawnAdb } = fakePull({}, { folders: ['/sdcard/was-a-file'] });
  const task = fakeTask();
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/was-a-file', 'a', 0), /folder on the phone now/);
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/was-a-file', 'b', 4096), /folder on the phone now/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(task.bytes, 0);
}));

test('an adb error after all the bytes arrived is still an error', () => inDir(async (dir) => {
  const { spawnAdb } = fakePull({ '/sdcard/x.bin': Buffer.alloc(10) }, { code: 1 });
  const task = fakeTask();
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/x.bin', 'x.bin', 10), /^Error: failed to copy .* remote read failed$/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(task.bytes, 0);
}));

test('a rename that fails is reported and the temporary file removed', () => inDir(async (dir) => {
  const target = join(dir, 'x.bin');
  const { spawnAdb } = fakePull({ '/sdcard/x.bin': Buffer.alloc(10) }, { before: () => mkdirSync(target) }); // a folder took the name meanwhile
  const task = fakeTask();
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/x.bin', 'x.bin', 10));
  assert.deepEqual(readdirSync(dir), ['x.bin']);
  assert.equal(statSync(target).isDirectory(), true);
  assert.equal(task.bytes, 0);
}));

test('adb that can’t be started is reported and nothing is left', () => inDir(async (dir) => {
  const { spawnAdb } = fakePull({}, { noStart: true });
  const task = fakeTask();
  await assert.rejects(copy(dir, spawnAdb, task, '/sdcard/x.bin', 'x.bin', 10), /ENOENT/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(task.bytes, 0);
}));

test('a half file that can’t be removed is named, after an error and after a cancel', () => inDir(async (dir) => {
  const spoil = (local) => { // something turned our file into a folder with things in it, which unlink won't remove
    rmSync(local, { force: true });
    mkdirSync(local);
    writeFileSync(join(local, 'in.txt'), 'x');
  };
  const failing = fakePull({ '/sdcard/x.bin': Buffer.alloc(10) }, { code: 1, before: (remote, local) => spoil(local) });
  const task = fakeTask();
  const part = partOf(join(dir, 'x.bin'));
  await assert.rejects(copy(dir, failing.spawnAdb, task, '/sdcard/x.bin', 'x.bin', 10), (err) => err.message.includes(`a half file was left: ${part}`));
  assert.equal(task.bytes, 0);
  rmSync(part, { recursive: true });

  const killed = fakePull({ '/sdcard/y.bin': Buffer.alloc(100) }, { pause: 2000, onKill: spoil });
  const run = startTask({ kind: 'pull', label: 'y.bin' }, (t) => copy(dir, killed.spawnAdb, t, '/sdcard/y.bin', 'y.bin', 100));
  await tick(40);
  cancelTask(run.id);
  for (let i = 0; i < 100 && run.state === 'running'; i++) await tick(20);
  assert.equal(run.state, 'cancelled');
  assert.equal(run.errors.length, 1);
  assert.ok(run.errors[0].message.includes(partOf(join(dir, 'y.bin'))));
  assert.ok(run.bytes <= 50); // not the whole file
}));

test('partOf gives a short name of our own beside the target; a 250-character name is saved', () => inDir(async (dir) => {
  const part = partOf(join(dir, 'IMG_0001.JPG'));
  assert.equal(dirname(part), dir);
  assert.match(basename(part), /^storagetree-[0-9a-f]{12}\.part$/);
  assert.equal(basename(part).length, 29);
  assert.equal(part, partOf(join(dir, 'img_0001.jpg')));
  assert.notEqual(part, partOf(join(dir, 'IMG_0002.JPG')));
  const long = `${'n'.repeat(246)}.bin`;
  const { spawnAdb, calls } = fakePull({ '/sdcard/long.bin': Buffer.alloc(8) });
  await copy(dir, spawnAdb, fakeTask(), '/sdcard/long.bin', long, 8);
  assert.deepEqual(readdirSync(dir), [long]);
  assert.ok(basename(calls[0].at(-1)).length < 40);
}));

test('adbPath prefixes long PC paths, and pathKey spells one path one way', { skip: sep !== '\\' }, () => {
  assert.equal(adbPath('C:\\out\\a.jpg'), 'C:\\out\\a.jpg');
  const long = `C:\\out\\${'d'.repeat(250)}\\a.jpg`;
  assert.equal(adbPath(long), `\\\\?\\${long}`);
  assert.equal(pathKey('C:\\out\\X.jpg'), pathKey('\\\\?\\c:\\out\\x.JPG'));
  assert.notEqual(pathKey('C:\\out\\x.jpg'), pathKey('C:\\out\\y.jpg'));
});

test('pullError keeps adb’s own reason', () => {
  assert.equal(pullError("adb: error: failed to stat remote object '/sdcard/a': No such file or directory\r\n"), "failed to stat remote object '/sdcard/a': No such file or directory");
  assert.equal(pullError(''), 'The phone would not send this file');
  assert.equal(pullError("adb: error: failed to copy '/sdcard/a' to 'C:\\x': remote read failed\n/sdcard/a: 0 files pulled, 0 skipped.\n"), "failed to copy '/sdcard/a' to 'C:\\x': remote read failed");
  assert.equal(pullError("adb: error: target 'C:\\out\\storagetree-0123456789ab.part' is not a directory\n"), 'This is a folder on the phone now, not a file');
  assert.equal(pullError("adb: device 'X' not found\n"), "device 'X' not found");
});

test('a copy with a saved, a skipped and a failed file adds up', () => inDir(async (dir) => {
  const t = sampleTree();
  const { spawnAdb } = fakePull({ '/sdcard/DCIM/Camera/a.jpg': Buffer.alloc(3000, 1), '/sdcard/DCIM/c.png': Buffer.alloc(500, 3) }); // b.jpg is gone from the phone
  mkdirSync(join(dir, 'DCIM'));
  writeFileSync(join(dir, 'DCIM', 'c.png'), Buffer.alloc(500));
  const task = fakeTask();
  await pullToPc({ adb: 'adb', serial: 'X', plan: pullPlan(t, t.root.sub.get('DCIM')), dest: dir, task, spawnAdb });
  assert.equal(task.bytes, task.totalBytes);
  assert.equal(task.files, 2);
  assert.equal(task.skipped, 1);
  assert.deepEqual(task.errors.map((e) => e[0]), ['/sdcard/DCIM/Camera/b.jpg']);
  assert.deepEqual(readdirSync(join(dir, 'DCIM', 'Camera')), ['a.jpg']);
  assert.equal(heldNames(), 0);
}));

/* ---------- one PC name wanted by two files ---------- */

test('claimTarget never gives one name to two files asking at once', async () => {
  const none = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  const used = new Set();
  const [a, b] = await Promise.all([claimTarget('D:\\out\\n.jpg', 10, none, used), claimTarget('D:\\out\\N.JPG', 10, none, used)]);
  assert.deepEqual([a.target, b.target].sort(), ['D:\\out\\N (2).JPG', 'D:\\out\\n.jpg']);
  assert.equal(heldNames(), 2);
  a.release();
  b.release();
  assert.equal(heldNames(), 0);
});

test('a name somebody is saving to is waited for, then looked at afresh', async () => {
  const disk = {};
  const statFn = async (p) => {
    if (!(p in disk)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return { size: disk[p] };
  };
  // The first asker's look at the disk is held back; the second must not act before the first is done.
  let answer;
  const slow = () => new Promise((resolve, reject) => { answer = () => reject(Object.assign(new Error('nope'), { code: 'ENOENT' })); });
  const first = claimTarget('D:\\out\\v.mp4', 10, slow);
  let second = null;
  const waiting = claimTarget('D:\\out\\v.mp4', 10, statFn).then((c) => { second = c; return c; });
  await tick();
  assert.equal(second, null);
  answer();
  const a = await first;
  assert.equal(a.target, 'D:\\out\\v.mp4');
  await tick();
  assert.equal(second, null); // still being written
  disk['D:\\out\\v.mp4'] = 10; // the first copy finished
  a.release();
  assert.equal((await waiting).target, null); // really there now: skip
  assert.equal(heldNames(), 0);

  // The first copy fails: the second saves the file itself.
  const b = await claimTarget('D:\\out\\w.mp4', 10, statFn);
  const other = claimTarget('D:\\out\\w.mp4', 10, statFn);
  b.release();
  const c = await other;
  assert.equal(c.target, 'D:\\out\\w.mp4');
  c.release();
  assert.equal(heldNames(), 0);
});

test('a folder at the target’s path is not taken for the same file', async () => {
  const statFn = async (p) => {
    if (p !== 'D:\\b') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return { size: 0, isDirectory: () => true };
  };
  assert.equal(await targetFor('D:\\b', 0, statFn), 'D:\\b (2)');
  assert.equal(heldNames(), 0);
});

test('two phone files that become one PC name are both saved, also at the same size', () => inDir(async (dir) => {
  const t = createTree('/sdcard', '/');
  t.addFile(['Notes', 'a:b.txt'], 100, 100);
  t.addFile(['Notes', 'a?b.txt'], 100, 100);
  t.finish();
  const files = { '/sdcard/Notes/a:b.txt': Buffer.alloc(100, 1), '/sdcard/Notes/a?b.txt': Buffer.alloc(100, 2) };
  const plan = pullPlan(t, t.root.sub.get('Notes'));
  const first = fakePull(files, { pause: 20 });
  const task = fakeTask();
  await pullToPc({ adb: 'adb', serial: 'X', plan, dest: dir, task, spawnAdb: first.spawnAdb, lanes: 2 });
  assert.deepEqual(readdirSync(join(dir, 'Notes')).sort(), ['a_b (2).txt', 'a_b.txt']);
  assert.deepEqual(['a_b.txt', 'a_b (2).txt'].map((n) => readFileSync(join(dir, 'Notes', n))[0]).sort(), [1, 2]);
  assert.equal(task.skipped, 0);
  assert.equal(task.files, 2);
  assert.deepEqual(task.errors, []);
  const again = fakePull(files);
  const task2 = fakeTask();
  await pullToPc({ adb: 'adb', serial: 'X', plan, dest: dir, task: task2, spawnAdb: again.spawnAdb, lanes: 2 });
  assert.equal(task2.skipped, 2);
  assert.equal(again.calls.length, 0);
  assert.equal(heldNames(), 0);
}));

test('saving one folder twice at once makes one set of files', () => inDir(async (dir) => {
  const t = sampleTree();
  const { spawnAdb, calls } = fakePull({
    '/sdcard/DCIM/Camera/a.jpg': Buffer.alloc(3000, 1),
    '/sdcard/DCIM/Camera/b.jpg': Buffer.alloc(2000, 2),
    '/sdcard/DCIM/c.png': Buffer.alloc(500, 3),
  }, { pause: 20 });
  const plan = pullPlan(t, t.root.sub.get('DCIM'));
  const [one, two] = [fakeTask(), fakeTask()];
  await Promise.all([one, two].map((task) => pullToPc({ adb: 'adb', serial: 'X', plan, dest: dir, task, spawnAdb, lanes: 2 })));
  assert.equal(calls.length, 3); // each file came from the phone once
  assert.equal(one.skipped + two.skipped, 3);
  assert.equal(one.files + two.files, 6);
  assert.deepEqual([...one.errors, ...two.errors], []);
  assert.deepEqual(readdirSync(join(dir, 'DCIM')).sort(), ['Camera', 'c.png']);
  assert.deepEqual(readdirSync(join(dir, 'DCIM', 'Camera')).sort(), ['a.jpg', 'b.jpg']);
  assert.equal(one.bytes, 5500);
  assert.equal(two.bytes, 5500);
  assert.equal(heldNames(), 0);
}));

test('when one of two copies of a file fails, the other saves it and does not call it already there', () => inDir(async (dir) => {
  const t = createTree('/sdcard', '/');
  t.addFile(['v.mp4'], 100, 100);
  t.finish();
  const { spawnAdb, calls } = fakePull({ '/sdcard/v.mp4': Buffer.alloc(100, 9) }, { delay: 20, failOnce: ['/sdcard/v.mp4'] });
  const plan = pullPlan(t, t.root, 'v.mp4');
  const [one, two] = [fakeTask(), fakeTask()];
  await Promise.all([one, two].map((task) => pullToPc({ adb: 'adb', serial: 'X', plan, dest: dir, task, spawnAdb })));
  assert.equal(calls.length, 2);
  assert.equal(one.errors.length + two.errors.length, 1);
  assert.equal(one.skipped + two.skipped, 0);
  assert.equal(one.files + two.files, 1);
  assert.deepEqual(readdirSync(dir), ['v.mp4']);
  assert.equal(readFileSync(join(dir, 'v.mp4'))[0], 9);
  assert.equal(heldNames(), 0);
}));

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
  const { spawnAdb } = fakePull({ '/sdcard/DCIM/a.jpg': Buffer.alloc(3000), '/sdcard/DCIM/b.jpg': Buffer.alloc(2000) });
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
