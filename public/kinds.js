// File kinds by extension, for treemap colours and the File types list.

const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'raw', 'dng', 'cr2', 'nef', 'arw', 'svg', 'ico', 'avif'],
  video: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'webm', 'm4v', '3gp', 'mts', 'm2ts', 'ts', 'flv', 'mpg', 'mpeg'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'amr', 'mid', 'midi'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'odt', 'ods', 'csv', 'epub', 'json', 'xml', 'html', 'htm'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'img', 'cab'],
  app: ['apk', 'apks', 'xapk', 'obb', 'exe', 'msi', 'dll', 'sys', 'so', 'dex', 'jar', 'appx', 'msix'],
  data: ['db', 'sqlite', 'db-wal', 'db-shm', 'dat', 'bin', 'log', 'tmp', 'cache', 'bak', 'pak', 'vhd', 'vhdx', 'pst', 'ost'],
};

const BY_EXT = new Map(Object.entries(KINDS).flatMap(([k, exts]) => exts.map((e) => [e, k])));

export const KIND_NAMES = { image: 'Pictures', video: 'Videos', audio: 'Audio', document: 'Documents', archive: 'Archives', app: 'Apps & programs', data: 'Data & caches', other: 'Other' };

/** "jpg" -> "image"; unknown -> "other". */
export const kindOf = (ext) => BY_EXT.get(String(ext).toLowerCase()) ?? 'other';
