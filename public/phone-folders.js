// What the usual folders on an Android phone are for (no DOM, so it is unit
// tested). Each answer has a short tag for the folder lists, a sentence for
// the open folder, and a kind that says how to treat it:
//   yours  your own files: copy them to the PC before deleting
//   app    an app's files: clear them inside the app or in Settings › Apps
//   clear  safe to delete: made again when needed, or already deleted items
//   info   a container of other folders

export const KINDS = {
  yours: 'Your files: copy to the PC before deleting',
  app: 'An app’s files: clear them in the app or in Settings › Apps › Storage',
  clear: 'Safe to clear: made again when needed',
  info: 'Holds other folders',
};

/** Package name -> app name, for folders under Android/data, Android/media and Android/obb. */
export const APP_NAMES = {
  'com.whatsapp': 'WhatsApp',
  'com.whatsapp.w4b': 'WhatsApp Business',
  'com.tencent.mm': 'WeChat',
  'org.telegram.messenger': 'Telegram',
  'jp.naver.line.android': 'LINE',
  'com.facebook.katana': 'Facebook',
  'com.facebook.orca': 'Messenger',
  'com.instagram.android': 'Instagram',
  'com.snapchat.android': 'Snapchat',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.ss.android.ugc.trill': 'TikTok',
  'com.discord': 'Discord',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.spotify.music': 'Spotify',
  'com.netflix.mediaclient': 'Netflix',
  'com.amazon.avod.thirdpartyclient': 'Prime Video',
  'com.disney.disneyplus': 'Disney+',
  'com.google.android.apps.photos': 'Google Photos',
  'com.sec.android.gallery3d': 'Samsung Gallery',
  'com.sec.android.app.camera': 'Samsung Camera',
  'com.sec.android.app.myfiles': 'My Files',
  'com.samsung.android.app.notes': 'Samsung Notes',
  'com.sec.android.app.voicenote': 'Voice Recorder',
  'com.android.chrome': 'Chrome',
  'com.sec.android.app.sbrowser': 'Samsung Internet',
  'com.google.android.gm': 'Gmail',
  'com.google.android.apps.maps': 'Google Maps',
  'com.google.android.apps.docs': 'Google Drive',
  'com.microsoft.teams': 'Teams',
  'com.microsoft.office.outlook': 'Outlook',
  'us.zoom.videomeetings': 'Zoom',
  'com.tencent.mobileqq': 'QQ',
  'com.sina.weibo': 'Weibo',
  'tv.danmaku.bili': 'bilibili',
  'com.xingin.xhs': 'Xiaohongshu (RED)',
  'com.ss.android.ugc.aweme': 'Douyin',
};

const SHARED_ROOT = /^\/(?:storage\/emulated\/\d+|storage\/self\/primary|sdcard|mnt\/sdcard)(?=\/|$)/i;

/** "/storage/emulated/0/DCIM/Camera" -> "DCIM/Camera"; "" for the root itself; null outside shared storage. */
export function phoneRel(path) {
  const p = String(path ?? '').replace(/\/+$/, '');
  const m = SHARED_ROOT.exec(p);
  if (!m) return null;
  return p.slice(m[0].length).replace(/^\/+/, '');
}

const appName = (pkg) => APP_NAMES[pkg.toLowerCase()] ?? null;
const f = (tag, kind, about) => ({ tag, kind, about });

