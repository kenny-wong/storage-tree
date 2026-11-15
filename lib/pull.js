// Copying files and folders from a phone to this PC. The scan already knows
// every file and its size, so a copy is a list of single-file transfers
// (`adb exec-out cat`), a few at a time, with exact progress. Each file is
// written as "<name>.part" and renamed when complete, so a cancelled or failed
// copy leaves no half files. Files already there with the same size are
// skipped (so a copy can be run again to finish it); a different file of the
// same name is kept and the new one saved as "name (2).ext".

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { shQuote } from './adb.js';

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** A phone file or folder name made safe for Windows: no <>:"/\|?* or control characters, no trailing dot or space, no device names. */
export function safeName(name) {
  let t = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  if (RESERVED.test(t)) t = `_${t}`;
  return t || '_';
}

/** The last part of a phone path ("/storage/emulated/0" -> "0"). */
const baseName = (name) => name.split('/').filter(Boolean).pop() ?? 'phone';

/**
 * What copying folder `d` (or its file `fileName`) involves:
 * { name, isFile, dirs: [relative path parts], files: [{ remote, rel, size, mtime }], totalBytes }.
 */
export function pullPlan(tree, d, fileName = null) {
  if (fileName != null) {
    const f = d.files.find((x) => x.name === fileName);
    if (!f) return null;
    const name = safeName(f.name);
    return { name, isFile: true, dirs: [], files: [{ remote: tree.pathOf(d, f.name), rel: [name], size: f.size, mtime: f.mtime }], totalBytes: f.size };
  }
  const name = safeName(d.parent ? d.name : baseName(d.name));
  const dirs = [];
  const files = [];
  const stack = [[d, []]];
  while (stack.length) {
    const [n, rel] = stack.pop();
    dirs.push(rel);
    for (const f of n.files) files.push({ remote: tree.pathOf(n, f.name), rel: [...rel, safeName(f.name)], size: f.size, mtime: f.mtime });
    for (const s of n.sub.values()) stack.push([s, [...rel, safeName(s.name)]]);
  }
  return { name, isFile: false, dirs, files, totalBytes: files.reduce((s, f) => s + f.size, 0) };
}

/** Where to save a file: `path` itself, null when the same-size file is already there (skip), or "name (2).ext" and so on. */
export async function targetFor(path, size, statFn = stat) {
  const sizeAt = async (p) => {
    try {
      return (await statFn(p)).size;
    } catch {
      return null;
    }
  };
  const have = await sizeAt(path);
  if (have == null) return path;
  if (have === size) return null;
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  for (let i = 2; i < 1000; i++) {
    const p = `${stem} (${i})${ext}`;
    const s = await sizeAt(p);
    if (s == null) return p;
    if (s === size) return null;
  }
  throw new Error(`Too many copies of ${path} already`);
}

/** Streams one phone file into `target` through "<target>.part". Resolves with the bytes received. */
export function copyOne({ adb, serial, remote, target, size, mtime, task, spawnAdb = spawn }) {
  const part = `${target}.part`;
  return new Promise((resolve, reject) => {
    // exec-out passes bytes through untouched; stderr would be mixed into them, so it goes to /dev/null and the size is checked instead.
    const child = spawnAdb(adb, ['-s', serial, 'exec-out', `cat ${shQuote(remote)} 2>/dev/null`], { windowsHide: true });
    const off = task.onCancel(() => child.kill());
    const out = createWriteStream(part);
    let got = 0;
    let failed = null;
    let pending = 2; // the process closing and the file being written
    const finish = async () => {
      if (--pending) return;
      off();
      if (failed || task.cancelled || got !== size) {
        await unlink(part).catch(() => {});
        if (task.cancelled) return resolve(got);
        task.bytes -= got; // the caller counts the whole file as handled
        return reject(failed ?? new Error(got === 0 && size > 0 ? 'The phone would not send this file' : `Got ${got} of ${size} bytes; it may have changed since the scan`));
      }
      try {
        await rename(part, target);
        if (mtime > 0) await utimes(target, mtime, mtime).catch(() => {});
        resolve(got);
      } catch (err) {
        await unlink(part).catch(() => {});
        task.bytes -= got;
        reject(err);
      }
    };
    child.stdout.on('data', (chunk) => {
      got += chunk.length;
      task.bytes += chunk.length;
    });
    child.stdout.pipe(out);
    child.stderr?.resume();
    out.on('error', (err) => { failed ??= err; child.kill(); });
    out.on('close', finish);
    child.on('error', (err) => { failed ??= err; out.end(); });
    child.on('close', finish);
  });
}

/** Copies everything in `plan` into the folder `dest`, `lanes` files at a time, updating `task`. */
export async function pullToPc({ adb, serial, plan, dest, task, lanes = 3, spawnAdb = spawn, statFn = stat }) {
  const top = plan.isFile ? dest : join(dest, plan.name);
  task.totalFiles = plan.files.length;
  task.totalBytes = plan.totalBytes;
  await mkdir(dest, { recursive: true });
  for (const rel of plan.dirs) {
    if (task.cancelled) return;
    await mkdir(join(top, ...rel), { recursive: true });
  }
  let next = 0;
  const worker = async () => {
    while (!task.cancelled && next < plan.files.length) {
      const f = plan.files[next++];
      task.current = f.remote;
      const path = join(top, ...f.rel);
      try {
        const target = await targetFor(path, f.size, statFn);
        if (target == null) {
          task.skipped++;
          task.bytes += f.size;
        } else {
          await copyOne({ adb, serial, remote: f.remote, target, size: f.size, mtime: f.mtime, task, spawnAdb });
        }
        if (!task.cancelled) task.files++;
      } catch (err) {
        task.addError(f.remote, err.message);
        task.bytes += f.size; // so the bar still reaches the end
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, lanes) }, worker));
  return top;
}
