// Talking to an Android phone over USB through adb (Android Debug Bridge),
// and reading what its commands print. The parsers are pure, so they are
// tested against real output without a phone.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Where adb.exe is: $ADB, then PATH, then the Android SDK's usual folders. Null when none is found. */
export function findAdb(env = process.env, exists = existsSync) {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    env.ADB,
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map((p) => join(p, exe)),
    env.ANDROID_HOME && join(env.ANDROID_HOME, 'platform-tools', exe),
    env.ANDROID_SDK_ROOT && join(env.ANDROID_SDK_ROOT, 'platform-tools', exe),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe),
    env.ProgramFiles && join(env.ProgramFiles, 'platform-tools', exe),
    env.USERPROFILE && join(env.USERPROFILE, 'platform-tools', exe),
    // The copy that comes with the installed app, last: a phone tool's own adb is usually newer.
    env.STORAGE_TREE_BUNDLED_ADB,
  ].filter(Boolean);
  return candidates.find((c) => exists(c)) ?? null;
}

/** Runs adb and resolves with its exit code and output (never rejects for a non-zero exit). */
export function runAdb(adb, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(adb, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr || (err && typeof err.code !== 'number' ? err.message : '') || '' });
    });
  });
}

/** A device serial adb gave us (USB serial, ip:port or an mDNS name for Wi-Fi), or null. */
export const serialParam = (v) => (/^[\w.:\-]{1,128}$/.test(v ?? '') ? v : null);

/** 'wifi' for a serial adb made for a Wi-Fi connection (ip:port or an mDNS service name), else 'usb'. */
export const transportOf = (serial) => (/:\d+$/.test(serial) || /\._adb-tls-connect\._tcp/.test(serial) ? 'wifi' : 'usb');

/**
 * One entry per phone: a phone plugged in by USB and connected over Wi-Fi
 * shows up twice in `adb devices`, so entries with the same hardware serial
 * (`getprop ro.serialno`, given in `hw` by adb serial) are merged. The USB
 * connection is preferred because it is faster.
 */
export function mergeDevices(devices, hw = {}) {
  const groups = new Map();
  for (const d of devices) {
    const key = (d.state === 'device' && hw[d.serial]) || d.serial;
    const transport = transportOf(d.serial);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...d, transport, transports: [transport], serials: [d.serial], wifiSerials: transport === 'wifi' ? [d.serial] : [] });
      continue;
    }
    if (!g.transports.includes(transport)) g.transports.push(transport);
    g.serials.push(d.serial);
    if (transport === 'wifi') g.wifiSerials.push(d.serial);
    const better = (d.state === 'device' && g.state !== 'device') || (d.state === g.state && transport === 'usb' && g.transport !== 'usb');
    if (better) Object.assign(g, { serial: d.serial, state: d.state, transport, model: d.model || g.model, product: d.product || g.product, device: d.device || g.device });
  }
  for (const g of groups.values()) g.transports.sort((a, b) => (a === 'usb' ? -1 : b === 'usb' ? 1 : 0));
  return [...groups.values()];
}

/** host:port for `adb pair` / `adb connect` (an IPv4 address, a name or [IPv6]), or null. */
export function hostPortParam(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  const m = /^(\[[0-9a-f:.]+\]|[\w.\-]{1,253}):(\d{1,5})$/i.exec(t);
  return m && Number(m[2]) > 0 && Number(m[2]) < 65536 ? t : null;
}

/** `adb pair` output -> { ok, guid, message }. guid is the phone's mDNS name, e.g. adb-R58M123-AbCdEf. */
export function parsePair(text) {
  const m = /Successfully paired to (\S+)(?: \[guid=([^\]]+)\])?/.exec(text);
  if (m) return { ok: true, guid: m[2] ?? null, message: `Paired with ${m[1]}.` };
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return { ok: false, guid: null, message: line.replace(/^(error|Failed):\s*/i, '') || 'Pairing failed.' };
}

/** `adb connect` output -> { ok, message }. */
export function parseConnect(text) {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  if (/^(already )?connected to /i.test(line)) return { ok: true, message: line };
  return { ok: false, message: line || 'Could not connect.' };
}

/** `adb mdns services` -> [{ name, service, address }]. */
export function parseMdns(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(_adb[\w.-]*\._tcp)\.?\s+(\S+:\d+)\s*$/.exec(line.trim());
    if (m) out.push({ name: m[1], service: m[2], address: m[3] });
  }
  return out;
}

/** `adb devices -l` -> [{ serial, state, model, product, device }]. state is device, unauthorized, offline, … */
export function parseDevices(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(device|unauthorized|offline|recovery|sideload|bootloader|authorizing|no permissions|host)\b(.*)$/.exec(line.trim());
    if (!m || line.startsWith('List of devices')) continue;
    const props = Object.fromEntries([...m[3].matchAll(/(\w+):(\S+)/g)].map((x) => [x[1], x[2]]));
    out.push({ serial: m[1], state: m[2], model: (props.model ?? '').replace(/_/g, ' '), product: props.product ?? '', device: props.device ?? '' });
  }
  return out;
}

