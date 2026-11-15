// Deleting what a scan found. On this PC a file or folder goes to the Recycle
// Bin (Windows' SHFileOperation through PowerShell, so it can be restored);
// Windows asks first when something is too big for the bin. A phone has no
// bin: `rm -rf` there is permanent, which the page says before asking.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runAdb, shQuote } from './adb.js';

// FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI | FOF_WANTNUKEWARNING
const RECYCLE_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class StorageTreeBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo;
    public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static string Recycle(string[] paths) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3;
    op.pFrom = string.Join("\\0", paths) + "\\0";
    op.fFlags = 0x4 | 0x10 | 0x40 | 0x400 | 0x4000;
    int r = SHFileOperation(ref op);
    return r + "|" + op.fAnyOperationsAborted;
  }
}
"@
$paths = [string[]]($env:STORAGE_TREE_PATHS | ConvertFrom-Json)
[StorageTreeBin]::Recycle($paths)
`;

const encoded = Buffer.from(RECYCLE_PS, 'utf16le').toString('base64');

/** Moves files or folders on this PC to the Recycle Bin. Resolves when they are gone; rejects with the reason otherwise. */
export function recycle(paths) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      timeout: 10 * 60_000,
      env: { ...process.env, STORAGE_TREE_PATHS: JSON.stringify(paths) },
    }, (err, stdout, stderr) => {
      const left = paths.filter((p) => existsSync(p));
      if (!left.length) return resolve();
      const [code, aborted] = String(stdout).trim().split('|');
      if (aborted === 'True') return reject(new Error('Deleting was cancelled.'));
      reject(new Error(err && !code ? (stderr || err.message).trim() : `Windows could not move ${left[0]} to the Recycle Bin (code ${code}); it may be open in another program.`));
    });
  });
}

/** Deletes a file or folder on the phone for good. Resolves when it is gone. */
export async function removeOnPhone({ adb, serial, path, run = runAdb }) {
  const q = shQuote(path);
  const r = await run(adb, ['-s', serial, 'shell', `rm -rf ${q}; if [ -e ${q} ]; then echo STILL-THERE; fi`], { timeout: 10 * 60_000 });
  if (r.code === 0 && !/STILL-THERE/.test(r.stdout)) return;
  const reason = r.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  throw new Error(reason ? `The phone said: ${reason}` : `The phone did not delete ${path}.`);
}
