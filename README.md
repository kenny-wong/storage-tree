# Storage Tree

See what fills a disk, on this PC or on an Android phone connected by USB.

- **Folders**: a tree sorted by size, with each folder's share of its parent, file count and last change.
- **Treemap**: boxes sized by space, nested three levels and coloured by kind of file (pictures, videos, apps, …). Click a folder to open it.
- **Largest files** and **File types** below the folder you are looking at.
- **Phone**: total and free space, Android's own count by kind (apps, photos, videos, system, …) and the size of every app.

Everything runs on your PC; nothing is changed or deleted on the disk or the phone.

## Phones

A phone with no SD card is read through **adb** (Android Debug Bridge), which is much faster than the File Explorer (MTP) connection:

1. Install platform-tools: `winget install Google.PlatformTools` (or use the copy in the Android SDK; it is found automatically, or set `ADB` to adb.exe).
2. On the phone: Settings → About phone → tap **Build number** 7 times, then Developer options → **USB debugging** on.
3. Connect the cable and tap **Allow** on the phone.

A scan covers shared storage (`/storage/emulated/0`: photos, videos, downloads, WhatsApp media, …). Apps' private files in `/data` can't be read over USB without rooting the phone, so the Apps list shows their sizes from Android instead. Recent Android versions may also hide `Android/data` and `Android/obb`; the scan lists any place it could not read.

## Running

Needs Windows 10/11 and [Node.js](https://nodejs.org/) 24 or later. No npm packages.

```
npm start      # the app on http://127.0.0.1:8850 in a Chrome app window
npm run dev    # the same without opening Chrome, restarting when files change
npm test       # unit tests (Node's built-in test runner)
```

## How it works

- `server.js`: a small HTTP server on 127.0.0.1 only; the API refuses other hosts and cross-site writes.
- `lib/scan-local.js`: walks a folder with many reads at once (`readdir` + `lstat`), not following links or junctions.
- `lib/scan-phone.js`: runs `find -H <folder> -exec stat -c '%f|%s|%Y|%n' {} +` on the phone through `adb shell` and reads the lines as they arrive; falls back to `du -a -k` on phones that can't.
- `lib/adb.js`: finds adb and parses `adb devices -l`, `df -k` and `dumpsys diskstats`.
- `lib/tree.js`: the folder tree, totals, largest files and file types. Scans are kept in memory (the newest 3).
- `public/`: the page (plain HTML, CSS and ES modules); `treemap.js` is a squarified treemap layout drawn on a canvas.
