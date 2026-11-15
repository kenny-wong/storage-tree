// Copies adb (Android platform-tools) into build/adb/, which the installer
// ships as resources/adb, so the installed app works without installing
// platform-tools first. Run by `npm run dist`. PLATFORM_TOOLS picks a folder;
// otherwise the app's own search finds one (the Android SDK on this PC).
// adb is open source (Apache 2.0); NOTICE.txt with its licences goes with it.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAdb } from '../lib/adb.js';

const out = fileURLToPath(new URL('../build/adb/', import.meta.url));
const env = { ...process.env, ADB: undefined, STORAGE_TREE_BUNDLED_ADB: undefined };
const from = process.env.PLATFORM_TOOLS || (findAdb(env) && dirname(findAdb(env)));
if (!from || !existsSync(join(from, 'adb.exe'))) {
  console.error('adb.exe not found: install platform-tools (winget install Google.PlatformTools) or set PLATFORM_TOOLS to its folder.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'libwinpthread-1.dll', 'NOTICE.txt', 'source.properties']) {
  if (existsSync(join(from, name))) copyFileSync(join(from, name), join(out, name));
  else if (name.endsWith('.exe') || name.startsWith('AdbWin')) {
    console.error(`${name} is missing from ${from}.`);
    process.exit(1);
  }
}
const rev = existsSync(join(out, 'source.properties')) ? /Pkg\.Revision=(\S+)/.exec(readFileSync(join(out, 'source.properties'), 'utf8'))?.[1] : null;
console.log(`adb${rev ? ` ${rev}` : ''} from ${from} copied to ${out}`);
