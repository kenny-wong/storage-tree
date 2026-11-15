// The desktop app. Electron runs the same server as `npm start` inside its
// own process and shows the page in its own window. adb comes with the
// installer (resources/adb); a platform-tools adb already on this PC is
// preferred, so two different adb versions don't keep restarting each other's server.

process.env.UV_THREADPOOL_SIZE ??= '16';

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { linkAction, windowKey } from './links.js';

const NAME = 'Storage Tree';
// 8850 is `npm start`'s, so the installed app and a development copy can run beside it.
const PORT = app.isPackaged ? 8851 : 8852;

if (process.env.LOCALAPPDATA) app.setPath('userData', join(process.env.LOCALAPPDATA, app.isPackaged ? NAME : `${NAME} (development)`));
const bundledAdb = join(process.resourcesPath, 'adb', 'adb.exe');
if (app.isPackaged && existsSync(bundledAdb)) process.env.STORAGE_TREE_BUNDLED_ADB = bundledAdb;
// Only the installed app leaves "(dev)" out of the page and window title (GET /api/version `dev`).
if (app.isPackaged) process.env.STORAGE_TREE_INSTALLED = '1';

let win = null;

/** The first port from `port` that nothing else listens on (the page's saved settings are per port, so it stays put when free). */
function freePort(port, tries = 20) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => (tries > 1 ? freePort(port + 1, tries - 1).then(resolve, reject) : reject(new Error(`No free port from ${port}`))));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
  });
}

function openWindow(address, runningTasks) {
  const origin = new URL(address).origin;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: app.isPackaged ? NAME : `${NAME} (dev)`,
    backgroundColor: '#f4f6f5',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (linkAction(url, origin) === 'browser') shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const action = linkAction(url, origin);
    if (action === 'app') return;
    event.preventDefault();
    if (action === 'browser') shell.openExternal(url);
  });
  win.webContents.on('before-input-event', (event, input) => {
    const key = windowKey(input);
    if (key === 'reload') win.webContents.reload();
    else if (key === 'devtools') win.webContents.toggleDevTools();
    if (key) event.preventDefault();
  });
  // Copies run in this process: closing the window stops them, so ask first.
  win.on('close', (event) => {
    const running = runningTasks();
    if (!running.length) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: NAME,
      buttons: ['Keep copying', 'Close and stop'],
      defaultId: 0,
      cancelId: 0,
      message: `${running.length} ${running.length === 1 ? 'copy is' : 'copies are'} still running`,
      detail: `Closing the app stops ${running.length === 1 ? 'it' : 'them'}; files not yet copied are left out:\n${running.map((t) => t.label).join('\n')}`,
    });
    if (choice === 0) event.preventDefault();
  });
  win.on('closed', () => { win = null; });
  win.loadURL(address);
}

async function start() {
  Menu.setApplicationMenu(null);
  const { createApp } = await import('../server.js');
  const { runningTasks } = await import('../lib/tasks.js');
  const port = await freePort(PORT);
  const server = createApp({ port });
  server.listen(port, '127.0.0.1', () => openWindow(`http://127.0.0.1:${port}/`, runningTasks));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox(NAME, `The app couldn’t start:\n${err.stack ?? err.message}`);
    app.exit(1);
  });
}
