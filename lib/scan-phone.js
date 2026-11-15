// Scanning a folder on an Android phone: the phone lists its own files
// (`find … | xargs stat`) and sends one line per entry over USB, which is read
// as it arrives. Phones whose shell can't do that fall back to `du -a -k`
// (sizes rounded up to whole KiB, no dates).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { listCommand, parseDu, parseStatLine, relSegments, runAdb, shQuote } from './adb.js';

const deniedLine = /^(?:find|stat|du): (.+?): (Permission denied|No such file or directory|Operation not permitted)/;

function addEntry(tree, root, e) {
  const segs = relSegments(root, e.path);
  if (!segs) return;
  if (e.dir) tree.addDir(segs);
  else if (e.file) tree.addFile(segs, e.size, e.mtime);
}

/**
 * Printed after the listing. Without it the stream ended early (the USB
 * connection dropped, adb restarted), and a shortened list must not pass for
 * a whole one.
 */
export const LIST_END = 'STORAGE-TREE-LIST-END';

/**
 * Fills `tree` with everything below `root` on the phone. Resolves with
 * { method } ('stat' or 'du'), plus `incomplete: true` when the phone stopped
 * sending before the end of the list.
 */
export function scanPhone({ adb, serial, root, tree, onError = () => {}, onChild = () => {}, spawnAdb = spawn, run = runAdb }) {
  return new Promise((resolve, reject) => {
    const child = spawnAdb(adb, ['-s', serial, 'shell', `${listCommand(root)}; echo ${LIST_END}`], { windowsHide: true });
    onChild(child);
    let lines = 0;
    let ended = false;
    let stderr = '';
    const other = []; // unexpected error lines, reported once the listing turns out usable
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (line === LIST_END) {
        ended = true;
        return;
      }
      const e = parseStatLine(line);
      if (!e) return;
      lines++;
      addEntry(tree, root, e);
    });
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      const d = deniedLine.exec(line);
      if (d) onError(d[1], d[2]);
      else if (line.trim()) {
        if (stderr.length < 4000) stderr += `${line}\n`;
        if (other.length < 50) other.push(line.trim());
      }
    });
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      if (signal) return reject(new Error('Scan stopped'));
      if (lines > 0) {
        // Anything else the phone complained about may mean entries are missing, so show it.
        for (const msg of other) onError(root, msg);
        return resolve(ended ? { method: 'stat' } : { method: 'stat', incomplete: true });
      }
      if (/device .*not found|no devices|unauthorized|offline/i.test(stderr)) return reject(new Error(stderr.trim()));
      // Nothing usable came back: try du, which every Android shell has.
      const du = await run(adb, ['-s', serial, 'shell', `du -a -k ${shQuote(root)}`], { timeout: 10 * 60_000 });
      for (const line of du.stderr.split(/\r?\n/)) {
        const d = deniedLine.exec(line);
        if (d) onError(d[1], d[2]);
      }
      const rows = parseDu(du.stdout);
      if (!rows.length) return reject(new Error((stderr || du.stderr).trim() || `The phone listed nothing below ${root} (exit code ${code})`));
      for (const e of rows) addEntry(tree, root, e);
      resolve({ method: 'du' });
    });
  });
}
