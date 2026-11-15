import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { findAdb, listCommand, parseDevices, parseDf, parseDiskstats, parseDu, parseStatLine, phonePath, relSegments, serialParam, shQuote } from '../lib/adb.js';

test('parseDevices reads adb devices -l, including unauthorized and wireless phones', () => {
  const text = [
    'List of devices attached',
    'R5CT1234ABC            device usb:1-1 product:o1sxeea model:SM_G991B device:o1s transport_id:3',
    '9B241FFAZ007XY         unauthorized usb:1-2 transport_id:4',
    '192.168.1.20:5555      offline product:panther model:Pixel_7 device:panther transport_id:5',
    '',
  ].join('\r\n');
  assert.deepEqual(parseDevices(text), [
    { serial: 'R5CT1234ABC', state: 'device', model: 'SM G991B', product: 'o1sxeea', device: 'o1s' },
    { serial: '9B241FFAZ007XY', state: 'unauthorized', model: '', product: '', device: '' },
    { serial: '192.168.1.20:5555', state: 'offline', model: 'Pixel 7', product: 'panther', device: 'panther' },
  ]);
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
});

test('serialParam accepts adb serials and refuses anything else', () => {
  assert.equal(serialParam('R5CT1234ABC'), 'R5CT1234ABC');
  assert.equal(serialParam('192.168.1.20:5555'), '192.168.1.20:5555');
  assert.equal(serialParam('adb-XYZ._adb-tls-connect._tcp'), 'adb-XYZ._adb-tls-connect._tcp');
  assert.equal(serialParam('a b'), null);
  assert.equal(serialParam('x;rm -rf /'), null);
  assert.equal(serialParam(''), null);
});

test('shQuote makes any path one safe shell word', () => {
  assert.equal(shQuote('/sdcard/My Files'), "'/sdcard/My Files'");
  assert.equal(shQuote("/sdcard/it's"), "'/sdcard/it'\\''s'");
  assert.equal(listCommand('/sdcard/a b'), "find -H '/sdcard/a b' -exec stat -c '%f|%s|%Y|%n' {} +");
});

test('phonePath needs an absolute path and tidies slashes', () => {
  assert.equal(phonePath('/storage/emulated/0/'), '/storage/emulated/0');
  assert.equal(phonePath(' //sdcard//DCIM '), '/sdcard/DCIM');
  assert.equal(phonePath('/'), '/');
  assert.equal(phonePath('sdcard'), null);
  assert.equal(phonePath('/a\nb'), null);
  assert.equal(phonePath(5), null);
});

test('parseStatLine reads mode, size, time and path; folders by their mode bits', () => {
  assert.deepEqual(parseStatLine('81b0|4194304|1731600000|/storage/emulated/0/DCIM/IMG 1|2.jpg'),
    { dir: false, file: true, size: 4194304, mtime: 1731600000, path: '/storage/emulated/0/DCIM/IMG 1|2.jpg' });
  assert.deepEqual(parseStatLine('41f9|3488|1731600000|/storage/emulated/0//DCIM'),
    { dir: true, file: false, size: 3488, mtime: 1731600000, path: '/storage/emulated/0/DCIM' });
  assert.equal(parseStatLine('a1ff|20|1|/sdcard/link').file, false); // a symlink is neither
  assert.equal(parseStatLine('find: /x: Permission denied'), null);
  assert.equal(parseStatLine(''), null);
});

test('relSegments gives the parts below the root, or null outside it', () => {
  assert.deepEqual(relSegments('/storage/emulated/0', '/storage/emulated/0'), []);
  assert.deepEqual(relSegments('/storage/emulated/0', '/storage/emulated/0/DCIM/a.jpg'), ['DCIM', 'a.jpg']);
  assert.equal(relSegments('/storage/emulated/0', '/storage/emulated/01/x'), null);
  assert.deepEqual(relSegments('/', '/data'), ['data']);
});

test('parseDu tells folders from files by what is below them', () => {
  const rows = parseDu('8\t/sdcard/a.txt\n4\t/sdcard/Empty\n16\t/sdcard/DCIM/x.jpg\n16\t/sdcard/DCIM\n28\t/sdcard\n');
  const by = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(by['/sdcard/a.txt'].file, true);
  assert.equal(by['/sdcard/a.txt'].size, 8192);
  assert.equal(by['/sdcard/DCIM'].dir, true);
  assert.equal(by['/sdcard'].dir, true);
  assert.equal(by['/sdcard/Empty'].file, true); // an empty folder looks like a file to du; harmless (4 KB)
});

test('parseDf reads df -k, including a name long enough to wrap', () => {
  const text = [
    'Filesystem       1K-blocks     Used Available Use% Mounted on',
    '/dev/block/dm-48 114906692 80052384  34723236  70% /data',
    '/dev/fuse',
    '                 114906692 80052384  34723236  70% /storage/emulated',
  ].join('\n');
  assert.deepEqual(parseDf(text), [
    { filesystem: '/dev/block/dm-48', total: 114906692 * 1024, used: 80052384 * 1024, free: 34723236 * 1024, mount: '/data' },
    { filesystem: '/dev/fuse', total: 114906692 * 1024, used: 80052384 * 1024, free: 34723236 * 1024, mount: '/storage/emulated' },
  ]);
});

test('parseDiskstats reads the totals, kinds and per-app sizes', () => {
  const text = [
    'Latency: 2ms [512B Data Write]',
    'Data-Free: 34719024K / 114906692K total = 30% free',
    'System-Free: 0K / 6180300K total = 0% free',
    'File-based Encryption: true',
    'App Size: 26431987712',
    'App Data Size: 14101061632',
    'App Cache Size: 2005737472',
    'Photos Size: 9136525312',
    'Videos Size: 2810572800',
    'Audio Size: 0',
    'Downloads Size: 14872576',
    'System Size: 12287475712',
    'Other Size: 4000000',
    'Package Names: ["com.whatsapp","com.android.chrome"]',
    'App Sizes: [100,300]',
    'App Data Sizes: [5000,200]',
    'Cache Sizes: [40,150]',
  ].join('\n');
  const s = parseDiskstats(text);
  assert.equal(s.free, 34719024 * 1024);
  assert.equal(s.total, 114906692 * 1024);
  assert.deepEqual(s.categories.find((c) => c.key === 'photos'), { key: 'photos', size: 9136525312 });
  assert.equal(s.categories.length, 9);
  assert.deepEqual(s.apps, [
    { pkg: 'com.whatsapp', app: 100, data: 5000, cache: 40, total: 5100 },
    { pkg: 'com.android.chrome', app: 300, data: 200, cache: 150, total: 500 },
  ]);
});

test('parseDiskstats copes with output that has no per-app lists', () => {
  const s = parseDiskstats('Data-Free: 1K / 2K total = 50% free\n');
  assert.deepEqual(s, { free: 1024, total: 2048, categories: [], apps: [] });
});

test('findAdb looks at $ADB, PATH, then the Android SDK folder', () => {
  const sdk = join('C:\\Users\\k\\AppData\\Local', 'Android', 'Sdk', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  assert.equal(findAdb({ LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local', PATH: '' }, (p) => p === sdk), sdk);
  assert.equal(findAdb({ ADB: 'X:\\adb.exe' }, (p) => p === 'X:\\adb.exe'), 'X:\\adb.exe');
  assert.equal(findAdb({ PATH: '' }, () => false), null);
});