// First match wins, so specific paths come before general ones. Matched against the lower-case relative path.
const RULES = [
  [/^$/, () => f('Shared storage', 'info', 'The part of the phone you and your apps can see: photos, downloads, music and the files apps keep here. Installed apps, their private data and Android itself live outside it and need root to read.')],
  [/(^|\/)\.thumbnails$/, () => f('Thumbnails', 'clear', 'Small previews the gallery made of your photos and videos. Safe to delete; they are made again when needed.')],
  [/(^|\/)\.trash$/, () => f('Recycle bin', 'clear', 'Photos and files you deleted in Gallery or My Files, kept for 30 days. Empty it in Gallery › Recycle bin (or My Files › Recycle bin).')],
  [/^dcim$/, () => f('Camera', 'yours', 'Photos and videos from the camera, plus screenshots and screen recordings on many phones. Usually the biggest folder. Copy it to the PC (Save to PC) or a cloud backup before deleting anything.')],
  [/^dcim\/camera$/, () => f('Camera photos & videos', 'yours', 'Everything the camera app takes. Videos (.mp4) are usually most of the space: a minute of 4K video is about 400 MB.')],
  [/(^|\/)screenshots$/, () => f('Screenshots', 'yours', 'Screenshots you took. Often many you no longer need.')],
  [/(^|\/)screen ?recordings?$/, () => f('Screen recordings', 'yours', 'Videos of the screen you recorded.')],
  [/^dcim\/[^/]+$/, () => f('Photos', 'yours', 'Photos and videos from a camera, an app or an old phone, kept with the camera roll.')],
  [/^pictures$/, () => f('Pictures', 'yours', 'Pictures saved by apps: edited photos, images saved from chats and social apps, and screenshots on some phones.')],
  [/^movies$/, () => f('Videos', 'yours', 'Videos saved by apps (editors, downloads, social apps).')],
  [/^download$/, () => f('Downloads', 'yours', 'Files from the browser and apps: attachments, PDFs, installers (.apk), videos. Often holds big files you no longer need.')],
  [/^documents$/, () => f('Documents', 'yours', 'Documents saved by apps.')],
  [/^music$/, () => f('Music', 'yours', 'Music files copied to the phone or downloaded by some apps.')],
  [/^podcasts$/, () => f('Podcasts', 'yours', 'Downloaded podcast episodes.')],
  [/^audiobooks$/, () => f('Audiobooks', 'yours', 'Downloaded audiobooks.')],
  [/^(ringtones|alarms|notifications)$/, () => f('Sounds', 'yours', 'Your own ringtones, alarm and notification sounds.')],
  [/^recordings\/call$|^call$/, () => f('Call recordings', 'yours', 'Recorded phone calls.')],
  [/^recordings$/, () => f('Recordings', 'yours', 'Voice Recorder recordings (and call recordings on Samsung phones).')],
  [/^bluetooth$/, () => f('Bluetooth', 'yours', 'Files received over Bluetooth.')],
  [/^smartswitch$/, () => f('Smart Switch', 'yours', 'Backups and transfers from Samsung Smart Switch, often from an old phone. Copy to the PC if you want them, then they can go.')],
  [/^samsung$/, () => f('Samsung apps', 'yours', 'Files from Samsung apps, such as exported notes and music.')],
  [/^whatsapp$/, () => f('WhatsApp (old)', 'yours', 'Where WhatsApp kept chat media before Android 11. Newer WhatsApp uses Android/media/com.whatsapp.')],
  [/^telegram$/, () => f('Telegram', 'app', 'Media Telegram downloaded. Clear it in Telegram › Settings › Data and Storage › Storage Usage.')],
  [/^android$/, () => f('App folders', 'info', 'Folders apps keep on shared storage: data (their own files and caches), media (chat photos and videos) and obb (game data).')],
  [/^android\/data$/, () => f('App data', 'app', 'Each app’s own files and caches, one folder per app (named after its package). Deleted when the app is uninstalled. Clear an app’s cache or data in Settings › Apps › the app › Storage.')],
  [/^android\/media$/, () => f('App media', 'app', 'Photos, videos and voice notes that apps keep for you, such as WhatsApp and WeChat chat media. Stays after the app is uninstalled.')],
  [/^android\/obb$/, () => f('Game data', 'app', 'Extra data of big apps and games (expansion files). Deleted with the app; a game downloads it again if it is removed.')],
  [/^android\/media\/com\.whatsapp(\.w4b)?\/whatsapp( business)?\/media$/, () => f('WhatsApp media', 'yours', 'Photos, videos, voice notes and documents from your chats. Review big chats in WhatsApp › Settings › Storage and data › Manage storage.')],
  [/^android\/media\/com\.whatsapp(\.w4b)?\/whatsapp( business)?\/(backups|databases)$/, () => f('WhatsApp backups', 'yours', 'Local copies of your chat history. Keep the newest one.')],
  [/^android\/media\/com\.whatsapp(\.w4b)?\/whatsapp( business)?\/media\/\.statuses$/, () => f('Status cache', 'clear', 'Statuses you viewed. Removed by WhatsApp after a day.')],
  [/^android\/data\/[^/]+\/(cache|\.cache)$/, () => f('Cache', 'clear', 'This app’s cache. Safe to delete; the app downloads or makes it again.')],
  [/^android\/(data|media|obb)\/([^/]+)$/, (m) => {
    const name = appName(m[2]);
    const who = name ?? 'An app';
    const pkg = name ? '' : ` (package ${m[2]})`;
    if (m[1] === 'data') return f(name ? `${name} data` : 'App data', 'app', `${who}’s own files and caches${pkg}. Deleted when the app is uninstalled; clear them in the app or in Settings › Apps › Storage.`);
    if (m[1] === 'media') return f(name ? `${name} media` : 'App media', 'app', `Photos, videos and other media ${name ?? 'the app'} keeps for you${pkg}. Stays after the app is uninstalled.`);
    return f(name ? `${name} game data` : 'Game data', 'app', `Extra data downloaded by ${name ?? 'an app or game'}${pkg}. Deleted with the app; downloaded again if removed.`);
  }],
  [/^android\/data\/.+\/(cache|\.cache)$/, () => f('Cache', 'clear', 'A cache folder inside an app’s files. Usually safe to delete.')],
];

/** { tag, kind, about } for a phone folder path, or null when it is not a well-known folder. */
export function describePhoneFolder(path) {
  const rel = phoneRel(path);
  if (rel == null) return null;
  const low = rel.toLowerCase();
  for (const [re, make] of RULES) {
    const m = re.exec(low);
    if (m) return make(m);
  }
  return null;
}

/** The usual layout shown in the guide, as paths below shared storage with their depth. */
export const GUIDE = [
  ['DCIM', 0], ['DCIM/Camera', 1], ['DCIM/Screenshots', 1],
  ['Pictures', 0], ['Movies', 0], ['Download', 0], ['Documents', 0], ['Music', 0], ['Recordings', 0],
  ['Android', 0], ['Android/data', 1], ['Android/media', 1], ['Android/obb', 1],
];

/** Finds a folder in a scan's root node (children loaded a few levels down) by its relative path, ignoring case. */
export function findIn(rootNode, rel) {
  let n = rootNode;
  for (const seg of rel.split('/')) {
    n = n?.children?.find((c) => c.kind === 'dir' && c.name.toLowerCase() === seg.toLowerCase());
    if (!n) return null;
  }
  return n;
}
