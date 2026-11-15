import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appDirsSize, isWholeShared, notScanned, phoneUsed } from '../public/phone-gap.js';

test('isWholeShared is true only for the whole shared storage', () => {
  assert.equal(isWholeShared('/storage/emulated/0'), true);
  assert.equal(isWholeShared('/storage/emulated/0/'), true);
  assert.equal(isWholeShared('/sdcard'), true);
  assert.equal(isWholeShared('/storage/emulated/0/DCIM'), false);
  assert.equal(isWholeShared(null), false);
});

test('phoneUsed takes the /data line of df', () => {
  assert.equal(phoneUsed({ df: [{ mount: '/storage/emulated', total: 9, free: 1 }, { mount: '/data', total: 100, free: 4 }] }), 96);
  assert.equal(phoneUsed({ df: [] }), null);
});

test('appDirsSize adds Android/data and Android/obb', () => {
  const root = { children: [
    { kind: 'dir', name: 'DCIM', size: 500 },
    { kind: 'dir', name: 'Android', size: 90, children: [
      { kind: 'dir', name: 'data', size: 30 }, { kind: 'dir', name: 'obb', size: 20 }, { kind: 'dir', name: 'media', size: 40 },
    ] },
  ] };
  assert.equal(appDirsSize(root), 50);
  assert.equal(appDirsSize({ children: [] }), 0);
});

test('notScanned splits the gap like the first real phone (SM-F9560)', () => {
  const used = 979792824 * 1024;
  const g = notScanned({
    used, scanned: 845565350226, appDirs: 19.5e9,
    categories: [{ key: 'apps', size: 73334339072 }, { key: 'appData', size: 88377958344 }, { key: 'system', size: 92312211456 }],
  });
  assert.equal(g.gap, used - 845565350226);
  assert.equal(g.apps, 73334339072);
  assert.equal(g.privateData, 88377958344 - 19.5e9);
  assert.equal(g.apps + g.privateData + g.android, g.gap);
  assert.ok(g.android > 0);
});

test('notScanned caps the parts at the gap and is null without one', () => {
  const g = notScanned({ used: 100, scanned: 90, categories: [{ key: 'apps', size: 6 }, { key: 'appData', size: 50 }], appDirs: 0 });
  assert.deepEqual(g, { gap: 10, apps: 6, privateData: 4, android: 0 });
  assert.equal(notScanned({ used: 100, scanned: 100 }), null);
  assert.equal(notScanned({ used: null, scanned: 5 }), null);
});
