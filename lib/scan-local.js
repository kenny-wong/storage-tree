// Scanning a folder on this PC: many folders read at once, every file's size
// from lstat. Links and junctions are not followed (so nothing is counted
// twice and a scan can't loop).

import { readdir, lstat, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fills `tree` with everything below `root`. onError(path, code) is called for
 * folders or files that can't be read; isCancelled() stops the scan early.
 */
export async function scanLocal({ root, tree, onError = () => {}, isCancelled = () => false, concurrency = 24 }) {
  const queue = [{ abs: root, segs: [] }];
  let active = 0;

  async function visit({ abs, segs }) {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      onError(abs, err.code ?? err.message);
      return;
    }
    tree.addDir(segs);
    const files = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) queue.push({ abs: join(abs, e.name), segs: [...segs, e.name] });
      else if (e.isFile()) files.push(e.name);
    }
    // In slices, so a folder with 100,000 files doesn't start 100,000 lstat calls at once.
    for (let i = 0; i < files.length && !isCancelled(); i += 256) {
      await Promise.all(files.slice(i, i + 256).map(async (name) => {
        const p = join(abs, name);
        try {
          const s = await lstat(p);
          tree.addFile([...segs, name], s.size, Math.floor(s.mtimeMs / 1000));
        } catch (err) {
          onError(p, err.code ?? err.message);
        }
      }));
    }
  }

  await new Promise((resolve, reject) => {
    const pump = () => {
      if (isCancelled()) queue.length = 0;
      while (active < concurrency && queue.length) {
        const job = queue.pop();
        active++;
        visit(job).then(() => {
          active--;
          if (!queue.length && !active) resolve();
          else pump();
        }, reject);
      }
      if (!queue.length && !active) resolve();
    };
    pump();
  });
}

/** This PC's drives (C:\, D:\, …) with their size and free space. */
export async function listDrives() {
  if (process.platform !== 'win32') return [{ path: '/', ...(await space('/')) }];
  const out = [];
  for (let c = 67; c <= 90; c++) { // C to Z (A and B are floppy letters)
    const path = `${String.fromCharCode(c)}:\\`;
    if (!existsSync(path)) continue;
    out.push({ path, ...(await space(path)) });
  }
  return out;
}

async function space(path) {
  try {
    const s = await statfs(path);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: null, free: null };
  }
}
