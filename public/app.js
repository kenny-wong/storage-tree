// The page: choose this PC or a phone, scan, then browse the folder tree,
// treemap, largest files, file types and (phones) apps.

import { formatBytes, formatCount, formatDate, formatPercent, formatSeconds } from './format.js';
import { KIND_NAMES, kindOf } from './kinds.js';
import { squarify } from './treemap.js';

const $ = (id) => document.getElementById(id);
const MODE_KEY = 'storage-tree:mode:v1';
const LOCAL_PATH_KEY = 'storage-tree:local-path:v1';
const PHONE_PATH_KEY = 'storage-tree:phone-path:v1';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/** Makes an element: h('div', { class: 'x', onclick }, 'text', child). Text is always set as text. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${res.status}`), { status: res.status, code: body.error });
  return body;
}

const caretSvg = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M6 3l5 5-5 5');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  svg.append(p);
  return svg;
};

const meter = (part, whole, full = false) => h('div', { class: `meter${full ? ' full' : ''}` }, h('i', { style: `width:${whole ? Math.min(100, (part / whole) * 100).toFixed(2) : 0}%` }));

const state = {
  mode: 'local',
  scan: null, // status from the server
  nodes: new Map(), // folder id -> { …folder, children } (depth 2)
  expanded: new Set([0]),
  selected: 0,
  tab: 'tree',
  storage: null, // phone storage summary
  storageSerial: null,
  devices: [],
  pollTimer: null,
};

/* ---------- source: this PC / phone ---------- */

function setMode(mode) {
  state.mode = mode;
  store.set(MODE_KEY, mode);
  $('mode-local').setAttribute('aria-selected', String(mode === 'local'));
  $('mode-phone').setAttribute('aria-selected', String(mode === 'phone'));
  $('source-local').hidden = mode !== 'local';
  $('source-phone').hidden = mode !== 'phone';
  if (mode === 'phone') loadDevices();
}

async function loadDrives() {
  const box = $('drives');
  try {
    const { drives } = await api('/api/drives');
    box.replaceChildren(...drives.map((d) => {
      const used = d.total != null ? d.total - d.free : null;
      return h('button', { type: 'button', class: 'drive', title: `Scan ${d.path}`, onclick: () => { $('local-path').value = d.path; scanLocal(); } },
        h('strong', {}, d.path.replace(/\\$/, '')),
        meter(used ?? 0, d.total ?? 0, d.total && used / d.total > 0.9),
        h('small', {}, d.total != null ? `${formatBytes(d.free)} free of ${formatBytes(d.total)}` : 'Not ready'));
    }));
  } catch (err) {
    box.replaceChildren(h('span', { class: 'muted' }, `Drives: ${err.message}`));
  }
}

function phoneHelp(kind, extra = '') {
  const help = $('phone-help');
  help.hidden = !kind;
  if (!kind) return;
  const steps = {
    'no-adb': ['adb (Android platform-tools) was not found.', [
      'Install it: ', h('code', {}, 'winget install Google.PlatformTools'), ', or set the ', h('code', {}, 'ADB'), ' environment variable to adb.exe.',
    ], ['Then press Refresh.']],
    none: ['No phone found.', [
      'On the phone: Settings → About phone → tap ', h('b', {}, 'Build number'), ' 7 times.',
    ], ['Settings → System → Developer options → turn on ', h('b', {}, 'USB debugging'), '.'],
    ['Connect the USB cable, choose "File transfer" if asked, then press Refresh.']],
    unauthorized: ['The phone has not allowed this PC yet.', ['Unlock the phone and tap ', h('b', {}, 'Allow'), ' on "Allow USB debugging?" (tick "Always allow from this computer").'], ['Then press Refresh.']],
    offline: ['The phone is offline to adb.', ['Unplug and reconnect the cable, or turn USB debugging off and on again, then press Refresh.']],
  }[kind] ?? [extra];
  const [title, ...items] = steps;
  help.replaceChildren(...[h('b', {}, title), extra && kind !== 'other' ? h('div', {}, extra) : null, items.length ? h('ol', {}, items.map((i) => h('li', {}, i))) : null].filter(Boolean));
}

