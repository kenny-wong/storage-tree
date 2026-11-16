// Sizes Windows won't give to an ordinary lstat/readdir, read with robocopy
// (built into Windows) in list-only mode (/L: nothing is copied):
// - locked files such as C:\hiberfil.sys and C:\swapfile.sys refuse lstat
//   (EPERM/EBUSY), but a folder listing still has their size, so they are
//   listed by name without any special rights;
// - folders this account may not open (C:\Windows\Temp, System Volume
//   Information, WindowsApps…) need administrator: robocopy's backup mode (/B)
//   reads them, in one elevated PowerShell that Windows asks about (UAC).
// Output goes to a Unicode log (/UNILOG), so any file name survives.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROBOCOPY = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Robocopy.exe');

// "C:\" can't be passed as "C:\" (a backslash before the closing quote escapes it in some argument parsers).
const srcArg = (p) => (/^[a-z]:\\?$/i.test(p) ? `${p.slice(0, 2)}\\.` : p.replace(/\\+$/, ''));

/** robocopy arguments that list `src` (only `files` in it when given, else everything below it) into the Unicode log `log`. */
export function listArgs({ src, files = null, backup = false, log, dest }) {
  return [
    srcArg(src), dest, ...(files ?? []),
    '/L', ...(files ? [] : ['/S', '/E']), ...(backup ? ['/B'] : []),
    '/FP', '/NC', '/BYTES', '/TS', '/NJH', '/NJS', '/XJ', '/R:0', '/W:0', `/UNILOG:${log}`,
  ];
}

const fileLine = /^\t[ \t]*\t\t\s*(\d+) (\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)\t(.+)$/;
const dirLine = /^\t\s*-?\d+\t(.+\\)$/;

/**
 * Entries from a robocopy list log: { dir: true, path } for each folder
 * (path without the trailing backslash) and { dir: false, path, size, mtime }
 * for each file (mtime in seconds). Error and other lines are left out.
 */
export function parseList(text) {
  const out = [];
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const f = fileLine.exec(raw);
    if (f) {
      const [, size, y, mo, d, h, mi, s, path] = f;
      out.push({ dir: false, path, size: Number(size), mtime: Math.floor(new Date(+y, mo - 1, +d, +h, +mi, +s).getTime() / 1000) });
      continue;
    }
    const m = dirLine.exec(raw);
    if (m) out.push({ dir: true, path: m[1].replace(/\\+$/, '') || m[1] });
  }
  return out;
}

/** Path parts of `p` below `root` ("C:\" + "C:\Windows\Temp" -> ["Windows", "Temp"]), or null when outside it. */
export function relParts(root, p) {
  const r = root.replace(/\\+$/, '');
  const low = p.toLowerCase();
  if (low === r.toLowerCase()) return [];
  if (!low.startsWith(`${r.toLowerCase()}\\`)) return null;
  return p.slice(r.length + 1).split('\\').filter(Boolean);
}

function runRobocopy(args) {
  return new Promise((resolve) => {
    execFile(ROBOCOPY, args, { windowsHide: true, timeout: 5 * 60_000 }, (err) => resolve(err?.code ?? 0));
  });
}

/**
 * Sizes of locked files, no special rights needed. `groups` maps a folder to
 * the file names in it. Resolves with parseList() entries (files only).
 */
export async function listLockedFiles(groups, { run = runRobocopy } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'storage-tree-rc-'));
  const out = [];
  try {
    let i = 0;
    for (const [folder, names] of groups) {
      for (let k = 0; k < names.length; k += 50) { // keeps the command line short
        const log = join(dir, `${i++}.log`);
        await run(listArgs({ src: folder, files: names.slice(k, k + 50), log, dest: join(dir, 'nowhere') }));
        if (existsSync(log)) out.push(...parseList(await readFile(log, 'utf16le')).filter((e) => !e.dir));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

/** The PowerShell run as administrator: robocopy for each job in the jobs file, then a "done" file. */
export function elevatedScript(jobsFile, doneFile) {
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Continue'",
    `$j = Get-Content -LiteralPath ${q(jobsFile)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    'foreach ($x in $j.jobs) { & $j.robocopy $x.args | Out-Null }',
    `Set-Content -LiteralPath ${q(doneFile)} -Value 'done'`,
  ].join('\n');
}

/** The ordinary PowerShell that asks Windows to start `inner` as administrator and waits for it. */
export function launcherScript(inner) {
  const enc = Buffer.from(inner, 'utf16le').toString('base64');
  return [
    'try {',
    `  Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${enc}'`,
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }',
  ].join('\n');
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      timeout: 60 * 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stderr: String(stderr) }));
  });
}

/**
 * Lists folders this account can't open, as administrator (one UAC prompt).
 * Resolves with [{ folder, entries }] (entries from parseList, entries null
 * when that folder gave nothing). Rejects when permission was not given.
 */
export async function listAsAdmin(folders, { powershell = runPowerShell } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'storage-tree-admin-'));
  try {
    const jobs = folders.map((folder, i) => ({ folder, log: join(dir, `${i}.log`) }));
    const jobsFile = join(dir, 'jobs.json');
    const doneFile = join(dir, 'done.txt');
    await writeFile(jobsFile, JSON.stringify({
      robocopy: ROBOCOPY,
      jobs: jobs.map((j) => ({ args: listArgs({ src: j.folder, backup: true, log: j.log, dest: join(dir, 'nowhere') }) })),
    }), 'utf8');
    const r = await powershell(launcherScript(elevatedScript(jobsFile, doneFile)));
    if (r.code !== 0 || !existsSync(doneFile)) {
      const why = r.stderr.trim();
      throw new Error(/cancel/i.test(why) || !why ? 'Administrator permission was not given, so the protected folders were not read.' : why);
    }
    const out = [];
    for (const j of jobs) {
      const entries = existsSync(j.log) ? parseList(await readFile(j.log, 'utf16le')) : [];
      out.push({ folder: j.folder, entries: entries.length ? entries : null });
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
