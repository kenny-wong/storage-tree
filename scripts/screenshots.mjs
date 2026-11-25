// Takes the README's screenshots (docs/images/*.png): the real server and page
// with a made-up drive and phone, so nobody's own folders end up in them.
// Nothing is read from this PC or a phone. Needs Chrome: node scripts/screenshots.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8861;
const DEBUG_PORT = 8862;
const OUT = fileURLToPath(new URL('../docs/images/', import.meta.url));
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { createApp, VERSION } = await import('../server.js');
const { scanStatus, startScan } = await import('../lib/scans.js');
const { fileTypes } = await import('../lib/tree.js');
const { kindOf } = await import('../public/kinds.js');
const { startTask } = await import('../lib/tasks.js');

/* ---------- made-up files ---------- */

const MB = 1e6;
const GB = 1e9;
let seed = 7;
const rnd = () => { // the same files every time
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const between = (a, b) => Math.round(a + (b - a) * rnd());
const when = (year) => Math.floor(Date.UTC(year, between(0, year === 2026 ? 9 : 11), between(1, 28), between(8, 20), between(0, 59), between(0, 59)) / 1000);
const stamp = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

function filler(tree) {
  const add = (path, size, year = 2026) => tree.addFile(path.split('/'), Math.round(size), when(year));
  const many = (dir, n, name, [lo, hi], year) => {
    for (let i = 1; i <= n; i++) add(`${dir}/${name(i)}`, between(lo, hi), year);
  };
  const shots = (dir, n, prefix, ext, [lo, hi], year) => {
    for (let i = 0; i < n; i++) {
      const t = when(year);
      tree.addFile([...dir.split('/'), `${prefix}${stamp(t)}.${ext}`], between(lo, hi), t);
    }
  };
  return { add, many, shots };
}

function fillDrive(tree) {
  const { add, many, shots } = filler(tree);
  for (const [trip, year, n] of [['2024 Norway', 2024, 9], ['2025 Japan', 2025, 13], ['2026 Scotland', 2026, 8]]) {
    shots(`Videos/${trip}`, n, 'clip_', 'mp4', [0.6 * GB, 4.2 * GB], year);
  }
  add('Videos/Edits/Japan film 4K master.mov', 23.4 * GB, 2025);
  add('Videos/Edits/Japan film 1080p.mp4', 5.1 * GB, 2025);
  add('Videos/Edits/Norway film.mp4', 7.8 * GB, 2024);
  for (const y of [2022, 2023, 2024, 2025, 2026]) {
    shots(`Photos/${y}`, 1100 + (y - 2022) * 230, 'IMG_', 'jpg', [3 * MB, 9 * MB], y);
    shots(`Photos/${y}`, 60 + (y - 2022) * 24, 'RAW_', 'dng', [24 * MB, 34 * MB], y);
  }
  add('Backups/Laptop backup 2026-08.zip', 31.2 * GB, 2026);
  add('Backups/Laptop backup 2025-11.zip', 27.6 * GB, 2025);
  add('Backups/Old desktop.vhdx', 18.9 * GB, 2023);
  many('Backups/Phone/Pictures', 900, (i) => `photo ${i}.jpg`, [2 * MB, 6 * MB], 2024);
  for (const [g, n] of [['Sky Racers', 46], ['Deep Harbour', 34], ['Pixel Farm', 12]]) {
    many(`Games/${g}`, Math.round(n / 4), (i) => `data_${String(i).padStart(3, '0')}.pak`, [0.4 * GB, 2.6 * GB], 2025);
    many(`Games/${g}`, 60, (i) => `module${i}.dll`, [1 * MB, 30 * MB], 2025);
    add(`Games/${g}/${g}.exe`, 2.2 * GB, 2025);
  }
  for (const a of ['Quiet Roads', 'Northern Line', 'Paper Lanterns', 'Field Notes', 'Harbour Lights']) {
    many('Music', 160, (i) => `${a} ${String(i).padStart(2, '0')}.flac`, [24 * MB, 46 * MB], 2023);
  }
  add('Downloads/linux-desktop-24.10.iso', 5.9 * GB, 2025);
  add('Downloads/video-editor-setup.exe', 2.6 * GB, 2026);
  add('Downloads/Holiday videos from Sam.zip', 8.4 * GB, 2026);
  many('Downloads', 140, (i) => `document (${i}).pdf`, [0.2 * MB, 14 * MB], 2026);
  many('Documents/Scans', 420, (i) => `scan ${String(i).padStart(4, '0')}.pdf`, [1 * MB, 5 * MB], 2024);
  many('Documents/Accounts', 160, (i) => `sheet ${i}.xlsx`, [0.1 * MB, 2 * MB], 2025);
  for (const p of ['garden-planner', 'recipe-box', 'weather-station']) {
    many(`Projects/${p}/node_modules/packages`, 1500, (i) => `module-${i}.js`, [2000, 90_000], 2026);
    many(`Projects/${p}/src`, 120, (i) => `part${i}.js`, [1000, 40_000], 2026);
    add(`Projects/${p}/data/readings.sqlite`, between(200 * MB, 900 * MB), 2026);
  }
}

function fillPhone(tree) {
  const { add, many, shots } = filler(tree);
  shots('DCIM/Camera', 1200, '', 'jpg', [2.5 * MB, 8 * MB], 2025);
  shots('DCIM/Camera', 900, '', 'jpg', [2.5 * MB, 8 * MB], 2026);
  shots('DCIM/Camera', 17, '', 'mp4', [1.0 * GB, 3.6 * GB], 2026);
  tree.addFile(['DCIM', 'Camera', '20260718_153012.mp4'], 4.6 * GB, Date.UTC(2026, 6, 18, 15, 30) / 1000);
  shots('DCIM/Screenshots', 1400, 'Screenshot_', 'jpg', [0.4 * MB, 1.6 * MB], 2026);
  shots('DCIM/Screen recordings', 9, 'Screen_Recording_', 'mp4', [80 * MB, 620 * MB], 2026);
  many('DCIM/.thumbnails', 1900, (i) => `${100000 + i}.jpg`, [20_000, 90_000], 2026);
  shots('Pictures/Edited', 140, 'edit_', 'jpg', [2 * MB, 7 * MB], 2026);
  shots('Movies/Clips', 12, 'clip_', 'mp4', [120 * MB, 900 * MB], 2026);
  const wa = 'Android/media/com.whatsapp/WhatsApp/Media';
  shots(`${wa}/WhatsApp Video`, 420, 'VID-', 'mp4', [4 * MB, 64 * MB], 2026);
  shots(`${wa}/WhatsApp Images`, 2600, 'IMG-', 'jpg', [0.1 * MB, 0.6 * MB], 2026);
  shots(`${wa}/WhatsApp Voice Notes`, 800, 'PTT-', 'opus', [10_000, 400_000], 2026);
  add('Android/media/com.whatsapp/WhatsApp/Databases/msgstore.db', 410 * MB, 2026);
  many('Android/data/com.spotify.music/files', 180, (i) => `offline${i}.bin`, [20 * MB, 60 * MB], 2026);
  many('Android/data/com.google.android.youtube/cache', 90, (i) => `${i}.cache`, [1 * MB, 22 * MB], 2026);
  many('Android/obb/com.example.skyracers', 2, (i) => `main.${i}.obb`, [1.1 * GB, 1.9 * GB], 2025);
  add('Download/Holiday videos from Sam.zip', 3.2 * GB, 2026);
  add('Download/map-offline.zip', 1.4 * GB, 2025);
  many('Download', 90, (i) => `ticket ${i}.pdf`, [0.1 * MB, 9 * MB], 2026);
  many('Music/Quiet Roads', 60, (i) => `${String(i).padStart(2, '0')} Track ${i}.mp3`, [6 * MB, 12 * MB], 2024);
  shots('Recordings/Voice Recorder', 38, 'Voice ', 'm4a', [2 * MB, 60 * MB], 2026);
}

/* ---------- the app, with those instead of this PC and a phone ---------- */

const PHONE = { serial: 'DEMO0001', state: 'device', model: 'Android phone', product: '', device: '', transport: 'usb', transports: ['usb'], serials: ['DEMO0001'], wifiSerials: [] };
let phoneScan = null;
let pcSize = 0;

function phoneStorage() {
  const scanned = phoneScan?.tree.root.size ?? 0;
  const used = scanned + 52 * GB;
  const kinds = { image: 0, video: 0, audio: 0 };
  if (phoneScan) for (const t of fileTypes(phoneScan.tree, phoneScan.tree.root)) if (kindOf(t.ext) in kinds) kinds[kindOf(t.ext)] += t.size;
  return {
    name: 'Android phone',
    android: '16',
    df: [{ filesystem: '/dev/block/data', total: 256 * GB, used, free: 256 * GB - used, mount: '/data' }],
    free: 256 * GB - used,
    total: 256 * GB,
    categories: [['apps', 27.4 * GB], ['appData', 29.1 * GB], ['appCache', 3.8 * GB], ['photos', kinds.image], ['videos', kinds.video], ['audio', kinds.audio], ['downloads', 5.2 * GB], ['system', 14.6 * GB]].map(([key, size]) => ({ key, size })),
    apps: [['com.example.skyracers', 2.1, 3.4], ['com.whatsapp', 0.2, 4.9], ['com.spotify.music', 0.2, 4.6], ['com.google.android.youtube', 0.4, 1.9]].map(([pkg, a, d]) => ({ pkg, app: a * GB, data: d * GB, cache: 0.2 * d * GB, total: (a + d) * GB })),
  };
}

// Times shown are what these many files take in reality (measured: about 14,000 files a second on a PC, 4,000 on a phone).
async function demoScan(source) {
  const fill = (make) => async ({ tree }) => { seed = 7; make(tree); return source === 'phone' ? { method: 'stat' } : undefined; };
  const opts = source === 'phone'
    ? { source, path: '/storage/emulated/0', serial: PHONE.serial, label: PHONE.model, sep: '/' }
    : { source, path: 'D:\\', sep: '\\' };
  const scan = startScan(opts, { scanLocal: fill(fillDrive), scanPhone: fill(fillPhone), listLockedFiles: async () => [] });
  while (scan.state === 'scanning' || !scan.finished) await new Promise((r) => setTimeout(r, 5));
  scan.started = scan.finished - (scan.tree.root.count / (source === 'phone' ? 4000 : 14_000)) * 1000;
  if (source === 'phone') phoneScan = scan;
  else pcSize = scan.tree.root.size;
  return scan;
}

const app = createApp({ port: PORT });
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (path === '/api/version') return json({ version: VERSION, downloads: 'C:\\Users\\Sam\\Downloads', app: true, dev: false });
  if (path === '/api/drives') return json({ drives: [{ path: 'C:\\', total: 1000 * GB, free: 612 * GB }, { path: 'D:\\', total: 500 * GB, free: 500 * GB - (pcSize || 430 * GB) - 2 * GB }, { path: 'E:\\', total: 2000 * GB, free: 1480 * GB }] });
  if (path === '/api/devices') return json({ adb: 'adb.exe', devices: [PHONE] });
  if (/^\/api\/devices\/[^/]+\/storage$/.test(path)) return json(phoneStorage());
  if (path === '/api/scans' && req.method === 'POST') {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', async () => json(scanStatus(await demoScan(JSON.parse(text).source))));
    return;
  }
  app.emit('request', req, res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ---------- Chrome over the DevTools protocol ---------- */

const profile = mkdtempSync(join(tmpdir(), 'storage-tree-shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not start');
}

const ws = await connect();
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (!m.id) return;
  const { resolve, reject } = waiting.get(m.id);
  waiting.delete(m.id);
  if (m.error) reject(new Error(m.error.message));
  else resolve(m.result);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  waiting.set(nextId, { resolve, reject });
  ws.send(JSON.stringify({ id: nextId++, method, params }));
});
async function run(expression) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression) {
  for (let i = 0; i < 80; i++) {
    if (await run(`return Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`never true: ${expression}`);
}

const WIDTH = 1280;
const HEIGHT = 800;
const size = (height = HEIGHT, width = WIDTH) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1.5, mobile: false });
const theme = (value) => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
async function shot(name, clip) {
  await sleep(350);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  console.log(name, Math.round(data.length * 0.75 / 1024), 'KB');
}

const row = (name) => `[...document.querySelectorAll('#tree .dir-row')].find((r) => r.querySelector('.label').textContent === ${JSON.stringify(name)})`;
const open = async (name) => {
  await until(row(name));
  await run(`${row(name)}.querySelector('.caret').click()`);
  await until(`${row(name)}.getAttribute('aria-expanded') === 'true'`);
};
const pick = async (name) => {
  await until(row(name));
  await run(`${row(name)}.click()`);
  await until(`document.querySelector('#crumbs [aria-current]').textContent === ${JSON.stringify(name)}`);
};
const tab = (name) => run(`document.querySelector('[data-tab=${name}]').click()`);
/** The area around an element, for a close-up. */
const around = (selector, pad) => run(`const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.max(0, r.x - ${pad}), y: Math.max(0, r.y - ${pad}), width: Math.min(innerWidth, r.width + ${pad * 2}), height: Math.min(innerHeight, r.height + ${pad * 2}) };`);

try {
  mkdirSync(OUT, { recursive: true });
  await demoScan('local'); // so the drive's free space fits what is on it
  await cdp('Page.enable');
  await size();
  await theme('light');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until("document.querySelectorAll('.drive').length === 3");

  // This PC: one drive, one folder open.
  await run("document.querySelectorAll('.drive')[1].click()");
  await until("!document.getElementById('results').hidden && document.querySelectorAll('#tree .row').length > 5");
  await open('Photos');
  await shot('pc.png');
  await theme('dark');
  await shot('pc-dark.png');
  await theme('light');

  // Largest files, with the menu of one open.
  await tab('largest');
  await until("document.querySelectorAll('#largest .row').length > 10");
  await run(`const r = [...document.querySelectorAll('#largest .row')][3]; const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 210, clientY: b.y + 20 }));`);
  await shot('largest.png');
  await run("document.dispatchEvent(new Event('pointerdown'))");
  await tab('tree');

  // Phone: shared storage with the tags.
  await run("document.getElementById('mode-phone').click()");
  await until("document.getElementById('device').value === 'DEMO0001'");
  await run("document.getElementById('phone-form').requestSubmit()");
  await until("!document.getElementById('results').hidden && document.querySelectorAll('#tree .row').length > 5");
  await run("document.getElementById('refresh-devices').click()"); // the storage summary, now that the scan's total is known
  await until("document.querySelector('.status .gap')");
  await size(1010);
  await open('DCIM');
  await open('Android');
  await shot('phone.png');

  // Save to PC: the dialog, then a copy part way.
  await pick('DCIM');
  await run(`${row('DCIM')}.querySelector('.more').click();`);
  await run("[...document.querySelectorAll('#menu button')].find((b) => b.textContent.startsWith('Save to PC')).click()");
  await shot('save.png', await around('#save-dialog', 26));
  await run("document.getElementById('save-dialog').close()");
  await run("document.getElementById('open-wifi').click()");
  await shot('wifi.png', await around('#wifi-dialog', 26));

  startTask({ kind: 'pull', label: '20260718_153012.mp4 → C:\\Users\\Sam\\Downloads', dest: 'C:\\Users\\Sam\\Downloads\\20260718_153012.mp4', isFile: true }, (t) => {
    Object.assign(t, { bytes: 2.9 * GB, totalBytes: 4.6 * GB, totalFiles: 1, current: null });
    t.started = Date.now() - 10_600;
    return new Promise(() => {});
  });
  await size(HEIGHT, 820);
  await cdp('Page.reload');
  await until("document.querySelector('.task.running')");
  await shot('copying.png', await around('#tasks', 0));
} finally {
  await cdp('Browser.close').catch(() => {});
  chrome.kill();
  server.close();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Chrome still letting go of it */ }
}
process.exit(0);
