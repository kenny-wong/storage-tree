import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createTree } from '../lib/tree.js';
import { scanLocal } from '../lib/scan-local.js';
import { scanPhone } from '../lib/scan-phone.js';
import { getScan, scanStatus, startScan } from '../lib/scans.js';

/** A stand-in for `adb shell …` that prints the given output and exits. */
function fakeSpawn(stdout, stderr = '', code = 0) {
  return (adb, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.args = args;
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setTimeout(() => child.emit('close', code, null), 20);
    });
    return child;
  };
}

test('scanPhone builds the tree from find/stat lines and reports unreadable folders', async () => {
  const root = '/storage/emulated/0';
  const out = [
    `41f9|3488|1700000000|${root}`,
    `41f9|3488|1700000000|${root}/DCIM`,
    `81b0|2000|1700000100|${root}/DCIM/a.jpg`,
    `81b0|500|1700000200|${root}/notes.txt`,
    `41f9|3488|1700000000|${root}/Android`,
  ].join('\n');
  const tree = createTree(root);
  const errors = [];
  const r = await scanPhone({ adb: 'adb', serial: 'X', root, tree, onError: (p, c) => errors.push([p, c]), spawnAdb: fakeSpawn(out, `find: ${root}/Android/data: Permission denied\n`) });
  tree.finish();
  assert.equal(r.method, 'stat');
  assert.equal(tree.root.size, 2500);
  assert.equal(tree.root.count, 2);
  assert.equal(tree.root.dirCount, 2);
  assert.deepEqual(errors, [[`${root}/Android/data`, 'Permission denied']]);
});

test('scanPhone falls back to du when find/stat print nothing', async () => {
  const tree = createTree('/sdcard');
  const r = await scanPhone({
    adb: 'adb', serial: 'X', root: '/sdcard', tree,
    spawnAdb: fakeSpawn('', 'find: unknown option -H\n', 1),
    run: async (adb, args) => {
      assert.match(args.at(-1), /^du -a -k '\/sdcard'$/);
      return { code: 0, stdout: '8\t/sdcard/a.txt\n12\t/sdcard/D/b.bin\n12\t/sdcard/D\n20\t/sdcard\n', stderr: '' };
    },
  });
  tree.finish();
  assert.equal(r.method, 'du');
  assert.equal(tree.root.size, 20 * 1024);
});

test('scanPhone fails with adb’s message when the phone is gone', async () => {
  const tree = createTree('/sdcard');
  await assert.rejects(scanPhone({ adb: 'adb', serial: 'X', root: '/sdcard', tree, spawnAdb: fakeSpawn('', "adb: device 'X' not found\n", 1) }), /not found/);
});

test('scanLocal adds up a real folder and skips nothing it can read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-'));
  try {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'top.txt'), 'x'.repeat(100));
    writeFileSync(join(dir, 'a', 'one.bin'), Buffer.alloc(1000));
    writeFileSync(join(dir, 'a', 'b', 'two.bin'), Buffer.alloc(2500));
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, 'a', `f${i}.txt`), 'y');
    const tree = createTree(dir, sep);
    await scanLocal({ root: dir, tree, concurrency: 4 });
    tree.finish();
    assert.equal(tree.root.size, 100 + 1000 + 2500 + 300);
    assert.equal(tree.root.count, 303);
    assert.equal(tree.root.dirCount, 3);
    assert.equal(tree.root.sub.get('empty').size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanLocal reports a folder it cannot read and still finishes', async () => {
  const tree = createTree('Z:\\nope', '\\');
  const errors = [];
  await scanLocal({ root: join(tmpdir(), 'storage-tree-missing-folder'), tree, onError: (p, c) => errors.push(c) });
  assert.deepEqual(errors, ['ENOENT']);
});

test('startScan runs a scan and its status shows the totals when done', async () => {
  const scan = startScan({ source: 'phone', path: '/sdcard', serial: 'X', adb: 'adb' }, {
    scanPhone: async ({ tree, onError }) => {
      tree.addFile(['a'], 10);
      onError('/sdcard/x', 'Permission denied');
      return { method: 'stat' };
    },
  });
  assert.equal(scanStatus(scan).state, 'scanning');
  await new Promise((r) => setTimeout(r, 10));
  const s = scanStatus(getScan(scan.id));
  assert.equal(s.state, 'done');
  assert.equal(s.root.size, 10);
  assert.equal(s.errorCount, 1);
  assert.equal(s.method, 'stat');
});

test('startScan marks a failed scan with its message', async () => {
  const scan = startScan({ source: 'phone', path: '/sdcard', serial: 'X', adb: 'adb' }, { scanPhone: async () => { throw new Error('no phone'); } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scanStatus(scan).state, 'failed');
  assert.equal(scanStatus(scan).error, 'no phone');
});