async function loadDevices() {
  const sel = $('device');
  const prev = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'Looking for phones…'));
  try {
    const { adb, devices, error } = await api('/api/devices');
    state.devices = devices;
    if (!adb) {
      sel.replaceChildren(h('option', { value: '' }, 'adb not found'));
      phoneHelp('no-adb');
      return;
    }
    if (!devices.length) {
      sel.replaceChildren(h('option', { value: '' }, 'No phone connected'));
      phoneHelp('none', error);
      $('phone-summary').hidden = true;
      return;
    }
    sel.replaceChildren(...devices.map((d) => h('option', { value: d.serial }, `${d.model || d.serial}${d.state === 'device' ? '' : ` (${d.state})`}`)));
    if (devices.some((d) => d.serial === prev)) sel.value = prev;
    onDeviceChange();
  } catch (err) {
    sel.replaceChildren(h('option', { value: '' }, 'Error'));
    phoneHelp('other', err.message);
  }
}

function currentDevice() {
  return state.devices.find((d) => d.serial === $('device').value) ?? null;
}

async function onDeviceChange() {
  const d = currentDevice();
  if (!d) return;
  if (d.state !== 'device') {
    phoneHelp(d.state === 'unauthorized' ? 'unauthorized' : 'offline');
    $('phone-summary').hidden = true;
    return;
  }
  phoneHelp(null);
  const box = $('phone-summary');
  box.hidden = false;
  box.replaceChildren(h('span', { class: 'muted' }, 'Reading the phone’s storage…'));
  try {
    const s = await api(`/api/devices/${encodeURIComponent(d.serial)}/storage`);
    state.storage = s;
    state.storageSerial = d.serial;
    renderPhoneSummary(s);
    if (state.scan?.source === 'phone' && state.scan.serial === d.serial) renderApps();
  } catch (err) {
    box.replaceChildren(h('span', { class: 'muted' }, `Could not read storage: ${err.message}`));
  }
}

const CAT_STYLE = {
  apps: ['Apps', '--k-app'], appData: ['App data', '--k-data'], photos: ['Photos', '--k-image'], videos: ['Videos', '--k-video'],
  audio: ['Audio', '--k-audio'], downloads: ['Downloads', '--k-archive'], system: ['System', '--k-other'], other: ['Other files', '--k-document'],
};

function renderPhoneSummary(s) {
  const box = $('phone-summary');
  const data = s.df.find((f) => f.mount === '/data') ?? s.df[0];
  const total = data?.total ?? s.total;
  const free = data?.free ?? s.free;
  const used = total != null && free != null ? total - free : null;
  const cats = s.categories.filter((c) => c.key in CAT_STYLE && c.size > 0);
  const cache = s.categories.find((c) => c.key === 'appCache');
  box.replaceChildren(
    h('div', { class: 'total' },
      h('div', {}, h('b', {}, s.name), s.android ? h('span', { class: 'muted' }, ` · Android ${s.android}`) : null),
      h('div', { class: 'stack', title: 'Space by kind, from Android’s own daily count' },
        cats.map((c) => h('i', { style: `width:${((c.size / total) * 100).toFixed(2)}%;background:var(${CAT_STYLE[c.key][1]})`, title: `${CAT_STYLE[c.key][0]}: ${formatBytes(c.size)}` }))),
      h('div', { class: 'muted' }, used != null ? `${formatBytes(used)} used of ${formatBytes(total)} · ${formatBytes(free)} free` : '')),
    h('div', { class: 'cats' },
      cats.map((c) => h('span', {}, h('i', { class: 'dot', style: `background:var(${CAT_STYLE[c.key][1]})` }), CAT_STYLE[c.key][0], h('b', {}, formatBytes(c.size)))),
      cache?.size ? h('span', {}, 'of which app cache', h('b', {}, formatBytes(cache.size))) : null,
      s.apps.length ? h('button', { type: 'button', class: 'link', onclick: showAppsNow }, `${s.apps.length} apps →`) : null),
  );
}

