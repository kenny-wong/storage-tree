import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatBytes, formatDate, formatPercent, formatSeconds } from '../public/format.js';
import { kindOf } from '../public/kinds.js';
import { squarify } from '../public/treemap.js';
import { allowed, route } from '../lib/http.js';
import { localPath } from '../api/scans.js';

test('formatBytes uses 1024 steps like Windows', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(25 * 1024 ** 2), '25.0 MB');
  assert.equal(formatBytes(118 * 1024 ** 3), '118 GB');
  assert.equal(formatBytes(null), '–');
});

test('formatPercent, formatDate and formatSeconds', () => {
  assert.equal(formatPercent(1, 3), '33%');
  assert.equal(formatPercent(1, 2000), '<0.1%');
  assert.equal(formatPercent(5, 100), '5.0%');
  assert.equal(formatPercent(1, 0), '');
  assert.equal(formatDate(0), '');
  assert.equal(formatDate(1731628800), '15 Nov 2024');
  assert.equal(formatSeconds(4.25), '4.3 s');
  assert.equal(formatSeconds(75.4), '1 min 15 s');
});

test('kindOf groups extensions', () => {
  assert.equal(kindOf('JPG'), 'image');
  assert.equal(kindOf('mp4'), 'video');
  assert.equal(kindOf('apk'), 'app');
  assert.equal(kindOf('zzz'), 'other');
  assert.equal(kindOf(''), 'other');
});

test('squarify fills the rectangle with areas in proportion to size', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((size, i) => ({ size, i }));
  const boxes = squarify(items, { x: 0, y: 0, w: 600, h: 400 });
  assert.equal(boxes.length, 7);
  const area = boxes.reduce((s, b) => s + b.w * b.h, 0);
  assert.ok(Math.abs(area - 240000) < 1e-6);
  for (const b of boxes) {
    assert.ok(Math.abs(b.w * b.h - (b.item.size / 24) * 240000) < 1e-6);
    assert.ok(b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= 600 + 1e-6 && b.y + b.h <= 400 + 1e-6);
  }
  // Squarified boxes stay reasonably square.
  const worst = Math.max(...boxes.map((b) => Math.max(b.w / b.h, b.h / b.w)));
  assert.ok(worst < 3, `aspect ${worst}`);
});

test('squarify leaves out empty items and copes with an empty list', () => {
  assert.deepEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
  assert.equal(squarify([{ size: 0 }, { size: 5 }], { x: 0, y: 0, w: 10, h: 10 }).length, 1);
});

test('only this PC’s own pages may use the API', () => {
  assert.equal(allowed({ host: '127.0.0.1:8850' }, 'GET', 8850), true);
  assert.equal(allowed({ host: 'evil.example:8850' }, 'GET', 8850), false);
  assert.equal(allowed({ host: '127.0.0.1:8850', origin: 'https://evil.example' }, 'POST', 8850), false);
  assert.equal(allowed({ host: 'localhost:8850', origin: 'http://localhost:8850' }, 'POST', 8850), true);
});

test('route matches methods and parameters', () => {
  const routes = [['GET', '/api/scans/:id/nodes/:nid', 'node'], ['POST', '/api/scans', 'create']];
  assert.deepEqual(route(routes, 'GET', '/api/scans/3/nodes/0'), { handler: 'node', params: { id: '3', nid: '0' } });
  assert.equal(route(routes, 'GET', '/api/scans'), null);
});

test('localPath wants a full path; a bare drive letter means its root', { skip: process.platform !== 'win32' }, () => {
  assert.equal(localPath('D:'), 'D:\\');
  assert.equal(localPath('"C:\\Users\\k"'), 'C:\\Users\\k');
  assert.equal(localPath('Users'), null);
  assert.equal(localPath(''), null);
});

test('the version on the page matches package.json', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, new RegExp(`id="version">v${version.replace(/\./g, '\\.')}<`));
});

test('the desktop window keeps its own pages, opens web links in the browser and refuses the rest', async () => {
  const { linkAction, windowKey } = await import('../electron/links.js');
  assert.equal(linkAction('http://127.0.0.1:8851/x', 'http://127.0.0.1:8851'), 'app');
  assert.equal(linkAction('https://developer.android.com/', 'http://127.0.0.1:8851'), 'browser');
  assert.equal(linkAction('file:///C:/Windows', 'http://127.0.0.1:8851'), 'deny');
  assert.equal(linkAction('not a url', 'http://127.0.0.1:8851'), 'deny');
  assert.equal(windowKey({ type: 'keyDown', key: 'F5' }), 'reload');
  assert.equal(windowKey({ type: 'keyDown', key: 'I', control: true, shift: true }), 'devtools');
  assert.equal(windowKey({ type: 'keyUp', key: 'F5' }), null);
});

test('/api/version marks every copy but the installed app as a development copy', async () => {
  const { createApp } = await import('../server.js');
  const get = async (installed) => {
    if (installed) process.env.STORAGE_TREE_INSTALLED = '1';
    else delete process.env.STORAGE_TREE_INSTALLED;
    const server = createApp({ port: 0 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    // allowed() checks the Host against the port the app was made for, so make it for this one.
    server.removeAllListeners('request');
    server.on('request', createApp({ port }).listeners('request')[0]);
    try {
      return await (await fetch(`http://127.0.0.1:${port}/api/version`)).json();
    } finally {
      server.close();
      delete process.env.STORAGE_TREE_INSTALLED;
    }
  };
  assert.equal((await get(false)).dev, true);
  assert.equal((await get(true)).dev, false);
});
