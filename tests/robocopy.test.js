import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elevatedScript, launcherScript, listArgs, parseList, relParts } from '../lib/robocopy.js';
import { errorReason } from '../public/format.js';
import { getScan, protectedFolders, scanStatus, sizeProtected, startScan } from '../lib/scans.js';
import { childrenOf } from '../lib/tree.js';

// As robocopy writes it with /L /FP /NC /BYTES /TS /NJH /NJS (tabs and padding kept).
const LOG = '\uFEFF\r\n'
  + '\t       2\tC:\\Windows\\Temp\\\r\n'
  + '\t  \t\t    5000 2026/11/15 13:01:12\tC:\\Windows\\Temp\\a b.log\r\n'
  + '\t  \t\t13675728896 2026/11/15 13:01:12\tC:\\Windows\\Temp\\big.bin\r\n'
  + '\t       1\tC:\\Windows\\Temp\\深い\\\r\n'
  + '\t  \t\t      10 2026/11/16 02:28:06\tC:\\Windows\\Temp\\深い\\写真.jpg\r\n'
  + '\t       0\tC:\\Windows\\Temp\\empty\\\r\n'
  + '2026/11/16 02:24:52 ERROR 5 (0x00000005) Accessing Source Directory C:\\Windows\\Temp\\x\\\r\n'
  + 'Access is denied.\r\n';

test('parseList reads folders and files (sizes past 8 digits, any names) and skips errors', () => {
  const e = parseList(LOG);
  assert.deepEqual(e.map((x) => [x.dir, x.path, x.size]), [
    [true, 'C:\\Windows\\Temp', undefined],
    [false, 'C:\\Windows\\Temp\\a b.log', 5000],
    [false, 'C:\\Windows\\Temp\\big.bin', 13675728896],
    [true, 'C:\\Windows\\Temp\\深い', undefined],
    [false, 'C:\\Windows\\Temp\\深い\\写真.jpg', 10],
    [true, 'C:\\Windows\\Temp\\empty', undefined],
  ]);
  assert.equal(e[1].mtime, Math.floor(new Date(2026, 10, 15, 13, 1, 12).getTime() / 1000));
});

test('listArgs lists in backup mode only when asked, and never ends a drive root with a bare backslash', () => {
  const a = listArgs({ src: 'C:\\', files: ['hiberfil.sys'], log: 'L', dest: 'D' });
  assert.deepEqual(a.slice(0, 4), ['C:\\.', 'D', 'hiberfil.sys', '/L']);
  assert.ok(!a.includes('/S') && !a.includes('/B'));
  const b = listArgs({ src: 'C:\\Windows\\Temp\\', backup: true, log: 'L', dest: 'D' });
  assert.equal(b[0], 'C:\\Windows\\Temp');
  assert.ok(b.includes('/B') && b.includes('/S') && b.includes('/E') && b.includes('/XJ') && b.includes('/UNILOG:L'));
});

test('relParts finds a path below the scan root, ignoring case', () => {
  assert.deepEqual(relParts('C:\\', 'C:\\Windows\\Temp'), ['Windows', 'Temp']);
  assert.deepEqual(relParts('C:\\Users', 'c:\\users\\Bob'), ['Bob']);
  assert.deepEqual(relParts('C:\\Users', 'C:\\Users'), []);
  assert.equal(relParts('C:\\Users', 'C:\\UsersX\\a'), null);
});

test('the elevated script reads its jobs from a file, and the launcher asks Windows with RunAs', () => {
  const inner = elevatedScript("C:\\T\\it's\\jobs.json", 'C:\\T\\done.txt');
  assert.match(inner, /-LiteralPath 'C:\\T\\it''s\\jobs\.json'/);
  assert.match(inner, /Set-Content -LiteralPath 'C:\\T\\done\.txt'/);
  const outer = launcherScript(inner);
  assert.match(outer, /-Verb RunAs/);
  const enc = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)[1];
  assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), inner);
});

test('errorReason says why in plain words', () => {
  assert.match(errorReason('EPERM'), /no permission/);
  assert.match(errorReason('EBUSY'), /in use/);
  assert.equal(errorReason('EIO'), 'EIO');
});

const tick = () => new Promise((r) => setTimeout(r, 10));

