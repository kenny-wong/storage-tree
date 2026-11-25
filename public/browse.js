// The Browse tab: one phone folder at a time, as Windows Explorer shows it.
// Only the tiles on screen exist in the page, and only their previews are
// asked for, many in one request. Folders seen before show at once from
// memory while the phone is asked again.

import { arrange, canOpen, canPlay, canView, countText, crumbsOf, extOf, formatLength, formatWhen, hasPreview, kindOfEntry, select, typeName, unpackPreviews, windowOf } from './browse-list.js';
import { formatBytes, formatCount } from './format.js';

const SETTINGS_KEY = 'storage-tree:browse:v1';
const HOME = '/storage/emulated/0/DCIM/Camera';
const VIEWS = { large: { w: 204, h: 206 }, medium: { w: 132, h: 142 }, list: { w: 300, h: 34 }, details: { w: Infinity, h: 36 } };
const BATCH = 32; // previews in one request
const LANES = 2; // requests at once
const MAX_THUMBS = 3000;
const MAX_FOLDERS = 25;
const MAX_FULL = 6;

export function initBrowse({ $, h, api, store, toast, showMenu, deleteDialog, saveDialog, addTask, dragName }) {
  const set = { path: HOME, view: 'large', sort: 'date', desc: true, hidden: false };
  try {
    const s = JSON.parse(store.get(SETTINGS_KEY) ?? '{}');
    for (const k of Object.keys(set)) if (typeof s[k] === typeof set[k]) set[k] = s[k];
  } catch { /* damaged settings: the usual ones */ }
  if (!VIEWS[set.view]) set.view = 'large';
  const keep = () => store.set(SETTINGS_KEY, JSON.stringify(set));

  let device = null; // { serial, … } as in the phone list
  let folder = null; // { id, path, entries, media, scroll }
  let path = set.path;
  let shown = []; // entries in the order on screen
  let sel = { selected: new Set(), anchor: null };
  let cursor = null;
  let kind = 'all';
  let turn = 0; // newest folder request; older answers are dropped
  const back = [];
  const forward = [];
  const folders = new Map(); // serial + path -> folder, to show at once
  const cells = new Map(); // name -> element on screen

  const scroll = $('b-scroll');
  const space = $('b-space');
  const fullPath = (name) => (folder.path === '/' ? `/${name}` : `${folder.path}/${name}`);
  const picked = () => shown.filter((e) => sel.selected.has(e.name));

  /* ---------- folders ---------- */

  function setDevice(d) {
    const same = d && device?.serial === d.serial;
    device = d;
    if (!d) {
      turn++;
      folder = null;
      busy('');
      $('b-places').replaceChildren();
      stopPreviews();
      render();
      note('Connect a phone to browse its files.');
      return;
    }
    if (!same) {
      back.length = 0;
      forward.length = 0;
      folder = null;
      stopPreviews();
      loadPlaces();
    }
    go(path, { step: false });
  }

  async function loadPlaces() {
    const { serial } = device;
    try {
      const { places } = await api(`/api/browse/places?serial=${encodeURIComponent(serial)}`);
      if (device?.serial !== serial) return;
      $('b-places').replaceChildren(...places.map((p) => h('button', { type: 'button', 'data-path': p.path, title: p.path, onclick: () => go(p.path) }, p.label)));
      markPlace();
    } catch { /* the list itself says what is wrong */ }
  }

  function markPlace() {
    for (const b of $('b-places').children) {
      if (b.dataset.path === path) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
  }

  function note(...parts) {
    const list = parts.filter(Boolean);
    $('b-note').hidden = !list.length;
    $('b-note').replaceChildren(...list);
  }

  const sameEntries = (a, b) => a.length === b.length && a.every((e, i) => e.name === b[i].name && e.size === b[i].size && e.mtime === b[i].mtime && e.dir === b[i].dir);

  const busy = (text) => { $('b-busy').textContent = text; };

  /** Opens a folder; `step` puts the one before it in the history. `focus` names what to select when it is there. */
  async function go(to, { step: record = true, focus = null } = {}) {
    if (!device) return;
    const { serial } = device;
    const mine = ++turn;
    if (folder) folder.scroll = scroll.scrollTop;
    if (record && to !== path) {
      back.push(path);
      forward.length = 0;
    }
    const moved = to !== path || !folder;
    path = to;
    set.path = to;
    keep();
    if (moved) {
      folder = folders.get(`${serial}|${to}`) ?? null;
      sel = { selected: new Set(focus ? [focus] : []), anchor: focus };
      cursor = focus;
      $('b-filter').value = '';
      stopPreviews();
      render();
      if (!folder) note('Reading the folder…');
      scroll.scrollTop = folder?.scroll ?? 0;
      if (focus) reveal(focus);
    }
    renderPath();
    busy('Reading…');
    if (!folder) await showSaved(serial, to, mine, focus);
    if (mine !== turn) return;
    if (folder?.stale) busy('Checking for changes…');
    try {
      const got = await api('/api/browse', { method: 'POST', body: JSON.stringify({ serial, path: to }) });
      if (mine !== turn) return;
      const first = !folder;
      const same = folder && sameEntries(folder.entries, got.entries);
      path = got.path; // /sdcard and the like become shared storage's own path
      set.path = path;
      busy('');
      folder = { id: got.id, path: got.path, entries: got.entries, media: folder?.media ?? {}, scroll: folder?.scroll ?? 0 };
      remember(serial);
      renderPath();
      if (same) { // nothing to redraw; the new list's id is what matters
        wantPreviews();
        if (!Object.keys(folder.media).length) loadMedia(mine);
        return;
      }
      const there = new Set(folder.entries.map((e) => e.name));
      sel = { selected: new Set([...sel.selected].filter((n) => there.has(n))), anchor: sel.anchor };
      render();
      if (first && focus) reveal(focus);
      loadMedia(mine);
    } catch (err) {
      if (mine !== turn) return;
      busy('');
      if (folder?.stale) { // the phone didn't answer: the kept list stays, marked as such
        busy('Shown as last seen: the phone didn’t answer.');
        toast(err.message, true);
        return;
      }
      folder = null;
      stopPreviews();
      render();
      note(err.message, ' ', h('button', { type: 'button', class: 'link', onclick: () => go(to, { step: false }) }, 'Try again'));
    }
  }

  /** A folder not seen since the app started: the list kept on this PC, shown at once while the phone is asked. */
  async function showSaved(serial, to, mine, focus) {
    try {
      const got = await api('/api/browse', { method: 'POST', body: JSON.stringify({ serial, path: to, saved: true }) });
      if (mine !== turn || !got.saved) return;
      folder = { id: got.id, path: got.path, entries: got.entries, media: got.media ?? {}, scroll: 0, stale: true };
      render();
      if (focus) reveal(focus);
    } catch { /* nothing kept: wait for the phone */ }
  }

  function remember(serial) {
    const k = `${serial}|${folder.path}`;
    folders.delete(k);
    folders.set(k, folder);
    if (folders.size > MAX_FOLDERS) folders.delete(folders.keys().next().value);
  }

  /** Dimensions and video lengths; they come a moment after the list. */
  async function loadMedia(mine) {
    const f = folder;
    if (!f.entries.some(hasPreview)) return;
    try {
      f.media = (await api(`/api/browse/${f.id}/media`)).media;
      if (mine === turn) render();
    } catch { /* they stay empty */ }
  }

  const up = () => {
    const c = crumbsOf(path);
    if (c.length > 1) go(c.at(-2)[1], { focus: c.at(-1)[0] });
  };
  const step = (from, to) => {
    if (!from.length) return;
    to.push(path);
    go(from.pop(), { step: false });
  };

  function renderPath() {
    const c = crumbsOf(path);
    $('b-crumbs').replaceChildren(...c.flatMap(([label, p], i) => [
      i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '›') : null,
      h('button', { type: 'button', 'aria-current': i === c.length - 1 ? 'page' : null, title: p, onclick: () => go(p) }, label),
    ]).filter(Boolean));
    $('b-back').disabled = !back.length;
    $('b-forward').disabled = !forward.length;
    $('b-up').disabled = c.length < 2;
    markPlace();
  }

  /* ---------- the list ---------- */

  const COLS = [['name', 'Name'], ['date', 'Modified'], ['type', 'Type'], ['size', 'Size'], ['dims', 'Dimensions'], ['length', 'Length']];
  const WAYS = { date: ['Oldest first', 'Newest first'], name: ['A to Z', 'Z to A'], type: ['A to Z', 'Z to A'], length: ['Shortest first', 'Longest first'] };

  function render() {
    shown = folder ? arrange(folder.entries, { sort: set.sort, desc: set.desc, text: $('b-filter').value, kind, hidden: set.hidden, media: folder.media }) : [];
    for (const el of cells.values()) el.remove();
    cells.clear();
    $('b-sort').value = set.sort;
    $('b-way').textContent = (WAYS[set.sort] ?? ['Smallest first', 'Largest first'])[set.desc ? 1 : 0];
    for (const b of document.querySelectorAll('.b-views button')) b.setAttribute('aria-selected', String(b.dataset.view === set.view));
    $('b-head').hidden = set.view !== 'details';
    $('b-head').replaceChildren(...COLS.map(([k, label]) => h('button', { type: 'button', class: `c-${k}`, onclick: () => sortBy(k) }, label, set.sort === k ? h('i', {}, set.desc ? ' ▾' : ' ▴') : null)));
    scroll.className = `b-scroll v-${set.view}`;
    if (folder) note(shown.length ? '' : folder.entries.length ? 'Nothing here matches.' : 'This folder is empty.');
    draw();
    renderCount();
  }

  function sortBy(k) {
    if (set.sort === k) set.desc = !set.desc;
    else {
      set.sort = k;
      set.desc = k !== 'name' && k !== 'type';
    }
    keep();
    render();
    scroll.scrollTop = 0;
  }

  function layout() {
    const v = VIEWS[set.view];
    return windowOf({ count: shown.length, width: space.clientWidth, height: scroll.clientHeight, scrollTop: scroll.scrollTop, cellW: v.w, cellH: v.h });
  }

  /** Puts the tiles that are on screen (and a little around) into the page, and takes the others out. */
  function draw() {
    const w = layout();
    const cellH = VIEWS[set.view].h;
    space.style.height = `${w.total}px`;
    const want = new Map();
    for (let i = w.first; i < w.last; i++) want.set(shown[i].name, i);
    for (const [name, el] of cells) {
      if (want.has(name)) continue;
      el.remove();
      cells.delete(name);
    }
    for (const [name, i] of want) {
      let el = cells.get(name);
      if (!el) {
        el = makeCell(shown[i]);
        cells.set(name, el);
        space.append(el);
      }
      el.style.left = `${(i % w.cols) * w.cellW}px`;
      el.style.top = `${Math.floor(i / w.cols) * cellH}px`;
      el.style.width = `${w.cellW}px`;
      el.style.height = `${cellH}px`;
    }
    mark();
    wantPreviews();
  }

  function mark() {
    for (const [name, el] of cells) {
      el.classList.toggle('sel', sel.selected.has(name));
      el.setAttribute('aria-selected', String(sel.selected.has(name)));
      el.classList.toggle('cursor', name === cursor);
    }
  }

  function renderCount() {
    const items = picked();
    const n = `${formatCount(shown.length)} ${shown.length === 1 ? 'item' : 'items'}`;
    const size = items.reduce((s, e) => s + e.size, 0);
    $('b-count').textContent = !folder ? '' : items.length ? `${n} · ${formatCount(items.length)} selected${size ? ` (${formatBytes(size)})` : ''}` : n;
  }

  const thumbKey = (e, at = folder) => `${at.path}/${e.name}|${e.size}|${e.mtime}`;

  function art(e) {
    const box = h('div', { class: 'b-art' });
    const url = thumbs.get(thumbKey(e));
    if (url) box.append(h('img', { src: url, alt: '', draggable: 'false', decoding: 'sync' }));
    else if (e.dir) box.append(h('i', { class: 'b-folder' }));
    else box.append(h('i', { class: 'b-file', style: `--kind:var(--k-${kindOfEntry(e)})` }, extOf(e.name).slice(0, 5) || '?'));
    if (kindOfEntry(e) === 'video') {
      const ms = folder.media[e.name]?.[2];
      box.append(h('span', { class: 'b-video' }, `▶${ms ? ` ${formatLength(ms)}` : ''}`));
    }
    return box;
  }

  function makeCell(e) {
    const m = folder.media[e.name];
    const dims = m?.[0] ? `${m[0]} × ${m[1]}` : '';
    const tip = [e.name, typeName(e), e.dir ? '' : formatBytes(e.size), formatWhen(e.mtime), dims].filter(Boolean).join('\n');
    const el = h('div', { class: `b-cell${set.view === 'details' ? ' b-cols' : ''}`, role: 'option', title: tip, draggable: e.dir ? null : 'true', 'data-name': e.name });
    el.append(h('div', { class: 'b-name' }, art(e), h('span', { class: 'b-label' }, e.name)));
    if (set.view === 'details') {
      el.append(h('div', { class: 'c-date' }, formatWhen(e.mtime)), h('div', { class: 'c-type' }, typeName(e)),
        h('div', { class: 'num c-size' }, e.dir ? '' : formatBytes(e.size)), h('div', { class: 'num c-dims' }, dims), h('div', { class: 'num c-length' }, formatLength(m?.[2])));
    }
    return el;
  }

  function reveal(name) {
    const i = shown.findIndex((e) => e.name === name);
    if (i < 0) return;
    const w = layout();
    const cellH = VIEWS[set.view].h;
    const y = Math.floor(i / w.cols) * cellH;
    if (y < scroll.scrollTop) scroll.scrollTop = y;
    else if (y + cellH > scroll.scrollTop + scroll.clientHeight - 12) scroll.scrollTop = y + cellH - scroll.clientHeight + 12;
  }

  /* ---------- previews ---------- */

  const thumbs = new Map(); // key -> blob address, or '' when there is none
  const asked = new Set();
  let queue = [];
  let lanes = 0;
  let stopper = new AbortController();
  let wantTimer = null;

  function stopPreviews() {
    stopper.abort();
    stopper = new AbortController();
    asked.clear();
    queue = [];
  }

  function wantPreviews() {
    clearTimeout(wantTimer);
    wantTimer = setTimeout(() => {
      if (!folder || !device || !scroll.clientHeight) return;
      const w = layout();
      // What is on screen first, then one screen further down.
      const ahead = Math.min(shown.length, w.last + (w.last - w.first));
      queue = shown.slice(w.first, ahead).filter((e) => hasPreview(e) && !thumbs.has(thumbKey(e)) && !asked.has(thumbKey(e)));
      pump();
    }, 60);
  }

  const isJpeg = (e) => /^jpe?g$/.test(extOf(e.name));

  function pump() {
    while (folder && lanes < LANES && queue.length) {
      // Photos on their own: the rest waits for Android's index of the folder, which takes a second the first time.
      const photo = isJpeg(queue[0]);
      const batch = queue.filter((e) => isJpeg(e) === photo).slice(0, BATCH);
      queue = queue.filter((e) => !batch.includes(e));
      fetchPreviews(batch);
    }
  }

  async function fetchPreviews(items) {
    lanes++;
    const f = folder;
    const { signal } = stopper;
    const keys = new Map(items.map((e) => [e.name, thumbKey(e, f)]));
    for (const k of keys.values()) asked.add(k);
    try {
      const res = await fetch(`/api/browse/${f.id}/thumbs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: items.map((e) => e.name) }), signal });
      if (!res.ok) throw new Error('no previews');
      const got = unpackPreviews(await res.arrayBuffer());
      const blobs = await Promise.all(got.map(picture));
      got.forEach((p, i) => { if (p.whole && blobs[i] && keys.has(p.name)) keepPreview(f, p.name, blobs[i]); });
      got.forEach((p, i) => { if (blobs[i] && keys.has(p.name)) addThumb(keys.get(p.name), URL.createObjectURL(blobs[i])); });
      for (const k of keys.values()) if (!thumbs.has(k)) addThumb(k, '');
      if (folder?.path === f.path) {
        for (const e of items) if (thumbs.get(keys.get(e.name))) cells.get(e.name)?.querySelector('.b-art').replaceWith(art(e));
      }
    } catch { /* stopped, or the phone went away: asked again when drawn again */ } finally {
      if (!signal.aborted) for (const k of keys.values()) asked.delete(k);
      lanes--;
    }
    pump();
  }

  /** Sends a preview made from a whole picture to be kept on this PC, so the picture isn't read whole next time. */
  async function keepPreview(f, name, blob) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await api(`/api/browse/${f.id}/keep`, { method: 'POST', body: JSON.stringify({ name, data: btoa(text) }) });
    } catch { /* read whole again next time */ }
  }

  /** The preview as a blob; a whole picture is made small first. */
  async function picture(p) {
    const blob = new Blob([p.bytes], { type: p.type });
    if (!p.whole) return blob;
    try {
      const bmp = await createImageBitmap(blob, { resizeWidth: 400, resizeQuality: 'medium' });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; // under transparent parts, as JPEG has none
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0);
      bmp.close();
      return await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    } catch {
      return null; // not a picture after all
    }
  }

  function addThumb(key, url) {
    thumbs.set(key, url);
    for (const [k, u] of thumbs) { // the oldest go
      if (thumbs.size <= MAX_THUMBS) break;
      if (u) URL.revokeObjectURL(u);
      thumbs.delete(k);
    }
  }

  /* ---------- actions ---------- */

  function openEntry(e) {
    if (e.dir) go(fullPath(e.name));
    else if (canView(e.name) || canPlay(e.name)) view(e);
    else if (canOpen(e.name)) openInWindows(e, folder);
    else toast('This kind of file isn’t opened from here. Save it to the PC first.');
  }

  async function openInWindows(e, at) {
    try {
      const r = await api(`/api/browse/${at.id}/open`, { method: 'POST', body: JSON.stringify({ name: e.name }) });
      if (r.task) addTask(r.task);
      else toast(`Opening ${e.name}`);
    } catch (err) {
      failed(err);
    }
  }

  /** A listing the server no longer has: read the folder again. */
  function failed(err) {
    toast(err.message, true);
    if (err.code === 'no-listing' || err.code === 'no-item') go(path, { step: false });
  }

  /** "2 folders, 3 pictures · 40 MB in 12 files"; folders are counted on the phone. */
  async function whatText(items, at) {
    const text = countText(items);
    if (!items.some((e) => e.dir)) return `${text} · ${formatBytes(items.reduce((s, e) => s + e.size, 0))}`;
    busy('Counting what is inside…');
    try {
      const m = await api(`/api/browse/${at.id}/measure`, { method: 'POST', body: JSON.stringify({ names: items.map((e) => e.name) }) });
      return `${text} · ${formatBytes(m.size)} in ${formatCount(m.files)} ${m.files === 1 ? 'file' : 'files'}${m.unread ? ` · ${formatCount(m.unread)} ${m.unread === 1 ? 'place' : 'places'} can’t be read` : ''}`;
    } finally {
      busy('');
    }
  }

  async function save(items, at) {
    if (!items.length) return;
    try {
      const what = await whatText(items, at);
      if (folder?.path !== at.path) return; // gone elsewhere while it was counted
      const one = items.length === 1;
      saveDialog({
        path: one ? fullPath(items[0].name) : at.path,
        what,
        name: one ? items[0].name : null,
        isDir: items[0].dir,
        start: (dest) => api(`/api/browse/${at.id}/pull`, { method: 'POST', body: JSON.stringify({ names: items.map((e) => e.name), dest }) }),
      });
    } catch (err) {
      failed(err);
    }
  }

  async function remove(items, at) {
    if (!items.length) return;
    try {
      const what = await whatText(items, at);
      if (folder?.path !== at.path) return;
      const one = items.length === 1;
      const dirs = items.filter((e) => e.dir).length;
      deleteDialog({
        title: one ? `Delete this ${items[0].dir ? 'folder' : 'file'} from the phone?` : `Delete these ${formatCount(items.length)} items from the phone?`,
        path: one ? fullPath(items[0].name) : at.path,
        what,
        warn: `A phone has no Recycle Bin: this can’t be undone.${dirs ? ` Everything in the ${dirs === 1 ? 'folder' : 'folders'} is deleted.` : ''}`,
        async run(close) {
          const r = await api(`/api/browse/${at.id}/delete`, { method: 'POST', body: JSON.stringify({ names: items.map((e) => e.name) }) });
          close();
          const gone = new Set(r.deleted);
          if (folder?.path === at.path) {
            folder.entries = folder.entries.filter((e) => !gone.has(e.name));
            for (const n of gone) sel.selected.delete(n);
            render();
            go(path, { step: false });
          } else at.entries = at.entries.filter((e) => !gone.has(e.name));
          if (r.error) toast(`${formatCount(r.left)} not deleted. ${r.error}`, true);
          else toast(`Deleted ${r.deleted.length === 1 ? r.deleted[0] : `${formatCount(r.deleted.length)} items`}`);
        },
      });
    } catch (err) {
      failed(err);
    }
  }

  function menuFor(ev, e) {
    if (!sel.selected.has(e.name)) choose(e.name, {});
    const items = picked();
    const at = folder;
    const one = items.length === 1;
    const actions = [];
    if (one && e.dir) actions.push({ label: 'Open', run: () => openEntry(e) });
    if (one && !e.dir && (canView(e.name) || canPlay(e.name))) actions.push({ label: canPlay(e.name) ? 'Play' : 'View', run: () => view(e) });
    if (one && !e.dir && canOpen(e.name)) actions.push({ label: 'Open in Windows', run: () => openInWindows(e, at) });
    actions.push({ label: 'Save to PC…', run: () => save(items, at) });
    if (one) actions.push({ label: 'Rename…', run: () => rename(e, at) });
    actions.push({ label: 'Delete from phone…', danger: true, run: () => remove(items, at) });
    showMenu(ev, one ? e.name : `${formatCount(items.length)} items`, one ? fullPath(e.name) : at.path, actions);
  }

  function choose(name, how) {
    sel = select({ names: shown.map((e) => e.name), selected: sel.selected, anchor: sel.anchor }, name, how);
    cursor = name;
    mark();
    renderCount();
  }

  function selectAll() {
    sel = { selected: new Set(shown.map((e) => e.name)), anchor: shown[0]?.name ?? null };
    mark();
    renderCount();
  }

  /** Asks for a name; `run(name)` does the work and throws what the dialog should say. */
  function askName({ title, where, value, run }) {
    const dlg = $('name-dialog');
    const input = $('name-input');
    $('name-title').textContent = title;
    $('name-where').textContent = where;
    $('name-error').hidden = true;
    $('name-ok').disabled = false;
    input.value = value;
    $('name-form').onsubmit = async (ev) => {
      if (ev.submitter?.value !== 'ok') return;
      ev.preventDefault();
      $('name-ok').disabled = true;
      try {
        await run(input.value.trim());
        dlg.close();
      } catch (err) {
        $('name-error').textContent = err.message;
        $('name-error').hidden = false;
        $('name-ok').disabled = false;
      }
    };
    dlg.showModal();
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length); // the name without its extension, as Explorer does
  }

  function rename(e, at) {
    if (at.stale) return toast('Still checking this folder on the phone; try again in a moment.', true);
    askName({
      title: `Rename this ${e.dir ? 'folder' : 'file'}`,
      where: `${at.path}/`,
      value: e.name,
      async run(to) {
        const r = await api(`/api/browse/${at.id}/rename`, { method: 'POST', body: JSON.stringify({ name: e.name, to }) });
        const x = at.entries.find((y) => y.name === e.name);
        if (x) x.name = r.name;
        if (at.media[e.name]) {
          at.media[r.name] = at.media[e.name];
          delete at.media[e.name];
        }
        if (folder !== at) return;
        sel = { selected: new Set([r.name]), anchor: r.name };
        cursor = r.name;
        render();
        reveal(r.name);
      },
    });
  }

  function newFolder() {
    const at = folder;
    if (!at) return;
    if (at.stale) return toast('Still checking this folder on the phone; try again in a moment.', true);
    const names = new Set(at.entries.map((e) => e.name.toLowerCase()));
    let name = 'New folder';
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `New folder (${n})`;
    askName({
      title: 'New folder',
      where: `${at.path}/`,
      value: name,
      async run(chosen) {
        const r = await api(`/api/browse/${at.id}/mkdir`, { method: 'POST', body: JSON.stringify({ name: chosen }) });
        at.entries.push(r.entry);
        if (folder !== at) return;
        sel = { selected: new Set([r.entry.name]), anchor: r.entry.name };
        cursor = r.entry.name;
        render();
        reveal(r.entry.name);
      },
    });
  }

  /** Everything inside what was dropped: [{ rel: [names], file }], folders walked through. */
  async function dropped(dt) {
    const out = [];
    const walk = async (entry, rel) => {
      if (entry.isFile) {
        const file = await new Promise((ok, no) => entry.file(ok, no));
        out.push({ rel: [...rel, entry.name], file });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) { // readEntries gives up to 100 at a time
          const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
          if (!batch.length) break;
          for (const x of batch) await walk(x, [...rel, entry.name]);
        }
      }
    };
    const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry()).filter(Boolean);
    for (const e of entries) await walk(e, []);
    return out;
  }

  /** Copies files from this PC into the folder open now: the server says where each goes, then gets them one by one. */
  async function upload(list) {
    const at = folder;
    if (!at || !list.length) return;
    if (at.stale) return toast('Still checking this folder on the phone; try again in a moment.', true);
    busy('Getting ready to copy…');
    let r;
    try {
      r = await api(`/api/browse/${at.id}/push`, { method: 'POST', body: JSON.stringify({ items: list.map((x) => ({ rel: x.rel, size: x.file.size, mtime: Math.floor(x.file.lastModified / 1000) })) }) });
    } catch (err) {
      busy('');
      return failed(err);
    } finally {
      busy('');
    }
    addTask(r.task);
    for (const f of r.files) {
      const res = await fetch(`/api/push/${r.task.id}/${f.i}`, { method: 'PUT', body: f.skip ? '' : list[f.i].file }).catch(() => null);
      if (!res?.ok) break; // cancelled, or the copy failed: the task says why
    }
    await fetch(`/api/push/${r.task.id}/end`, { method: 'POST' }).catch(() => {});
    for (;;) { // read the folder again when the copy is over, if it is still open
      const t = (await api('/api/tasks').catch(() => ({ tasks: [] }))).tasks.find((x) => x.id === r.task.id);
      if (!t || t.state !== 'running') break;
      await new Promise((ok) => setTimeout(ok, 800));
    }
    if (folder?.path === r.path && device) go(path, { step: false });
  }

  /* ---------- pointer and keys ---------- */

  const cellAt = (ev) => {
    const name = ev.target.closest?.('.b-cell')?.dataset.name;
    return name == null ? null : shown.find((e) => e.name === name) ?? null;
  };
  scroll.addEventListener('click', (ev) => {
    const e = cellAt(ev);
    if (e) choose(e.name, { ctrl: ev.ctrlKey, shift: ev.shiftKey });
    else if (!ev.ctrlKey) {
      sel = { selected: new Set(), anchor: null };
      mark();
      renderCount();
    }
  });
  scroll.addEventListener('dblclick', (ev) => {
    const e = cellAt(ev);
    if (e && !ev.ctrlKey && !ev.shiftKey) openEntry(e);
  });
  scroll.addEventListener('contextmenu', (ev) => {
    const e = cellAt(ev);
    if (e) menuFor(ev, e);
    else if (folder) {
      showMenu(ev, crumbsOf(path).at(-1)[0], path, [
        { label: 'New folder…', run: newFolder }, { label: 'Copy files from PC…', run: () => $('b-files').click() }, { label: 'Copy a folder from PC…', run: () => $('b-folder').click() },
        { label: 'Reload', run: () => go(path, { step: false }) }, { label: 'Select all', run: selectAll },
      ]);
    }
  });
  scroll.addEventListener('dragstart', (ev) => {
    const e = cellAt(ev);
    if (!e || e.dir) {
      ev.preventDefault();
      return;
    }
    const url = `${location.origin}/api/browse/${folder.id}/file?download=1&name=${encodeURIComponent(e.name)}`;
    ev.dataTransfer.effectAllowed = 'copy';
    ev.dataTransfer.setData('DownloadURL', `application/octet-stream:${dragName(e.name)}:${url}`);
    ev.dataTransfer.setData('text/plain', fullPath(e.name));
  });
  let frame = 0;
  scroll.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });
  new ResizeObserver(() => { if (!$('browse').hidden) draw(); }).observe(scroll);

  let typed = '';
  let typedAt = 0;
  scroll.addEventListener('keydown', (ev) => {
    if (!folder || ev.altKey) return;
    const w = layout();
    const at = shown.findIndex((e) => e.name === cursor);
    const page = Math.max(1, Math.floor(scroll.clientHeight / VIEWS[set.view].h)) * w.cols;
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: w.cols, ArrowUp: -w.cols, PageDown: page, PageUp: -page };
    const move = (i) => {
      const e = shown[Math.max(0, Math.min(shown.length - 1, i))];
      if (!e) return;
      choose(e.name, { shift: ev.shiftKey });
      reveal(e.name);
    };
    if (ev.ctrlKey) {
      if (ev.key.toLowerCase() !== 'a') return;
      selectAll();
    } else if (moves[ev.key]) {
      const to = at + moves[ev.key];
      const sideways = ev.key.startsWith('Arrow') && (to < 0 || to >= shown.length);
      move(at < 0 ? 0 : sideways ? at : to); // an arrow past the first or last row stays where it is
    } else if (ev.key === 'Home') move(0);
    else if (ev.key === 'End') move(shown.length - 1);
    else if (ev.key === 'Enter') {
      if (shown[at]) openEntry(shown[at]);
    } else if (ev.key === 'Backspace') up();
    else if (ev.key === 'Delete') remove(picked(), folder);
    else if (ev.key === 'F2') {
      const items = picked();
      if (items.length === 1) rename(items[0], folder);
    }
    else if (ev.key.length === 1 && ev.key !== ' ') { // jump to the name typed
      if (Date.now() - typedAt > 900) typed = '';
      typedAt = Date.now();
      typed += ev.key.toLowerCase();
      const hit = shown.find((e) => e.name.toLowerCase().startsWith(typed));
      if (hit) {
        choose(hit.name, {});
        reveal(hit.name);
      }
    } else return;
    ev.preventDefault();
  });
  const idle = () => $('browse').hidden || document.querySelector('dialog[open]');
  document.addEventListener('keydown', (ev) => {
    if (idle() || !ev.altKey) return;
    if (ev.key === 'ArrowLeft') step(back, forward);
    else if (ev.key === 'ArrowRight') step(forward, back);
    else if (ev.key === 'ArrowUp') up();
    else return;
    ev.preventDefault();
  });
  document.addEventListener('mouseup', (ev) => { // a mouse's side buttons
    if (idle() || (ev.button !== 3 && ev.button !== 4)) return;
    ev.preventDefault();
    if (ev.button === 3) step(back, forward);
    else step(forward, back);
  });
  $('b-new').addEventListener('click', newFolder);
  $('b-upload').addEventListener('click', (ev) => {
    if (!folder) return;
    showMenu(ev, 'Copy into', path, [{ label: 'Files…', run: () => $('b-files').click() }, { label: 'A folder…', run: () => $('b-folder').click() }]);
  });
  $('b-files').addEventListener('change', (ev) => {
    upload([...ev.target.files].map((file) => ({ rel: [file.name], file })));
    ev.target.value = '';
  });
  $('b-folder').addEventListener('change', (ev) => {
    upload([...ev.target.files].map((file) => ({ rel: file.webkitRelativePath.split('/').filter(Boolean), file })));
    ev.target.value = '';
  });
  // Files dragged in from Explorer (not this list's own tiles, which carry no files).
  const fromOutside = (ev) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
  let dragDepth = 0;
  const list = scroll.parentElement;
  list.addEventListener('dragenter', (ev) => {
    if (!fromOutside(ev) || !folder) return;
    dragDepth++;
    $('b-drop-to').textContent = crumbsOf(path).at(-1)[0];
    $('b-drop').hidden = false;
  });
  list.addEventListener('dragover', (ev) => {
    if (!fromOutside(ev) || !folder) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  list.addEventListener('dragleave', (ev) => {
    if (!fromOutside(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('b-drop').hidden = true;
  });
  list.addEventListener('drop', async (ev) => {
    if (!fromOutside(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    $('b-drop').hidden = true;
    try {
      upload(await dropped(ev.dataTransfer));
    } catch (err) {
      toast(`Couldn’t read what was dropped: ${err.message}`, true);
    }
  });
  $('b-back').addEventListener('click', () => step(back, forward));
  $('b-forward').addEventListener('click', () => step(forward, back));
  $('b-up').addEventListener('click', up);
  $('b-reload').addEventListener('click', () => {
    for (const [k, u] of thumbs) if (!u) thumbs.delete(k); // try again for those that had none
    go(path, { step: false });
  });
  $('b-filter').addEventListener('input', () => {
    render();
    scroll.scrollTop = 0;
  });
  $('b-sort').addEventListener('change', (ev) => {
    set.sort = '';
    sortBy(ev.target.value);
  });
  $('b-way').addEventListener('click', () => sortBy(set.sort));
  $('b-kind').addEventListener('change', (ev) => {
    kind = ev.target.value;
    render();
    scroll.scrollTop = 0;
  });
  $('b-hidden').checked = set.hidden;
  $('b-hidden').addEventListener('change', (ev) => {
    set.hidden = ev.target.checked;
    keep();
    render();
  });
  for (const b of document.querySelectorAll('.b-views button')) {
    b.addEventListener('click', () => {
      set.view = b.dataset.view;
      keep();
      render();
      if (cursor) reveal(cursor);
    });
  }

  /* ---------- the picture viewer ---------- */

  const dlg = $('viewer');
  const img = $('v-img');
  const vid = $('v-video');
  const fulls = new Map(); // file address -> { promise of a blob address, stop }
  let seen = []; // the pictures that can be gone through
  let pos = 0;
  let home = null; // the folder they are in
  let zoom = { s: 1, x: 0, y: 0 };

  const address = (e) => `/api/browse/${home.id}/file?name=${encodeURIComponent(e.name)}&v=${e.size}-${e.mtime}`;

  function view(e) {
    home = folder;
    seen = shown.filter((x) => !x.dir && (canView(x.name) || canPlay(x.name)));
    pos = Math.max(0, seen.findIndex((x) => x.name === e.name));
    if (!dlg.open) dlg.showModal();
    show();
  }

  function load(e) {
    const url = address(e);
    if (!fulls.has(url)) {
      const stop = new AbortController();
      const promise = fetch(url, { signal: stop.signal }).then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'The phone would not send this picture.');
        return URL.createObjectURL(await res.blob());
      });
      promise.catch(() => fulls.delete(url));
      fulls.set(url, { promise, stop });
    }
    return fulls.get(url).promise;
  }

  function drop(url, f) {
    f.stop.abort();
    f.promise.then((u) => URL.revokeObjectURL(u), () => {});
    fulls.delete(url);
  }

  function stopVideo() {
    vid.pause();
    vid.removeAttribute('src');
    vid.removeAttribute('poster');
    vid.load(); // ends its requests to the phone
    vid.hidden = true;
  }

  /** Keeps the pictures around the one shown. */
  function trim() {
    const near = new Set([-1, 0, 1].map((d) => seen[pos + d]).filter((x) => x && canView(x.name)).map(address));
    for (const [url, f] of [...fulls]) if (!near.has(url) && fulls.size > MAX_FULL) drop(url, f);
  }

  async function show() {
    const e = seen[pos];
    const small = thumbs.get(thumbKey(e, home));
    const info = (w, hgt) => { $('v-info').textContent = [`${formatCount(pos + 1)} of ${formatCount(seen.length)}`, w ? `${w} × ${hgt}` : '', formatBytes(e.size), formatWhen(e.mtime)].filter(Boolean).join(' · '); };
    $('v-name').textContent = e.name;
    info(...(home.media[e.name] ?? []));
    $('v-prev').disabled = pos === 0;
    $('v-next').disabled = pos === seen.length - 1;
    $('v-error').hidden = true;
    $('v-zoom').hidden = canPlay(e.name);
    if (canPlay(e.name)) { // played as it arrives, by ranges: no waiting for the whole file
      img.hidden = true;
      img.removeAttribute('src');
      fit();
      vid.hidden = false;
      if (small) vid.poster = small;
      else vid.removeAttribute('poster');
      vid.src = address(e);
      vid.dataset.name = e.name;
      vid.play().catch(() => {}); // refused only without a click first; the controls are there
      vid.focus();
      return;
    }
    if (!vid.hidden) stopVideo();
    img.hidden = !small;
    img.className = 'soft';
    if (small) img.src = small;
    else img.removeAttribute('src');
    fit();
    try {
      const url = await load(e);
      const ready = new Image();
      ready.src = url;
      await ready.decode();
      if (seen[pos] !== e || !dlg.open) return;
      img.src = url;
      img.hidden = false;
      img.className = '';
      info(ready.naturalWidth, ready.naturalHeight);
      fit();
      for (const d of [1, -1]) if (seen[pos + d] && canView(seen[pos + d].name)) load(seen[pos + d]).catch(() => {});
      trim();
    } catch (err) {
      if (seen[pos] !== e || !dlg.open || err.name === 'AbortError') return;
      $('v-error').hidden = false;
      $('v-error').textContent = err.name === 'EncodingError' ? 'This picture can’t be shown here. Try “Open in Windows”.' : /fetch|network/i.test(err.message) ? 'The phone stopped sending. Check the cable and try again.' : err.message;
    }
  }

  function turnTo(d) {
    const n = pos + d;
    if (n < 0 || n >= seen.length) return;
    pos = n;
    choose(seen[pos].name, {}); // the list behind follows
    reveal(seen[pos].name);
    show();
  }

  /** How much smaller than its pixels the picture is when all of it is shown. */
  const fitScale = () => {
    const st = $('v-stage');
    return Math.min(1, st.clientWidth / (img.naturalWidth || 1), st.clientHeight / (img.naturalHeight || 1));
  };
  function place() {
    img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    $('v-stage').classList.toggle('zoomed', zoom.s > 1);
    $('v-zoom').textContent = zoom.s > 1 ? 'Fit' : '100%';
  }
  function fit() {
    zoom = { s: 1, x: 0, y: 0 };
    place();
  }
  function zoomAt(s, cx, cy) {
    const r = $('v-stage').getBoundingClientRect();
    const next = Math.max(1, Math.min(Math.max(8, 4 / fitScale()), s));
    const px = cx - r.left - r.width / 2;
    const py = cy - r.top - r.height / 2;
    const k = next / zoom.s;
    zoom = next === 1 ? { s: 1, x: 0, y: 0 } : { s: next, x: px - (px - zoom.x) * k, y: py - (py - zoom.y) * k };
    place();
  }
  const middle = () => {
    const r = $('v-stage').getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  const toggleZoom = (cx, cy) => (zoom.s > 1 ? fit() : zoomAt(Math.max(1.5, 1 / fitScale()), cx, cy));

  vid.addEventListener('loadedmetadata', () => {
    const e = seen[pos];
    if (!e || vid.dataset.name !== e.name) return;
    $('v-info').textContent = [`${formatCount(pos + 1)} of ${formatCount(seen.length)}`, `${vid.videoWidth} × ${vid.videoHeight}`, formatLength(vid.duration * 1000), formatBytes(e.size), formatWhen(e.mtime)].filter(Boolean).join(' · ');
  });
  vid.addEventListener('error', () => {
    if (vid.hidden || !vid.getAttribute('src')) return;
    $('v-error').hidden = false;
    $('v-error').textContent = vid.error?.code === 4 ? 'This video can’t be played here (its format isn’t supported by this window). Try “Open in Windows”.' : 'The phone stopped sending this video. Check the cable and try again.';
  });

  $('v-stage').addEventListener('wheel', (ev) => {
    if (!vid.hidden) return;
    ev.preventDefault();
    zoomAt(zoom.s * (ev.deltaY < 0 ? 1.2 : 1 / 1.2), ev.clientX, ev.clientY);
  }, { passive: false });
  img.addEventListener('dblclick', (ev) => toggleZoom(ev.clientX, ev.clientY));
  $('v-stage').addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('button') || !vid.hidden || zoom.s <= 1 || ev.button !== 0) return;
    const from = { x: ev.clientX - zoom.x, y: ev.clientY - zoom.y };
    const st = $('v-stage');
    st.setPointerCapture(ev.pointerId);
    const onMove = (m) => {
      zoom = { ...zoom, x: m.clientX - from.x, y: m.clientY - from.y };
      place();
    };
    const end = () => {
      st.removeEventListener('pointermove', onMove);
      st.removeEventListener('pointerup', end);
      st.removeEventListener('pointercancel', end);
    };
    st.addEventListener('pointermove', onMove);
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
  });
  $('v-prev').addEventListener('click', () => turnTo(-1));
  $('v-next').addEventListener('click', () => turnTo(1));
  $('v-zoom').addEventListener('click', () => toggleZoom(...middle()));
  $('v-open').addEventListener('click', () => openInWindows(seen[pos], home));
  $('v-save').addEventListener('click', () => save([seen[pos]], home));
  $('v-close').addEventListener('click', () => dlg.close());
  // Caught before the video's own controls, so the arrows always go to the next or previous item.
  dlg.addEventListener('keydown', (ev) => {
    const playing = !vid.hidden;
    if (playing && ev.shiftKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) vid.currentTime = Math.max(0, vid.currentTime + (ev.key === 'ArrowRight' ? 5 : -5));
    else if (ev.key === 'ArrowRight') turnTo(1);
    else if (ev.key === 'ArrowLeft') turnTo(-1);
    else if (ev.key === ' ' && playing && !ev.target.closest('button')) {
      if (vid.paused) vid.play().catch(() => {});
      else vid.pause();
    } else if (ev.key === ' ' && !ev.target.closest('button')) toggleZoom(...middle());
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  }, true);
  dlg.addEventListener('keydown', (ev) => {
    if (!vid.hidden) return;
    if (ev.key === '+' || ev.key === '=') zoomAt(zoom.s * 1.25, ...middle());
    else if (ev.key === '-') zoomAt(zoom.s / 1.25, ...middle());
    else return;
    ev.preventDefault();
  });
  dlg.addEventListener('close', () => {
    stopVideo();
    for (const [url, f] of [...fulls]) drop(url, f);
    img.removeAttribute('src');
    scroll.focus();
  });

  renderPath();
  return { setDevice };
}
