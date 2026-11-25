// Copying files and folders from a phone to this PC. The scan already knows
// every file and its size, so a copy is a list of single-file transfers
// (`adb pull`, about 7 times faster than `adb exec-out cat` over USB), a few
// at a time, with progress read from the growing file. Each file is written
// as "storagetree-<hex>.part" beside its target and renamed when complete, so
// a cancelled or failed copy leaves no half files. Files already there with
// the same size are skipped (so a copy can be run again to finish it); a
// different file of the same name is kept and the new one saved as
// "name (2).ext". A name is held while a copy decides about it and writes
// it, so two phone files that become one PC name never share a file.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, toNamespacedPath } from 'node:path';

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

/** One spelling per PC path, for comparing: "C:\a\X" and "\\?\c:\a\x" are the same file. */
export const pathKey = (p) => toNamespacedPath(p).toLowerCase();

/**
 * The name a file has while it is being copied: "storagetree-<12 hex>.part"
 * in the target's folder, the hex taken from the target's name. No phone file
 * has such a name, so a copy saved earlier is never emptied by a later one
 * (a phone can hold "x" and "x.part" side by side); it is the same every
 * time, so a leftover of a copy that was cut off is replaced by the next; and
 * it is short, so a 250-character file name still fits Windows' 255.
 */
export function partOf(target) {
  const hex = createHash('sha256').update(basename(target).toLowerCase()).digest('hex').slice(0, 12);
  return join(dirname(target), `storagetree-${hex}.part`);
}

/** adb.exe can't open paths of about 260 characters or more unless they have Windows' \\?\ prefix. */
export const adbPath = (p) => (p.length >= 248 ? toNamespacedPath(p) : p);

/** What adb said went wrong: its last "adb: …" line (its summary line is on stderr too), in plain words. */
export function pullError(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = (lines.findLast((l) => /^adb:/i.test(l)) ?? lines.at(-1) ?? '').replace(/^adb:\s*(error:\s*)?/i, '');
  if (/^target .* is not a directory$/i.test(line)) return 'This is a folder on the phone now, not a file';
  return line || 'The phone would not send this file';
}

// PC paths (pathKey) that a copy is deciding about or writing right now, each
// with two promises: `decided` settles when its look at the disk is over,
// `done` when it lets go. Shared by every task in this process; not by a
// second running copy of the app.
const held = new Map();

/** How many names are held right now (for tests). */
export const heldNames = () => held.size;

/**
 * Picks where to save a file and holds that name: { target, release }.
 * `target` is `path` itself, "name (2).ext" and so on when a different file
 * has the name, or null when the same-size file is already there (skip).
 * `used` holds the names this task has already given out: one of its files
 * never takes another's name, even at the same size. A name somebody else
 * holds is waited for and then looked at afresh, so "already there" always
 * means a finished file. Call `release()` when the copy has ended.
 */
export async function claimTarget(path, size, statFn = stat, used = new Set()) {
  // null = nothing there, -1 = a folder (never "the same file"), otherwise the size
  const sizeAt = async (p) => {
    try {
      const s = await statFn(p);
      return s.isDirectory?.() ? -1 : s.size;
    } catch {
      return null;
    }
  };
  // A claim, or undefined when this name belongs to a different file.
  const tryAt = async (p) => {
    const k = pathKey(p);
    for (;;) {
      if (used.has(k)) return undefined;
      const busy = held.get(k);
      if (!busy) break;
      await busy.decided; // somebody is looking at this name
      if (used.has(k)) return undefined; // a file of this same task took it: no need to wait for its copy
      await busy.done; // somebody else is saving to it: see what they leave
    }
    // The hold is taken before the disk is looked at (no await in between), so
    // an old answer from the disk is never acted on after another copy saved here.
    let decide;
    let release;
    held.set(k, {
      decided: new Promise((r) => { decide = r; }),
      done: new Promise((r) => { release = () => { held.delete(k); decide(); r(); }; }),
    });
    const have = await sizeAt(p);
    if (have == null) {
      used.add(k);
      decide();
      return { target: p, release }; // held until the copy ends
    }
    if (have === size) used.add(k);
    release();
    return have === size ? { target: null, release: () => {} } : undefined;
  };
  const first = await tryAt(path);
  if (first) return first;
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  for (let i = 2; i < 1000; i++) {
    const claim = await tryAt(`${stem} (${i})${ext}`);
    if (claim) return claim;
  }
  throw new Error(`Too many copies of ${path} already`);
}

/** Where to save a file: `path` itself, null when the same-size file is already there (skip), or "name (2).ext" and so on. */
export async function targetFor(path, size, statFn = stat) {
  const { target, release } = await claimTarget(path, size, statFn);
  release();
  return target;
}

