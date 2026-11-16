// The folder tree a scan builds: entries are added as they are found (in any
// order). Every folder's size, file count, folder count and newest change are
// kept up to date as entries come in, so a scan can be shown while it runs;
// finish() adds everything up again from the bottom (after deletes and late
// additions it is the reference).
// Folders get ids (their index in `dirs`), so the page can ask for one
// folder's contents at a time instead of the whole tree.

/** The lower-case extension of a file name ("photo.JPG" -> "jpg"), or '' when it has none. */
export function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function createTree(rootLabel, sep = '/') {
  const dirs = [];
  const mk = (name, parent) => {
    const d = { id: dirs.length, name, parent, sub: new Map(), files: [], size: 0, count: 0, dirCount: 0, mtime: 0 };
    dirs.push(d);
    for (let p = parent; p; p = p.parent) p.dirCount++;
    return d;
  };
  const root = mk(rootLabel, null);
  let entries = 0;
  let finished = false;

  function dirAt(segments) {
    let d = root;
    for (const s of segments) {
      let n = d.sub.get(s);
      if (!n) {
        n = mk(s, d);
        d.sub.set(s, n);
      }
      d = n;
    }
    return d;
  }

  return {
    root,
    dirs,
    sep,
    get entries() { return entries; },
    get finished() { return finished; },

    /** A file at `segments` (path parts below the root), with its size in bytes and modified time in seconds. */
    addFile(segments, size, mtime = 0) {
      if (!segments.length) return;
      const d = dirAt(segments.slice(0, -1));
      const f = { name: segments[segments.length - 1], size: Number(size) || 0, mtime: Number(mtime) || 0 };
      d.files.push(f);
      for (let n = d; n; n = n.parent) { // live totals
        n.size += f.size;
        n.count++;
        if (f.mtime > n.mtime) n.mtime = f.mtime;
      }
      entries++;
    },

    /** A folder (so empty folders show too). The root is []. */
    addDir(segments) {
      dirAt(segments);
      entries++;
    },

    /** Marks a folder as read with administrator rights (this account can't change it). */
    markLocked(segments) {
      dirAt(segments).locked = true;
    },

    /** Adds up every folder's size, file count, folder count and newest change. */
    finish() {
      for (const d of dirs) {
        d.size = 0;
        d.count = 0;
        d.dirCount = 0;
        d.mtime = 0;
      }
      // A folder is always made after its parent, so going backwards visits children first.
      for (let i = dirs.length - 1; i >= 0; i--) {
        const d = dirs[i];
        for (const f of d.files) {
          d.size += f.size;
          if (f.mtime > d.mtime) d.mtime = f.mtime;
        }
        d.count += d.files.length;
        const p = d.parent;
        if (p && p.sub.get(d.name) === d) { // a deleted folder no longer counts
          p.size += d.size;
          p.count += d.count;
          p.dirCount += d.dirCount + 1;
          if (d.mtime > p.mtime) p.mtime = d.mtime;
        }
      }
      finished = true;
    },

    /** Takes a deleted file out of its folder and its size and count out of every folder above. Returns the file or null. */
    removeFile(d, name) {
      const i = d.files.findIndex((f) => f.name === name);
      if (i < 0) return null;
      const [f] = d.files.splice(i, 1);
      for (let n = d; n; n = n.parent) {
        n.size -= f.size;
        n.count -= 1;
      }
      return f;
    },

    /** Takes a deleted folder (not the root) out of the tree. Its id stays taken, but alive() is false for it and everything in it. */
    removeDir(d) {
      const p = d.parent;
      if (!p || p.sub.get(d.name) !== d) return false;
      p.sub.delete(d.name);
      for (let n = p; n; n = n.parent) {
        n.size -= d.size;
        n.count -= d.count;
        n.dirCount -= d.dirCount + 1;
      }
      return true;
    },

    /** False for a folder that was deleted, or is inside one. */
    alive(d) {
      for (let n = d; n.parent; n = n.parent) if (n.parent.sub.get(n.name) !== n) return false;
      return true;
    },

    /** The full path of a folder (the root label joined with the names below it), plus a file name if given. */
    pathOf(d, fileName) {
      const parts = [];
      for (let n = d; n.parent; n = n.parent) parts.push(n.name);
      parts.reverse();
      if (fileName != null) parts.push(fileName);
      if (!parts.length) return root.name;
      return root.name.endsWith(sep) ? root.name + parts.join(sep) : root.name + sep + parts.join(sep);
    },
  };
}

