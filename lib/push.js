// Copying files and folders from this PC to a phone. The page can't give the
// server a PC path (a browser only hands over the files' bytes), so each file
// is sent to the server, written to a temporary file here, and sent on with
// `adb push` (about 220 MB/s over USB, four times `adb exec-in cat`). On the
// phone it is written under a temporary name and renamed with `mv -n`, so a
// cut-off copy leaves no half file and nothing there is ever overwritten.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { listCommand, parseStatLine, relSegments, runAdb, shQuote } from './adb.js';

/** A file or folder name the phone can have, or null: no "/", no NUL or other control characters, not "." or "..", at most 255 bytes. */
export function phoneName(name) {
  if (typeof name !== 'string') return null;
  const t = name.normalize('NFC');
  if (!t || t === '.' || t === '..' || t.includes('/') || /[\x00-\x1f]/.test(t) || Buffer.byteLength(t) > 255) return null;
  return t;
}

const joinPhone = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/** "name (2).ext", "name (3).ext"… for the n-th try. */
export function numbered(name, n) {
  if (n < 2) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * Where each sent file goes. `items` are [{ rel: [names], size, mtime }];
 * `there` maps a phone path that exists to { dir, size }. A folder already
 * there is copied into; a file of the same name and size is skipped; any other
 * file of that name is kept and the new one gets "name (2)". Returns
 * { dirs: [phone paths to make], files: [{ i, remote, size, mtime, skip }] }.
 */
export function pushPlan(dest, items, there) {
  const taken = new Map(there); // phone path -> { dir, size }, plus what this copy adds
  const dirs = [];
  const files = [];
  const folderFor = new Map(); // a sent folder's relative path -> where it goes on the phone
  const dirOf = (parts) => {
    let at = dest;
    for (let k = 0; k < parts.length; k++) {
      const key = parts.slice(0, k + 1).join('/');
      if (folderFor.has(key)) {
        at = folderFor.get(key);
        continue;
      }
      let n = 1;
      let p;
      for (;; n++) { // a file of this name is in the way: the folder gets "name (2)"
        p = joinPhone(at, numbered(parts[k], n));
        const t = taken.get(p);
        if (!t || t.dir) break;
      }
      if (!taken.get(p)) {
        taken.set(p, { dir: true, size: 0 });
        dirs.push(p);
      }
      folderFor.set(key, p);
      at = p;
    }
    return at;
  };
  items.forEach((it, i) => {
    const dir = dirOf(it.rel.slice(0, -1));
    const name = it.rel.at(-1);
    for (let n = 1; ; n++) {
      const p = joinPhone(dir, numbered(name, n));
      const t = taken.get(p);
      if (t && !t.dir && t.size === it.size && !t.ours) {
        files.push({ i, remote: p, size: it.size, mtime: it.mtime, skip: true });
        return;
      }
      if (!t) {
        taken.set(p, { dir: false, size: it.size, ours: true });
        files.push({ i, remote: p, size: it.size, mtime: it.mtime, skip: false });
        return;
      }
    }
  });
  return { dirs, files };
}

/** What is already on the phone where a copy goes: the folder's own entries and everything inside the folders the copy goes into. */
export async function phoneContents({ adb, serial, dest, entries, tops, run = runAdb }) {
  const there = new Map();
  for (const e of entries.values()) there.set(joinPhone(dest, e.name), { dir: e.dir, size: e.size });
  for (const top of tops) {
    const e = entries.get(top);
    if (!e?.dir) continue;
    const root = joinPhone(dest, top);
    const r = await run(adb, ['-s', serial, 'shell', listCommand(root)], { timeout: 10 * 60_000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const x = parseStatLine(line);
      if (x && relSegments(root, x.path) && (x.dir || x.file)) there.set(x.path, { dir: x.dir, size: x.size });
    }
  }
  return there;
}

/** The phone's temporary name for a file being sent: hidden, short, and never a name the PC's file has. */
export const phonePart = (remote) => {
  const cut = remote.lastIndexOf('/');
  const hex = createHash('sha256').update(remote).digest('hex').slice(0, 12);
  return `${remote.slice(0, cut + 1)}.storagetree-${hex}.part`;
};

/**
 * A copy to the phone, fed one file at a time by `receive()`. The files go to
 * the phone in the background, while the next one is being received; a
 * received file waits here only while two others are still going to the phone.
 */
export function createPush({ adb, serial, plan, task, tempDir, run = runAdb, spawnAdb = spawn, idleMs = 120_000, pollMs = 1000 }) {
  const byIndex = new Map(plan.files.map((f) => [f.i, f]));
  const queue = [];
  const waiting = []; // receivers held back until the queue is shorter
  let sending = null; // the push running now
  let stopped = false; // cancelled, failed or finished: nothing more happens
  let closing = false; // the page has sent everything
  let idle = null;
  let finish;
  let fail;
  const done = new Promise((ok, no) => { finish = ok; fail = no; });
  done.catch(() => {});
  const made = []; // temporary files here still to delete

  const touchIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { if (!stopped && !closing) stopAll(new Error('The page stopped sending files.')); }, idleMs);
    idle.unref?.();
  };

  async function stopAll(err) {
    if (stopped) return;
    stopped = true;
    clearTimeout(idle);
    for (const w of waiting.splice(0)) w();
    sending?.kill();
    await Promise.all(made.splice(0).map((f) => unlink(f).catch(() => {})));
    if (err) fail(err);
    else finish();
  }
  task.onCancel(() => stopAll(null));

  /** Makes the folders, then is ready for files. */
  async function start() {
    if (plan.dirs.length) {
      const r = await run(adb, ['-s', serial, 'shell', `mkdir -p ${plan.dirs.map(shQuote).join(' ')} && echo MADE`], { timeout: 60_000 });
      if (!/MADE/.test(r.stdout)) throw new Error(`The phone would not make the folder ${plan.dirs[0]}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ''}.`);
    }
    await mkdir(tempDir, { recursive: true });
    touchIdle();
  }

  /** Sends one file to the phone: push to the temporary name, then rename it if the name is still free. */
  async function sendOne(f, local) {
    const part = phonePart(f.remote);
    task.current = f.remote;
    let counted = 0;
    const count = (n) => {
      const more = Math.min(n, f.size) - counted;
      if (more > 0) {
        task.bytes += more;
        counted += more;
      }
    };
    const timer = setInterval(async () => {
      const r = await run(adb, ['-s', serial, 'shell', `stat -c %s ${shQuote(part)} 2>/dev/null`], { timeout: 5000 });
      if (/^\d+/.test(r.stdout.trim())) count(Number(r.stdout.trim()));
    }, pollMs);
    let errText = '';
    const code = await new Promise((resolve) => {
      const child = spawnAdb(adb, ['-s', serial, 'push', local, part], { windowsHide: true });
      sending = child;
      child.stdout?.resume();
      child.stderr?.on('data', (d) => { errText = (errText + d).slice(-2000); });
      child.on('error', (e) => { errText = e.message; resolve(null); });
      child.on('close', resolve);
    });
    clearInterval(timer);
    sending = null;
    const q = shQuote(part);
    const t = shQuote(f.remote);
    if (code !== 0 || stopped) {
      await run(adb, ['-s', serial, 'shell', `rm -f ${q}`], { timeout: 30_000 });
      task.bytes -= counted;
      if (stopped) return;
      const line = errText.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^adb:/.test(l)).at(-1)?.replace(/^adb:\s*(error:\s*)?/, '');
      throw new Error(line || 'The phone would not take this file');
    }
    // The size is checked before the rename; mv -n never replaces a file that appeared meanwhile.
    const r = await run(adb, ['-s', serial, 'shell', `s=$(stat -c %s ${q}); if [ "$s" != "${f.size}" ]; then rm -f ${q}; echo "SIZE $s"; elif [ -e ${t} ]; then rm -f ${q}; echo TAKEN; else mv -n ${q} ${t} && touch -d @${Math.floor(f.mtime)} ${t} 2>/dev/null; [ -e ${q} ] && rm -f ${q} && echo TAKEN; [ -e ${t} ] && echo DONE; fi`], { timeout: 60_000 });
    if (!/DONE/.test(r.stdout) || /TAKEN|SIZE/.test(r.stdout)) {
      task.bytes -= counted;
      throw new Error(/TAKEN/.test(r.stdout) ? 'A file of this name appeared on the phone meanwhile; it was left alone' : /SIZE/.test(r.stdout) ? 'The phone got a different number of bytes' : 'The phone did not keep this file');
    }
    count(f.size);
  }

  async function pump() {
    if (sending || stopped || !queue.length) return;
    const { f, local } = queue.shift();
    waiting.shift()?.();
    try {
      await sendOne(f, local);
      if (!stopped) task.files++;
    } catch (err) {
      if (!stopped) {
        task.addError(f.remote, err.message);
        task.bytes += f.size; // the bar still reaches the end
      }
    } finally {
      unlink(local).catch(() => {});
      const k = made.indexOf(local);
      if (k >= 0) made.splice(k, 1);
    }
    if (queue.length) pump();
    else if (closing) stopAll(null);
  }

  /** One file's bytes from the page. Resolves when they are here (not yet on the phone); rejects when the copy is over. */
  async function receive(i, body) {
    if (stopped || closing) throw new Error(task.cancelled ? 'Cancelled.' : 'This copy is over.');
    touchIdle();
    const f = byIndex.get(i);
    if (!f) throw new Error('No such file in this copy.');
    if (f.skip) {
      body.resume();
      task.skipped++;
      task.files++;
      task.bytes += f.size;
      return;
    }
    while (queue.length >= 2 && !stopped) await new Promise((ok) => waiting.push(ok));
    if (stopped) throw new Error('Cancelled.');
    const local = join(tempDir, `${randomBytes(8).toString('hex')}.part`);
    made.push(local);
    try {
      await pipeline(body, createWriteStream(local));
      const s = await stat(local);
      if (s.size !== f.size) throw new Error(`Got ${s.size} of ${f.size} bytes from the page`);
      if (f.mtime > 0) await utimes(local, f.mtime, f.mtime); // adb push gives the phone's copy this date too
    } catch (err) {
      unlink(local).catch(() => {});
      made.splice(made.indexOf(local), 1);
      throw err;
    }
    if (stopped) {
      unlink(local).catch(() => {});
      throw new Error('Cancelled.');
    }
    queue.push({ f, local });
    pump();
    return f;
  }

  /** The page has sent everything: resolves when the last file is on the phone. */
  function end() {
    closing = true;
    clearTimeout(idle);
    if (!queue.length && !sending) stopAll(null);
    return done;
  }

  return { start, receive, end, done };
}
