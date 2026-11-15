// What can be scanned: this PC's drives and the phones adb can see.

import { findAdb, hostPortParam, mergeDevices, parseConnect, parseDevices, parseDf, parseDiskstats, parseMdns, parsePair, runAdb, serialParam } from '../lib/adb.js';
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
  const list = parseDevices(r.stdout);
  // The phone's own serial number tells a USB and a Wi-Fi connection to the same phone apart from two phones.
  const hw = {};
  await Promise.all(list.filter((d) => d.state === 'device').map(async (d) => {
    const s = await runAdb(adb, ['-s', d.serial, 'shell', 'getprop ro.serialno'], { timeout: 8000 });
    if (s.code === 0 && s.stdout.trim()) hw[d.serial] = s.stdout.trim();
  }));
  return ok({ adb, devices: mergeDevices(list, hw) });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pairs with a phone for Wi-Fi debugging (Developer options → Wireless
 * debugging → Pair device with pairing code), then connects to it: the phone
 * announces its connect port on the network, so the user doesn't have to type it.
 */
export async function pair({ body }, run = runAdb, pause = wait) {
  const address = hostPortParam(body?.address);
  const code = typeof body?.code === 'string' ? body.code.replace(/\s/g, '') : '';
  if (!address) return fail(400, 'bad-address', 'Type the IP address and port the phone shows, such as 192.168.1.23:41235.');
  if (!/^\d{6}$/.test(code)) return fail(400, 'bad-code', 'The pairing code is the 6 digits the phone shows.');
  const adb = findAdb();
  if (!adb) return fail(400, 'no-adb', 'adb was not found.');
  const r = await run(adb, ['pair', address, code], { timeout: 30_000 });
  const p = parsePair(`${r.stdout}\n${r.stderr}`);
  if (!p.ok) return fail(400, 'pair-failed', `Pairing failed: ${p.message}`);
  const host = address.replace(/:\d+$/, '');
  for (let i = 0; i < 6; i++) {
    const m = await run(adb, ['mdns', 'services'], { timeout: 10_000 });
    const svc = parseMdns(m.stdout).find((s) => s.service.startsWith('_adb-tls-connect') && ((p.guid && s.name === p.guid) || s.address.startsWith(`${host}:`)));
    if (svc) {
      const c = parseConnect((await run(adb, ['connect', svc.address], { timeout: 20_000 })).stdout);
      return ok({ ok: true, message: c.ok ? `${p.message} Connected over Wi-Fi.` : `${p.message} Now connect with the address under Wireless debugging.`, connected: c.ok ? svc.address : null });
    }
    await pause(1000);
  }
  return ok({ ok: true, message: `${p.message} Now connect with the IP address and port shown under Wireless debugging.`, connected: null });
}

/** Connects to a phone over Wi-Fi (the IP address & port under Wireless debugging; it must have been paired once). */
export async function connect({ body }, run = runAdb) {
  const address = hostPortParam(body?.address);
  if (!address) return fail(400, 'bad-address', 'Type the IP address and port shown under Wireless debugging, such as 192.168.1.23:37000.');
  const adb = findAdb();
  if (!adb) return fail(400, 'no-adb', 'adb was not found.');
  const r = await run(adb, ['connect', address], { timeout: 20_000 });
  const c = parseConnect(`${r.stdout}\n${r.stderr}`);
  return c.ok ? ok({ ok: true, message: c.message }) : fail(400, 'connect-failed', `${c.message}. Is the phone on the same Wi-Fi with Wireless debugging on, and paired with this PC?`);
}

/** Ends a Wi-Fi connection. */
export async function disconnect({ body }, run = runAdb) {
  const serial = serialParam(body?.serial);
  if (!serial) return fail(400, 'bad-serial', 'That is not a device id adb would give.');
  const adb = findAdb();
  if (!adb) return fail(400, 'no-adb', 'adb was not found.');
  const r = await run(adb, ['disconnect', serial], { timeout: 15_000 });
  return r.code === 0 ? ok({ ok: true }) : fail(400, 'disconnect-failed', (r.stderr || r.stdout).trim() || 'adb could not disconnect.');
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
