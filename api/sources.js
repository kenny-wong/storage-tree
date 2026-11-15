// What can be scanned: this PC's drives and the phones adb can see.

import { findAdb, parseDevices, parseDf, parseDiskstats, runAdb, serialParam } from '../lib/adb.js';
import { listDrives } from '../lib/scan-local.js';
import { fail, ok } from '../lib/http.js';

export async function drives() {
  return ok({ drives: await listDrives() });
}

export async function devices() {
  const adb = findAdb();
  if (!adb) return ok({ adb: null, devices: [] });
  const r = await runAdb(adb, ['devices', '-l'], { timeout: 15_000 });
  if (r.code !== 0) return ok({ adb, devices: [], error: r.stderr.trim() });
  return ok({ adb, devices: parseDevices(r.stdout) });
}

/** The phone's storage: total and free space, Android's own counts by kind, and per app. */
export async function storage({ params }) {
  const serial = serialParam(params.serial);
  if (!serial) return fail(400, 'bad-serial', 'That is not a device id adb would give.');
  const adb = findAdb();
  if (!adb) return fail(400, 'no-adb', 'adb was not found.');
  const [df, stats, model] = await Promise.all([
    runAdb(adb, ['-s', serial, 'shell', 'df -k /data /storage/emulated/0'], { timeout: 20_000 }),
    runAdb(adb, ['-s', serial, 'shell', 'dumpsys diskstats'], { timeout: 30_000 }),
    runAdb(adb, ['-s', serial, 'shell', 'getprop ro.product.marketname; getprop ro.product.model; getprop ro.build.version.release'], { timeout: 10_000 }),
  ]);
  if (df.code !== 0 && stats.code !== 0) return fail(502, 'adb', (df.stderr || stats.stderr).trim() || 'The phone did not answer.');
  const [marketName, modelName, android] = model.stdout.split(/\r?\n/).map((s) => s.trim());
  return ok({
    name: marketName || modelName || serial,
    android: android || null,
    df: parseDf(df.stdout),
    ...parseDiskstats(stats.stdout),
  });
}