function showAppsNow() {
  $('results').hidden = false;
  $('tab-apps').hidden = false;
  if (!state.scan) $('crumbs').replaceChildren();
  setTab('apps');
}

/* ---------- scanning ---------- */

async function startScan(body) {
  clearTimeout(state.pollTimer);
  if (state.scan && state.scan.state === 'scanning') api(`/api/scans/${state.scan.id}/cancel`, { method: 'POST' }).catch(() => {});
  try {
    const scan = await api('/api/scans', { method: 'POST', body: JSON.stringify(body) });
    state.scan = scan;
    state.nodes.clear();
    state.expanded = new Set([0]);
    state.selected = 0;
    $('results').hidden = true;
    renderStatus();
    poll();
  } catch (err) {
    showStatusError(err.message);
  }
}

function scanLocal() {
  const path = $('local-path').value.trim();
  if (!path) return $('local-path').focus();
  store.set(LOCAL_PATH_KEY, path);
  startScan({ source: 'local', path });
}

function scanPhone() {
  const d = currentDevice();
  if (!d || d.state !== 'device') {
    loadDevices();
    return;
  }
  const path = $('phone-path').value.trim() || '/storage/emulated/0';
  store.set(PHONE_PATH_KEY, path);
  startScan({ source: 'phone', serial: d.serial, path, label: d.model || d.serial });
}

async function poll() {
  const id = state.scan?.id;
  if (!id) return;
  try {
    const s = await api(`/api/scans/${id}`);
    if (state.scan?.id !== id) return;
    state.scan = s;
    renderStatus();
    if (s.state === 'scanning') {
      state.pollTimer = setTimeout(poll, 400);
    } else if (s.root) {
      await showResults();
    }
  } catch (err) {
    showStatusError(err.message);
  }
}

function showStatusError(message) {
  const box = $('status');
  box.hidden = false;
  box.className = 'status failed';
  box.replaceChildren(h('span', {}, message));
}

function renderStatus() {
  const s = state.scan;
  const box = $('status');
  box.hidden = false;
  box.className = `status${s.state === 'failed' ? ' failed' : ''}`;
  const where = s.source === 'phone' ? `${s.label}: ${s.path}` : s.path;
  const parts = [];
  if (s.state === 'scanning') {
    parts.push(h('i', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, `Scanning ${where} — ${formatCount(s.entries)} items, ${formatSeconds(s.seconds)}`),
      h('button', { type: 'button', class: 'ghost', onclick: () => api(`/api/scans/${s.id}/cancel`, { method: 'POST' }) }, 'Stop'));
  } else if (s.state === 'failed') {
    parts.push(h('span', {}, `Scan of ${where} failed: ${s.error}`));
  } else {
    parts.push(h('span', {}, `${s.state === 'cancelled' ? 'Stopped' : 'Scanned'} ${where}: `, h('b', {}, formatBytes(s.root?.size)),
      ` in ${formatCount(s.root?.count)} files and ${formatCount(s.root?.dirCount)} folders, ${formatSeconds(s.seconds)}`,
      s.method === 'du' ? ' (sizes from du, rounded to whole KB)' : ''),
    h('button', { type: 'button', class: 'ghost', onclick: () => startScan(s.source === 'phone' ? { source: 'phone', serial: s.serial, path: s.path, label: s.label } : { source: 'local', path: s.path }) }, 'Scan again'));
  }
  if (s.errorCount) {
    parts.push(h('details', {}, h('summary', {}, `${formatCount(s.errorCount)} ${s.errorCount === 1 ? 'place' : 'places'} could not be read${s.source === 'phone' ? ' (Android keeps some folders private to their apps)' : ''}`),
      h('ul', {}, s.errors.map((e) => h('li', {}, `${e.path} — ${e.code}`)))));
  }
  box.replaceChildren(...parts);
}

