// Numbers for people (no DOM, so it is unit tested).

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 -> "1.5 KB" (1 KB = 1024 bytes, as Windows shows). */
export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  if (n < 1024) return `${n} B`;
  let u = 0;
  let v = n;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${UNITS[u]}`;
}

export const formatCount = (n) => (n == null ? '–' : Number(n).toLocaleString('en-GB'));

/** Seconds since 1970 -> "14 Nov 2026", or '' for 0. */
export function formatDate(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** part / whole as "12.3%" ("<0.1%" for tiny, '' when whole is 0). */
export function formatPercent(part, whole) {
  if (!whole) return '';
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
}

/** 75.4 seconds -> "1 min 15 s". */
export function formatSeconds(s) {
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** Why a place could not be read, in plain words, from a Node or phone error code. */
export function errorReason(code) {
  return {
    EPERM: 'no permission (Windows keeps it private)',
    EACCES: 'no permission (Windows keeps it private)',
    EBUSY: 'in use by Windows',
    ENOENT: 'gone before it could be read',
    'Permission denied': 'no permission (private to an app)',
    'Operation not permitted': 'no permission (private to an app)',
    'No such file or directory': 'gone before it could be read',
  }[code] ?? code;
}