/** Quotes a string for the phone's shell. */
export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A phone folder to scan: absolute, no control characters, no trailing slash (except "/"). Null when not usable. */
export function phonePath(p) {
  if (typeof p !== 'string') return null;
  const t = p.trim().replace(/\/{2,}/g, '/');
  if (!t.startsWith('/') || t.length > 1024 || /[\x00-\x1f]/.test(t)) return null;
  return t.length > 1 ? t.replace(/\/$/, '') : t;
}

/** The command that lists every file and folder below `path` as "hexmode|size|mtime|path" lines. */
export const listCommand = (path) => `find -H ${shQuote(path)} -exec stat -c '%f|%s|%Y|%n' {} +`;

/** One "hexmode|size|mtime|path" line -> { dir, size, mtime, path }, or null for anything else. */
export function parseStatLine(line) {
  const m = /^([0-9a-f]{1,8})\|(\d+)\|(\d+)\|(\/.*)$/.exec(line);
  if (!m) return null;
  const type = parseInt(m[1], 16) & 0o170000;
  return { dir: type === 0o040000, file: type === 0o100000, size: Number(m[2]), mtime: Number(m[3]), path: m[4].replace(/\/{2,}/g, '/') };
}

/** The parts of a phone path below the scan's root, or null when it isn't below it. The root itself is []. */
export function relSegments(root, path) {
  if (path === root) return [];
  const prefix = root === '/' ? '/' : `${root}/`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split('/').filter(Boolean);
}

/**
 * `du -a -k` output (for phones whose find or stat can't do the above):
 * size in KiB and path per line. Folders are the paths that have others below them.
 */
export function parseDu(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+)\s+(\/.*)$/.exec(line);
    if (m) rows.push({ size: Number(m[1]) * 1024, path: m[2].replace(/\/{2,}/g, '/') });
  }
  const dirs = new Set();
  for (const r of rows) {
    const cut = r.path.lastIndexOf('/');
    if (cut > 0) dirs.add(r.path.slice(0, cut));
  }
  return rows.map((r) => ({ ...r, dir: dirs.has(r.path), file: !dirs.has(r.path), mtime: 0 }));
}

/** `df -k` -> [{ filesystem, total, used, free, mount }] in bytes. */
export function parseDf(text) {
  const out = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^Filesystem/i.test(line)) continue;
    // A long filesystem name can push the numbers onto the next line.
    if (/^\S+$/.test(line.trim()) && lines[i + 1] && /^\s+\d/.test(lines[i + 1])) line = `${line.trim()} ${lines[++i].trim()}`;
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\S.*)$/.exec(line.trim());
    if (m) out.push({ filesystem: m[1], total: Number(m[2]) * 1024, used: Number(m[3]) * 1024, free: Number(m[4]) * 1024, mount: m[5] });
  }
  return out;
}

const listOf = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/**
 * `dumpsys diskstats`: the phone's own count of space by kind (apps, photos,
 * videos, …) and per app, from Android's daily storage job. Sizes in bytes.
 */
export function parseDiskstats(text) {
  const field = (name) => {
    const m = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(text);
    return m ? m[1].trim() : null;
  };
  const num = (name) => {
    const v = field(name);
    return v != null && /^-?\d+$/.test(v) ? Number(v) : null;
  };
  const free = /^Data-Free:\s*(\d+)K\s*\/\s*(\d+)K total/m.exec(text);
  const categories = [
    ['apps', 'App Size'], ['appData', 'App Data Size'], ['appCache', 'App Cache Size'],
    ['photos', 'Photos Size'], ['videos', 'Videos Size'], ['audio', 'Audio Size'],
    ['downloads', 'Downloads Size'], ['system', 'System Size'], ['other', 'Other Size'],
  ].map(([key, name]) => ({ key, size: num(name) })).filter((c) => c.size != null && c.size >= 0);
  const names = listOf(field('Package Names') ?? '[]');
  const app = listOf(field('App Sizes') ?? '[]');
  const data = listOf(field('App Data Sizes') ?? '[]');
  const cache = listOf(field('Cache Sizes') ?? '[]');
  const apps = names.map((pkg, i) => {
    const a = Number(app[i]) || 0;
    const d = Number(data[i]) || 0;
    return { pkg: String(pkg), app: a, data: d, cache: Number(cache[i]) || 0, total: a + d };
  }).sort((x, y) => y.total - x.total);
  return {
    free: free ? Number(free[1]) * 1024 : null,
    total: free ? Number(free[2]) * 1024 : null,
    categories,
    apps,
  };
}