/* ---------- results ---------- */

async function fetchNode(nid) {
  if (state.nodes.has(nid)) return state.nodes.get(nid);
  const n = await api(`/api/scans/${state.scan.id}/nodes/${nid}?depth=3`);
  state.nodes.set(nid, n);
  return n;
}

async function showResults() {
  $('results').hidden = false;
  $('tab-apps').hidden = state.scan.source !== 'phone';
  if (state.tab === 'apps' && state.scan.source !== 'phone') state.tab = 'tree';
  await select(0);
}

async function select(nid) {
  state.selected = nid;
  const n = await fetchNode(nid);
  for (const c of n.crumbs.slice(0, -1)) {
    await fetchNode(c.id);
    state.expanded.add(c.id);
  }
  if (state.selected !== nid) return;
  renderCrumbs(n);
  renderTree();
  $('tree').querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
  drawMap();
  if (state.tab === 'largest') renderLargest();
  if (state.tab === 'types') renderTypes();
}

function renderCrumbs(n) {
  const nav = $('crumbs');
  nav.replaceChildren(...n.crumbs.flatMap((c, i) => [
    i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '›') : null,
    h('button', { type: 'button', 'aria-current': i === n.crumbs.length - 1 ? 'page' : null, title: c.name, onclick: () => select(c.id) }, c.name),
  ]).filter(Boolean));
}

async function toggle(nid) {
  if (state.expanded.has(nid)) state.expanded.delete(nid);
  else {
    await fetchNode(nid);
    state.expanded.add(nid);
  }
  renderTree();
}

function renderTree() {
  const box = $('tree');
  const rows = [];
  const root = state.nodes.get(0);
  if (!root) return;
  const local = state.scan.source === 'local';
  const walk = (n, depth, parentSize) => {
    rows.push(dirRow({ kind: 'dir', id: n.id, name: n.name, size: n.size, count: n.count, mtime: n.mtime }, depth, parentSize, true));
    if (!state.expanded.has(n.id)) return;
    for (const c of n.children) {
      if (c.kind === 'dir' && state.expanded.has(c.id) && state.nodes.has(c.id)) walk(state.nodes.get(c.id), depth + 1, n.size);
      else if (c.kind === 'dir') rows.push(dirRow(c, depth + 1, n.size, false));
      else if (c.kind === 'file') rows.push(fileRow(c, n, depth + 1, local));
      else rows.push(h('div', { class: 'row tree-cols more-row' }, h('div', { class: 'name', style: `padding-left:${(depth + 1) * 16 + 24}px` }, c.name), h('div', { class: 'num' }, formatBytes(c.size)), h('div'), h('div', { class: 'files-col' }), h('div', { class: 'hide-narrow' })));
    }
  };
  walk(root, 0, root.size);
  box.replaceChildren(...rows);
}

function dirRow(c, depth, parentSize, loaded) {
  const open = state.expanded.has(c.id) && loaded;
  const canOpen = !c.empty;
  return h('div', { class: `row tree-cols dir-row${state.selected === c.id ? ' sel' : ''}`, role: 'treeitem', 'aria-expanded': canOpen ? String(open) : null, onclick: () => select(c.id), ondblclick: () => toggle(c.id) },
    h('div', { class: 'name', style: `padding-left:${depth * 16}px` },
      h('button', { type: 'button', class: `caret${canOpen ? '' : ' blank'}`, 'aria-expanded': String(open), 'aria-label': open ? 'Collapse' : 'Expand', onclick: (e) => { e.stopPropagation(); toggle(c.id); } }, caretSvg()),
      h('i', { class: 'dot', style: 'background:var(--k-dir);outline:1px solid var(--line)' }),
      h('span', { class: 'label', title: c.name }, c.name),
      state.scan.source === 'local' ? h('span', { class: 'actions' }, h('button', { type: 'button', title: 'Show in Explorer', onclick: (e) => { e.stopPropagation(); reveal(c.id); } }, 'Open')) : null),
    h('div', { class: 'num' }, formatBytes(c.size)),
    h('div', { class: 'share' }, meter(c.size, parentSize), h('span', { class: 'pct' }, formatPercent(c.size, parentSize))),
    h('div', { class: 'num muted files-col' }, formatCount(c.count)),
    h('div', { class: 'num muted hide-narrow' }, formatDate(c.mtime)));
}