const dirInfo = (d) => ({ kind: 'dir', id: d.id, name: d.name, size: d.size, count: d.count, dirCount: d.dirCount, mtime: d.mtime, empty: !d.sub.size && !d.files.length, ...(d.locked ? { locked: true } : {}) });
const fileInfo = (f) => ({ kind: 'file', name: f.name, size: f.size, mtime: f.mtime, ext: extOf(f.name) });

/**
 * One row for the items past the limit: how many files and folders, their
 * size, and the extension holding most of their bytes (so the treemap can
 * colour the box by what is in it), '' when that is folders or no extension.
 */
function moreRow(rest) {
  const bytes = new Map();
  let files = 0;
  let dirBytes = 0;
  for (const x of rest) {
    if (x.kind === 'file') {
      files++;
      bytes.set(x.ext, (bytes.get(x.ext) ?? 0) + x.size);
    } else dirBytes += x.size;
  }
  let ext = '';
  let best = dirBytes;
  for (const [e, b] of bytes) if (b > best) { best = b; ext = e; }
  const dirs = rest.length - files;
  const n = rest.length.toLocaleString('en-GB');
  const name = dirs === 0 ? `${n} smaller files` : files === 0 ? `${n} smaller folders` : `${n} smaller items`;
  return { kind: 'more', name, count: rest.length, files, dirs, size: rest.reduce((s, x) => s + x.size, 0), ext };
}

/**
 * A folder's contents, biggest first: folders and files together, at most
 * `limit`, with one `more` row for the rest. depth > 1 also fills in
 * `children` of the sub-folders (for the treemap), `sublimit` each.
 */
export function childrenOf(d, { limit = 1000, depth = 1, sublimit = 60 } = {}) {
  const all = [...[...d.sub.values()].map(dirInfo), ...d.files.map(fileInfo)];
  all.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const shown = all.slice(0, limit);
  if (all.length > limit) {
    const rest = all.slice(limit);
    shown.push(moreRow(rest));
  }
  if (depth > 1) {
    for (const c of shown) {
      if (c.kind === 'dir') c.children = childrenOf(d.sub.get(c.name), { limit: sublimit, depth: depth - 1, sublimit: Math.max(8, sublimit >> 2) });
    }
  }
  return shown;
}

/** The `n` biggest files below a folder, biggest first, each with its folder id. */
export function largestFiles(tree, n = 200, under = tree.root) {
  const heap = []; // min-heap of [size, dir, file]
  const swap = (i, j) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      swap(i, p);
      i = p;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
      if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
      if (m === i) return;
      swap(i, m);
      i = m;
    }
  };
  const stack = [under];
  while (stack.length) {
    const d = stack.pop();
    for (const f of d.files) {
      if (heap.length < n) {
        heap.push([f.size, d, f]);
        up(heap.length - 1);
      } else if (n > 0 && f.size > heap[0][0]) {
        heap[0] = [f.size, d, f];
        down(0);
      }
    }
    for (const s of d.sub.values()) stack.push(s);
  }
  return heap
    .sort((a, b) => b[0] - a[0])
    .map(([, d, f]) => ({ ...fileInfo(f), dirId: d.id, path: tree.pathOf(d, f.name) }));
}

/** Space by file extension below a folder, biggest first. */
export function fileTypes(tree, under = tree.root) {
  const by = new Map();
  const stack = [under];
  while (stack.length) {
    const d = stack.pop();
    for (const f of d.files) {
      const ext = extOf(f.name);
      const t = by.get(ext) ?? { ext, size: 0, count: 0 };
      t.size += f.size;
      t.count++;
      by.set(ext, t);
    }
    for (const s of d.sub.values()) stack.push(s);
  }
  return [...by.values()].sort((a, b) => b.size - a.size || b.count - a.count);
}

/** The folders from the root down to `d`, for breadcrumbs. */
export function crumbs(d) {
  const out = [];
  for (let n = d; n; n = n.parent) out.push({ id: n.id, name: n.name });
  return out.reverse();
}