test('a PC scan sizes locked files from a listing and drops their errors', async () => {
  const seen = [];
  const scan = startScan({ source: 'local', path: 'C:\\', sep: '\\' }, {
    scanLocal: async ({ tree, onError }) => {
      tree.addDir([]);
      tree.addFile(['a.txt'], 5);
      onError('C:\\hiberfil.sys', 'EPERM', 'file');
      onError('C:\\Windows\\Temp', 'EPERM', 'dir');
      onError('C:\\gone.txt', 'ENOENT', 'file');
    },
    listLockedFiles: async (groups) => {
      seen.push(...groups);
      return [{ dir: false, path: 'C:\\hiberfil.sys', size: 1000, mtime: 1 }];
    },
  });
  await tick();
  const s = scanStatus(getScan(scan.id));
  assert.deepEqual(seen, [['C:\\', ['hiberfil.sys']]]);
  assert.equal(s.root.size, 1005);
  assert.equal(s.errorCount, 2);
  assert.deepEqual(s.errors, [{ path: 'C:\\Windows\\Temp', code: 'EPERM' }, { path: 'C:\\gone.txt', code: 'ENOENT' }]);
  assert.equal(s.protectedCount, 1);
  assert.deepEqual(s.protectedSample, ['Temp']);
});

test('sizeProtected adds what an administrator listing found, marked locked', async () => {
  const scan = startScan({ source: 'local', path: 'C:\\', sep: '\\' }, {
    scanLocal: async ({ tree, onError }) => {
      tree.addDir([]);
      tree.addDir(['Windows']);
      tree.addFile(['Windows', 'x.dll'], 7);
      onError('C:\\Windows\\Temp', 'EACCES', 'dir');
      onError('C:\\Windows\\Missing', 'EPERM', 'dir');
    },
    listLockedFiles: async () => [],
  });
  await tick();
  const s = getScan(scan.id);
  assert.deepEqual(protectedFolders(s), ['C:\\Windows\\Temp', 'C:\\Windows\\Missing']);
  await sizeProtected(s, async (folders) => folders.map((folder) => ({ folder, entries: folder.endsWith('Temp') ? parseList(LOG) : null })));
  const st = scanStatus(s);
  assert.equal(st.admin.state, 'done');
  assert.equal(st.admin.read, 1);
  assert.equal(st.admin.bytes, 5000 + 13675728896 + 10);
  assert.equal(st.root.size, 7 + 5000 + 13675728896 + 10);
  assert.equal(st.errorCount, 1);
  assert.equal(st.protectedCount, 1);
  const win = childrenOf(s.tree.root).find((c) => c.name === 'Windows');
  const temp = childrenOf(s.tree.root.sub.get('Windows')).find((c) => c.name === 'Temp');
  assert.equal(win.locked, undefined);
  assert.equal(temp.locked, true);
  assert.equal(temp.count, 3);
  assert.equal(temp.dirCount, 2);
});

test('sizeProtected keeps the folders listed when permission is refused', async () => {
  const scan = startScan({ source: 'local', path: 'C:\\', sep: '\\' }, {
    scanLocal: async ({ tree, onError }) => { tree.addDir([]); onError('C:\\Windows\\Temp', 'EPERM', 'dir'); },
    listLockedFiles: async () => [],
  });
  await tick();
  const s = getScan(scan.id);
  await sizeProtected(s, async () => { throw new Error('Administrator permission was not given.'); });
  const st = scanStatus(s);
  assert.equal(st.admin.state, 'failed');
  assert.match(st.admin.message, /not given/);
  assert.equal(st.errorCount, 1);
  assert.equal(st.protectedCount, 1);
});

test('a running scan can be read: status has live totals and the folder routes answer', async () => {
  const { node } = await import('../api/scans.js');
  let release;
  const scan = startScan({ source: 'local', path: 'C:\\', sep: '\\' }, {
    scanLocal: async ({ tree }) => { tree.addDir([]); tree.addFile(['Users', 'a.bin'], 50); await new Promise((r) => { release = r; }); },
    listLockedFiles: async () => [],
  });
  await tick();
  const st = scanStatus(scan);
  assert.equal(st.state, 'scanning');
  assert.equal(st.finished, false);
  assert.equal(st.root.size, 50);
  const r = node({ params: { id: String(scan.id), nid: '0' }, query: new URLSearchParams('depth=2') });
  const body = r.body ?? r;
  assert.equal(JSON.stringify(body).includes('"Users"'), true);
  release();
  await tick();
  assert.equal(scanStatus(scan).state, 'done');
});