function fileRow(c, parent, depth, local) {
  return h('div', { class: 'row tree-cols file-row' },
    h('div', { class: 'name', style: `padding-left:${depth * 16}px` },
      h('span', { class: 'caret blank' }),
      h('i', { class: 'dot', style: `background:var(--k-${kindOf(c.ext)})` }),
      h('span', { class: 'label', title: c.name }, c.name),
      local ? h('span', { class: 'actions' }, h('button', { type: 'button', title: 'Show in Explorer', onclick: () => reveal(parent.id, c.name) }, 'Show')) : null),
    h('div', { class: 'num' }, formatBytes(c.size)),
    h('div', { class: 'share' }, meter(c.size, parent.size), h('span', { class: 'pct' }, formatPercent(c.size, parent.size))),
    h('div', { class: 'num muted files-col' }),
    h('div', { class: 'num muted hide-narrow' }, formatDate(c.mtime)));
}

async function reveal(dir, file) {
  try {
    await api(`/api/scans/${state.scan.id}/reveal`, { method: 'POST', body: JSON.stringify({ dir, file }) });
  } catch (err) {
    alert(err.message);
  }
}

async function renderLargest() {
  const box = $('largest');
  const nid = state.selected;
  box.replaceChildren(h('p', { class: 'note' }, 'Finding the largest files…'));
  const { files } = await api(`/api/scans/${state.scan.id}/largest?under=${nid}&n=300`);
  if (state.selected !== nid) return;
  const local = state.scan.source === 'local';
  box.replaceChildren(...(files.length ? files.map((f) => h('div', { class: 'row file-cols file-row' },
    h('div', { class: 'name' },
      h('i', { class: 'dot', style: `background:var(--k-${kindOf(f.ext)})` }),
      h('span', { class: 'label', title: f.path }, f.name),
      h('small', { title: f.path }, f.path.slice(0, f.path.length - f.name.length)),
      local ? h('span', { class: 'actions' }, h('button', { type: 'button', onclick: () => reveal(f.dirId, f.name) }, 'Show')) : null),
    h('div', { class: 'num' }, formatBytes(f.size)),
    h('div', { class: 'num muted hide-narrow' }, formatDate(f.mtime)))) : [h('p', { class: 'note' }, 'No files here.')]));
}

async function renderTypes() {
  const box = $('types');
  const nid = state.selected;
  const { types, size } = await api(`/api/scans/${state.scan.id}/types?under=${nid}`);
  if (state.selected !== nid) return;
  const byKind = new Map();
  for (const t of types) {
    const k = kindOf(t.ext);
    const g = byKind.get(k) ?? { size: 0, count: 0 };
    g.size += t.size;
    g.count += t.count;
    byKind.set(k, g);
  }
  const kindRows = [...byKind].sort((a, b) => b[1].size - a[1].size).map(([k, g]) => h('div', { class: 'row type-cols' },
    h('div', { class: 'name' }, h('i', { class: 'dot', style: `background:var(--k-${k})` }), h('b', {}, KIND_NAMES[k])),
    h('div', { class: 'num' }, formatBytes(g.size)),
    h('div', { class: 'share' }, meter(g.size, size), h('span', { class: 'pct' }, formatPercent(g.size, size))),
    h('div', { class: 'num muted' }, formatCount(g.count))));
  const extRows = types.slice(0, 300).map((t) => h('div', { class: 'row type-cols' },
    h('div', { class: 'name' }, h('i', { class: 'dot', style: `background:var(--k-${kindOf(t.ext)})` }), h('span', { class: 'label' }, t.ext ? `.${t.ext}` : '(no extension)')),
    h('div', { class: 'num' }, formatBytes(t.size)),
    h('div', { class: 'share' }, meter(t.size, size), h('span', { class: 'pct' }, formatPercent(t.size, size))),
    h('div', { class: 'num muted' }, formatCount(t.count))));
  box.replaceChildren(...kindRows, h('div', { class: 'grid-head type-cols' }, h('span', {}, 'By extension'), h('span'), h('span'), h('span')), ...extRows);
}

