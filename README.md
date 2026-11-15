# Storage Tree

See what fills a disk, on this PC or on an Android phone connected by USB or Wi-Fi, and clear it out.

- **Folders**: a tree sorted by size, with each folder's share of its parent, file count and last change.
- **Treemap**: boxes sized by space, nested three levels and coloured by kind of file (pictures, videos, apps, …). Click a folder to open it. Files too small to draw one by one share a striped box, coloured by what most of them are; click it to open their folder.
- **Phone folders explained**: well-known folders (DCIM, Download, Android/data, Android/media, WhatsApp media, thumbnails, …) carry a tag saying what they hold, coloured by whether they are your files, an app's files or safe to clear; the open folder is described above the list, and a Phone folders guide lists the usual layout with this phone's sizes and what lives outside shared storage.
- **Largest files** and **File types** below the folder you are looking at.
- **Phone**: total and free space, Android's own count by kind (apps, photos, videos, system, …) and the size of every app. After a scan of the whole phone, a line says how much of the used space the scan can't see (installed apps, apps' private data and Android's own files, which need root).
- **Delete**: right-click a folder or file (in the lists or the treemap) or use its ⋯ button. On this PC it goes to the Recycle Bin; on a phone it is deleted for good, which the app says before asking. The totals update without scanning again. The Delete key deletes the open folder.
- **Save to PC** (phones): copy a file or a whole folder to a folder on this PC, with progress, Cancel and Show in Explorer. Files already there with the same size are skipped, so a copy can be run again to finish it; another file with the same name is kept and the new one saved as "name (2)". A cancelled copy leaves no half files.
- **Drag out** (phones): drag a file from the list into Explorer or onto the desktop to copy it.

## Phones

A phone is read through **adb** (Android Debug Bridge), which is much faster than the File Explorer (MTP) connection. The installed app brings its own adb; with `npm start`, install platform-tools (`winget install Google.PlatformTools`, or the Android SDK's copy is found automatically, or set `ADB` to adb.exe).

On the phone: Settings → About phone → tap **Build number** 7 times to show Developer options.

- **USB**: Developer options → **USB debugging** on, connect the cable and tap **Allow** on the phone.
- **Wi-Fi** (Android 11 or later, same network): Developer options → **Wireless debugging** on. In the app, press **Wi-Fi…**. The first time, tap **Pair device with pairing code** on the phone and type its address and code; the app then connects by itself. Later, type the address shown at the top of Wireless debugging and press Connect. A phone on USB and Wi-Fi at once shows once, using USB.

A scan covers shared storage (`/storage/emulated/0`: photos, videos, downloads, WhatsApp media, …). Apps' private files in `/data` can't be read without rooting the phone, so the Apps list shows their sizes from Android instead. Recent Android versions may also hide `Android/data` and `Android/obb`; the scan lists any place it could not read.

## Running

The desktop app: run `Storage-Tree-Setup-<version>.exe` (built with `npm run dist`). It installs for the current user, with Start menu and desktop shortcuts, and brings adb with it.

From the source: Windows 10/11 and [Node.js](https://nodejs.org/) 24 or later. No npm packages are needed to run it; Electron and electron-builder are only for building the installer.

```
npm start      # the app on http://127.0.0.1:8850 in a Chrome app window
npm run dev    # the same without opening Chrome, restarting when files change
npm test       # unit tests (Node's built-in test runner)
npm install    # once, before the two below
npm run app    # the desktop (Electron) version from the source, on port 8852
npm run dist   # the Windows installer in dist/ (draws the icon, copies this PC's adb)
```

## How it works

- `server.js`: a small HTTP server on 127.0.0.1 only; the API refuses other hosts and cross-site writes.
- `lib/scan-local.js`: walks a folder with many reads at once (`readdir` + `lstat`), not following links or junctions.
- `lib/scan-phone.js`: runs `find -H <folder> -print0 | xargs -0 stat -c '%f|%s|%Y|%n'` on the phone through `adb shell` and reads the lines as they arrive (a closing marker line tells a finished list from one cut off by a dropped connection, which is shown as incomplete); falls back to `du -a -k` on phones that can't.
- `lib/adb.js`: finds adb and parses `adb devices -l`, `df -k`, `dumpsys diskstats`, `adb pair`, `adb connect` and `adb mdns services`; merges a phone's USB and Wi-Fi entries by its serial number.
- `lib/tree.js`: the folder tree, totals, largest files and file types, and taking deleted entries out. Scans are kept in memory (the newest 3).
- `lib/remove.js`: the Recycle Bin (Windows' `SHFileOperation` through PowerShell) and `rm -rf` on a phone.
- `lib/pull.js` and `lib/tasks.js`: copies from a phone, one `adb exec-out cat` per file, a few at a time, each written as `.part` and renamed when complete; background tasks with progress and cancel.
- `public/`: the page (plain HTML, CSS and ES modules); `treemap.js` is a squarified treemap layout drawn on a canvas. Dragging a phone file out uses Chrome's `DownloadURL` drag, which fetches the file from the phone as it is dropped.
- `electron/`: the desktop app, running the same server in its own window (port 8851).