/** Deletes our half file. Resolves true when it could not be deleted (it is never a folder of somebody's: only unlink is used). */
async function removePart(part) {
  for (let i = 0; i < 4; i++) {
    try {
      await unlink(part);
      return false;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      if (i < 3) await new Promise((r) => setTimeout(r, 100)); // Windows can hold a file for a moment after adb is stopped
    }
  }
  return true;
}

/**
 * Copies one phone file into `target` with `adb pull`, through its temporary
 * name. Resolves with the bytes received; rejects (nothing saved) when the
 * phone would not send it or the size differs from the scan's.
 */
export async function copyOne({ adb, serial, remote, target, size, mtime, task, spawnAdb = spawn, pollMs = 250 }) {
  const part = partOf(target);
  const leftover = async () => {
    if (await removePart(part)) task.addError(remote, `Stopped, but a half file was left: ${part}`);
  };
  if (task.cancelled) return 0;
  // Our own file first. It proves the folder can be written, and adb refuses to
  // pull a phone folder onto a file (onto a free name it would copy the whole
  // tree). It starts with the wrong length, so adb ending "successfully"
  // without writing it can't pass the size check. A folder of this name is not
  // ours: making the file fails and nothing is deleted.
  try {
    await writeFile(part, size === 0 ? 'x' : '');
  } catch (err) {
    throw new Error(`Can’t write in ${dirname(target)} (${err.code ?? err.message})`);
  }
  if (task.cancelled) { // cancelled while the file was being made: no hook was set yet
    await leftover();
    return 0;
  }
  let counted = 0;
  let over = false;
  let errText = '';
  let error = null;
  const report = (n) => {
    const more = Math.min(n, size) - counted;
    if (more > 0) {
      counted += more;
      task.bytes += more;
    }
  };
  const partNow = () => stat(part).catch(() => null);

  // The raw phone path: no shell is involved, so nothing is quoted.
  const child = spawnAdb(adb, ['-s', serial, 'pull', remote, adbPath(part)], { windowsHide: true });
  const off = task.onCancel(() => child.kill());
  child.stdout?.resume();
  child.stderr?.on('data', (d) => { errText = (errText + d).slice(-4000); });
  const timer = setInterval(async () => {
    const s = await partNow();
    if (!over && s?.isFile()) report(s.size); // a late answer must not count after the end
  }, pollMs);
  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      error ??= err;
      if (child.pid == null) resolve(null); // never started, so no 'close' will come
    });
    child.on('close', resolve);
  });
  over = true;
  clearInterval(timer);
  off();

  const st = await partNow();
  const got = st?.isFile() ? st.size : 0;
  let problem = error;
  if (!problem && code !== 0) problem = new Error(pullError(errText));
  if (!problem && !st?.isFile()) problem = new Error('The phone would not send this file');
  if (!problem && got !== size) problem = new Error(`Got ${got} of ${size} bytes; it may have changed since the scan`);
  if (!problem && !task.cancelled) {
    try {
      await rename(part, target);
      if (mtime > 0) await utimes(target, mtime, mtime).catch(() => {});
      report(size);
      return got;
    } catch (err) {
      problem = err;
    }
  }
  if (task.cancelled) {
    await leftover();
    report(got); // what really arrived, also since the last look
    return got;
  }
  const left = await removePart(part);
  task.bytes -= counted; // the caller counts the whole file as handled
  throw left ? new Error(`${problem.message} (a half file was left: ${part})`) : problem;
}

/** Copies everything in `plan` into the folder `dest`, `lanes` files at a time, updating `task`. */
export async function pullToPc({ adb, serial, plan, dest, task, lanes = 3, spawnAdb = spawn, statFn = stat, pollMs = 250 }) {
  const top = plan.isFile ? dest : join(dest, plan.name);
  task.totalFiles = plan.files.length;
  task.totalBytes = plan.totalBytes;
  await mkdir(dest, { recursive: true });
  for (const rel of plan.dirs) {
    if (task.cancelled) return;
    await mkdir(join(top, ...rel), { recursive: true });
  }
  let next = 0;
  const used = new Set(); // names this copy has given out
  const worker = async () => {
    while (!task.cancelled && next < plan.files.length) {
      const f = plan.files[next++];
      task.current = f.remote;
      const path = join(top, ...f.rel);
      let release = () => {};
      try {
        const claim = await claimTarget(path, f.size, statFn, used);
        release = claim.release;
        if (claim.target == null) {
          task.skipped++;
          task.bytes += f.size;
        } else {
          await copyOne({ adb, serial, remote: f.remote, target: claim.target, size: f.size, mtime: f.mtime, task, spawnAdb, pollMs });
        }
        if (!task.cancelled) task.files++;
      } catch (err) {
        task.addError(f.remote, err.message);
        task.bytes += f.size; // so the bar still reaches the end
      } finally {
        release();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, lanes) }, worker));
  return top;
}

