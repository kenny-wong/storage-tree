// Why a whole-phone scan finds less than the phone says is used (no DOM, so
// it is unit tested). The scan sees the shared storage only; installed apps,
// their private data and Android's own files on the data partition need root.

const WHOLE = /^\/(?:storage\/emulated\/0|storage\/self\/primary|sdcard|mnt\/sdcard)\/?$/;

/** True when `path` is the phone's whole shared storage, not a folder inside it. */
export const isWholeShared = (path) => WHOLE.test(String(path ?? ''));

/** Space used on the data partition from the storage summary, or null. */
export function phoneUsed(storage) {
  const data = storage?.df?.find((f) => f.mount === '/data') ?? storage?.df?.[0];
  const total = data?.total ?? storage?.total;
  const free = data?.free ?? storage?.free;
  return total != null && free != null ? total - free : null;
}

/** Bytes of Android/data and Android/obb in a scan's root node (they count as app data on the phone). */
export function appDirsSize(rootNode) {
  const android = rootNode?.children?.find((c) => c.kind === 'dir' && c.name === 'Android');
  return (android?.children ?? []).filter((c) => c.kind === 'dir' && (c.name === 'data' || c.name === 'obb')).reduce((s, c) => s + c.size, 0);
}

/**
 * used - scanned, split by Android's own counts: installed apps, apps' private
 * data (App data minus the Android/data and Android/obb the scan saw), and the
 * rest (Android's own files). Each part is capped so they add up to the gap.
 * null when there is no gap.
 */
export function notScanned({ used, scanned, categories = [], appDirs = 0 }) {
  if (used == null || scanned == null || used - scanned <= 0) return null;
  const gap = used - scanned;
  const get = (k) => categories.find((c) => c.key === k)?.size ?? 0;
  const apps = Math.min(get('apps'), gap);
  const privateData = Math.min(Math.max(0, get('appData') - appDirs), gap - apps);
  return { gap, apps, privateData, android: gap - apps - privateData };
}
