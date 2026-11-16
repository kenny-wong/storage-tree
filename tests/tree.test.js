import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childrenOf, createTree, crumbs, extOf, fileTypes, largestFiles } from '../lib/tree.js';

function sample() {
  const t = createTree('/storage/emulated/0');
  t.addDir([]);
  t.addFile(['DCIM', 'Camera', 'a.jpg'], 3000, 100);
  t.addFile(['DCIM', 'Camera', 'b.MP4'], 9000, 300);
  t.addFile(['Download', 'x.apk'], 5000, 200);
  t.addDir(['Empty']);
  t.addFile(['notes'], 10, 50);
  t.finish();
  return t;
}

test('extOf takes the lower-case extension, none for dot files and no dot', () => {
  assert.equal(extOf('Photo.JPG'), 'jpg');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(extOf('.nomedia'), '');
  assert.equal(extOf('README'), '');
  assert.equal(extOf('odd.'), '');
});

test('finish adds sizes, file and folder counts and newest change from the bottom up', () => {
  const t = sample();
  assert.equal(t.root.size, 17010);
  assert.equal(t.root.count, 4);
  assert.equal(t.root.dirCount, 4); // DCIM, Camera, Download, Empty
  assert.equal(t.root.mtime, 300);
  const dcim = t.root.sub.get('DCIM');
  assert.equal(dcim.size, 12000);
  assert.equal(dcim.dirCount, 1);
  assert.equal(t.root.sub.get('Empty').size, 0);
});

test('finish can run again after more entries are added', () => {
  const t = sample();
  t.addFile(['DCIM', 'c.png'], 990);
  t.finish();
  assert.equal(t.root.size, 18000);
  assert.equal(t.root.sub.get('DCIM').count, 3);
});

test('childrenOf lists folders and files together, biggest first, with a "more" row past the limit', () => {
  const t = sample();
  const kids = childrenOf(t.root);
  assert.deepEqual(kids.map((k) => k.name), ['DCIM', 'Download', 'notes', 'Empty']);
  assert.equal(kids[0].kind, 'dir');
  assert.equal(kids[2].kind, 'file');
  assert.equal(kids[3].empty, true);
  const two = childrenOf(t.root, { limit: 2 });
  assert.equal(two.length, 3);
  assert.deepEqual(two[2], { kind: 'more', name: '2 smaller items', count: 2, files: 1, dirs: 1, size: 10, ext: '' });
});

test('the "more" row names what it holds and the extension with most of its bytes', () => {
  const t = createTree('/c');
  t.addFile(['big.mp4'], 1000, 1);
  for (let i = 0; i < 5; i++) t.addFile([`p${i}.jpg`], 50, 1);
  t.addFile(['clip.mp4'], 40, 1);
  t.finish();
  const kids = childrenOf(t.root, { limit: 1 });
  assert.deepEqual(kids[1], { kind: 'more', name: '6 smaller files', count: 6, files: 6, dirs: 0, size: 290, ext: 'jpg' });
});

test('childrenOf with depth 2 fills in the sub-folders for the treemap', () => {
  const t = sample();
  const kids = childrenOf(t.root, { depth: 2 });
  assert.deepEqual(kids[0].children.map((c) => c.name), ['Camera']);
  assert.equal(kids[0].children[0].children, undefined);
  assert.equal(kids[2].children, undefined); // a file
});

test('pathOf joins names with the separator, whether or not the root ends with one', () => {
  const t = sample();
  const cam = t.root.sub.get('DCIM').sub.get('Camera');
  assert.equal(t.pathOf(cam), '/storage/emulated/0/DCIM/Camera');
  assert.equal(t.pathOf(cam, 'a.jpg'), '/storage/emulated/0/DCIM/Camera/a.jpg');
  assert.equal(t.pathOf(t.root), '/storage/emulated/0');
  const w = createTree('C:\\', '\\');
  w.addFile(['Users', 'k.txt'], 1);
  w.finish();
  assert.equal(w.pathOf(w.root.sub.get('Users'), 'k.txt'), 'C:\\Users\\k.txt');
});

test('largestFiles keeps the n biggest, biggest first, with paths', () => {
  const t = sample();
  const top = largestFiles(t, 2);
  assert.deepEqual(top.map((f) => [f.name, f.size]), [['b.MP4', 9000], ['x.apk', 5000]]);
  assert.equal(top[0].path, '/storage/emulated/0/DCIM/Camera/b.MP4');
  assert.equal(top[0].dirId, t.root.sub.get('DCIM').sub.get('Camera').id);
  assert.equal(largestFiles(t, 10).length, 4);
  assert.deepEqual(largestFiles(t, 10, t.root.sub.get('Download')).map((f) => f.name), ['x.apk']);
});

test('largestFiles matches a full sort on many files', () => {
  const t = createTree('/r');
  const sizes = [];
  for (let i = 0; i < 2000; i++) {
    const s = (i * 7919) % 10007;
    sizes.push(s);
    t.addFile([`d${i % 13}`, `f${i}`], s);
  }
  t.finish();
  const want = sizes.sort((a, b) => b - a).slice(0, 50);
  assert.deepEqual(largestFiles(t, 50).map((f) => f.size), want);
});

test('fileTypes adds up space per extension', () => {
  const t = sample();
  assert.deepEqual(fileTypes(t), [
    { ext: 'mp4', size: 9000, count: 1 },
    { ext: 'apk', size: 5000, count: 1 },
    { ext: 'jpg', size: 3000, count: 1 },
    { ext: '', size: 10, count: 1 },
  ]);
});

test('crumbs runs from the root to the folder', () => {
  const t = sample();
  const cam = t.root.sub.get('DCIM').sub.get('Camera');
  assert.deepEqual(crumbs(cam).map((c) => c.name), ['/storage/emulated/0', 'DCIM', 'Camera']);
});

test('finish() run again after a delete does not count the deleted folder', async () => {
  const { createTree: mk } = await import('../lib/tree.js');
  const t = mk('/r');
  t.addFile(['a', 'x'], 10);
  t.addFile(['b', 'y'], 5);
  t.finish();
  t.removeDir(t.root.sub.get('a'));
  t.finish();
  assert.equal(t.root.size, 5);
  assert.equal(t.root.dirCount, 1);
});