function renderApps() {
  const box = $('apps');
  const s = state.storage;
  if (!s || !s.apps.length) {
    $('apps-note').textContent = 'Android has no per-app sizes for this phone yet (they come from a daily job; try again later).';
    box.replaceChildren();
    return;
  }
  $('apps-note').textContent = `Sizes from Android’s own daily count on ${s.name}. App data includes its cache. App files live in /data, which a scan over USB can’t read, so they appear here instead of in Folders.`;
  const max = s.apps[0].total;
  box.replaceChildren(...s.apps.map((a) => h('div', { class: 'row app-cols' },
    h('div', { class: 'name' }, h('i', { class: 'dot', style: 'background:var(--k-app)' }), h('span', { class: 'label', title: a.pkg }, a.pkg), h('span', { style: 'flex:1;min-width:30px;max-width:120px' }, meter(a.total, max))),
    h('div', { class: 'num' }, h('b', {}, formatBytes(a.total))),
    h('div', { class: 'num muted' }, formatBytes(a.app)),
    h('div', { class: 'num muted' }, formatBytes(a.data)),
    h('div', { class: 'num muted hide-narrow' }, formatBytes(a.cache)))));
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of ['tree', 'largest', 'types', 'apps']) $(`view-${t}`).hidden = t !== tab;
  if (!state.scan?.root && tab !== 'apps') return;
  if (tab === 'largest') renderLargest();
  if (tab === 'types') renderTypes();
  if (tab === 'apps') {
    const d = currentDevice();
    if (!state.storage && d) onDeviceChange().then(renderApps);
    else renderApps();
  }
}

/* ---------- treemap ---------- */

let mapBoxes = [];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawMap() {
  const n = state.nodes.get(state.selected);
  const canvas = $('map');
  const wrap = $('map-wrap');
  const w = wrap.clientWidth;
  const hgt = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  mapBoxes = [];
  if (!n) return;
  $('map-title').textContent = n.path;
  $('map-size').textContent = `${formatBytes(n.size)} · ${formatCount(n.count)} files`;
  const colors = Object.fromEntries(['image', 'video', 'audio', 'document', 'archive', 'app', 'data', 'other', 'dir'].map((k) => [k, cssVar(`--k-${k}`)]));
  const lineColor = cssVar('--map-line');
  const textColor = cssVar('--map-text');
  const dirText = cssVar('--text');
  ctx.font = '12px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'top';

  const label = (text, x, y, maxW, color) => {
    if (maxW < 24) return;
    ctx.fillStyle = color;
    let t = text;
    if (ctx.measureText(t).width > maxW) {
      while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
      t += '…';
    }
    ctx.fillText(t, x, y);
  };

  const leaf = (c, r, depth) => {
    const color = c.kind === 'file' ? colors[kindOf(c.ext)] : c.kind === 'dir' ? colors.dir : colors.other;
    ctx.fillStyle = color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    if (r.w > 40 && r.h > 18) label(c.name, r.x + 4, r.y + 3, r.w - 8, c.kind === 'dir' ? dirText : textColor);
    if (r.w > 50 && r.h > 34) label(formatBytes(c.size), r.x + 4, r.y + 17, r.w - 8, c.kind === 'dir' ? dirText : textColor);
    mapBoxes.push({ c, r, depth });
  };

  const layout = (items, rect, depth) => {
    for (const { item: c, x, y, w: bw, h: bh } of squarify(items, rect)) {
      const r = { x, y, w: bw, h: bh };
      if (c.kind === 'dir' && c.children?.length && bw > 46 && bh > 40 && depth < 3) {
        ctx.fillStyle = colors.dir;
        ctx.fillRect(x, y, bw, bh);
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, bw - 2, bh - 2);
        label(`${c.name}  ${formatBytes(c.size)}`, x + 5, y + 4, bw - 10, dirText);
        mapBoxes.push({ c, r, depth });
        layout(c.children, { x: x + 3, y: y + 19, w: bw - 6, h: bh - 22 }, depth + 1);
      } else {
        leaf(c, r, depth);
      }
    }
  };
  layout(n.children, { x: 0, y: 0, w, h: hgt }, 0);
}

function boxAt(ev) {
  const rect = $('map').getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  for (let i = mapBoxes.length - 1; i >= 0; i--) {
    const { r } = mapBoxes[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return { hit: mapBoxes[i], x, y };
  }
  return null;
}

function onMapMove(ev) {
  const tip = $('tip');
  const found = boxAt(ev);
  if (!found) {
    tip.hidden = true;
    return;
  }
  const { c } = found.hit;
  const parent = state.nodes.get(state.selected);
  tip.replaceChildren(h('b', {}, c.name), `${formatBytes(c.size)} · ${formatPercent(c.size, parent?.size)} of this folder`,
    c.kind === 'dir' ? h('div', {}, `${formatCount(c.count)} files · click to open`) : c.kind === 'file' ? h('div', {}, KIND_NAMES[kindOf(c.ext)]) : null);
  tip.hidden = false;
  const wrap = $('map-wrap');
  const tx = Math.min(found.x + 14, wrap.clientWidth - tip.offsetWidth - 4);
  const ty = found.y + 16 + tip.offsetHeight > wrap.clientHeight ? found.y - tip.offsetHeight - 8 : found.y + 16;
  tip.style.left = `${Math.max(4, tx)}px`;
  tip.style.top = `${Math.max(4, ty)}px`;
}

function onMapClick(ev) {
  const found = boxAt(ev);
  if (!found) return;
  // Open the outermost folder under the pointer (the one in this folder), or the inner one when clicked directly.
  const { c } = found.hit;
  if (c.kind === 'dir') select(c.id);
}

function renderLegend() {
  $('legend').replaceChildren(...['image', 'video', 'audio', 'document', 'archive', 'app', 'data', 'other'].map((k) => h('span', {}, h('i', { class: 'dot', style: `background:var(--k-${k})` }), KIND_NAMES[k])),
    h('span', {}, h('i', { class: 'dot', style: 'background:var(--k-dir);outline:1px solid var(--line)' }), 'Folder'));
}

/* ---------- start ---------- */

function init() {
  api('/api/version').then(({ version }) => { $('version').textContent = `v${version}`; }).catch(() => {});
  $('mode-local').addEventListener('click', () => setMode('local'));
  $('mode-phone').addEventListener('click', () => setMode('phone'));
  $('local-form').addEventListener('submit', (e) => { e.preventDefault(); scanLocal(); });
  $('phone-form').addEventListener('submit', (e) => { e.preventDefault(); scanPhone(); });
  $('refresh-devices').addEventListener('click', loadDevices);
  $('device').addEventListener('change', onDeviceChange);
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('map').addEventListener('mousemove', onMapMove);
  $('map').addEventListener('mouseleave', () => { $('tip').hidden = true; });
  $('map').addEventListener('click', onMapClick);
  new ResizeObserver(() => drawMap()).observe($('map-wrap'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawMap);
  $('local-path').value = store.get(LOCAL_PATH_KEY) ?? '';
  $('phone-path').value = store.get(PHONE_PATH_KEY) ?? '/storage/emulated/0';
  renderLegend();
  loadDrives();
  setMode(store.get(MODE_KEY) === 'phone' ? 'phone' : 'local');
}

init();
