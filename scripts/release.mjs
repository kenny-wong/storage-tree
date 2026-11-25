// Builds, checks and publishes a release on GitHub:
//
//   npm run release                 builds and checks everything, sends nothing
//   npm run release:publish         the same, then publishes it
//
// Before that: set the version, write what is new in docs/releases/<version>.md,
// commit, and push (the release's tag is put on that commit).
//
// Words that must never be published can be listed, one per line, in
// .git/info/private-words, which is not part of the repo.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFiles, github, isVersion, privateLines, releaseNotes, REPO, setupName, sha256, wordList } from './release-lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const UNPACKED = join(ROOT, 'dist', 'win-unpacked');
const args = process.argv.slice(2);
const PUBLISH = args.includes('--publish');

class Stop extends Error {}
const stop = (message) => { throw new Stop(message); };
const step = (text) => console.log(`\n» ${text}`);
const good = (text) => console.log(`  ok  ${text}`);
const note = (text) => console.log(`  !   ${text}`);
/** A problem that stops a release but not a trial run. */
const must = (text) => (PUBLISH ? stop(text) : note(`${text} (publishing would stop here)`));

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitFile = (path) => execFileSync('git', ['show', `HEAD:${path}`], { cwd: ROOT, maxBuffer: 64e6 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function filesIn(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesIn(p, base, out);
    else out.push(relative(base, p).replaceAll('\\', '/'));
  }
  return out;
}

function checkText(name, text, words) {
  const bad = privateLines(text, words);
  if (bad.length) stop(`${name} has ${bad[0].what} on line ${bad[0].line}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}`);
}

function run(title, command) {
  const r = spawnSync(command, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64e6 });
  if (r.status !== 0) {
    console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').slice(-40).join('\n'));
    stop(`${title} failed`);
  }
  return r.stdout;
}

function token() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env: { ...process.env, GCM_INTERACTIVE: 'never' }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const t = /^password=(.+)$/m.exec(out)?.[1].trim();
    if (t) return t;
  } catch { /* said below, without git's output */ }
  return stop('git has no saved login for github.com');
}

const listening = (port) => new Promise((resolve) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

/** Starts the packaged app with its own empty data folder (so a running installed copy is left alone) and asks it its version. */
async function startApp(version) {
  const ports = Array.from({ length: 20 }, (_, i) => 8851 + i);
  const busy = new Set();
  for (const p of ports) if (await listening(p)) busy.add(p);
  const mine = ports.find((p) => !busy.has(p)); // the app takes the first free one
  const data = mkdtempSync(join(tmpdir(), 'storage-tree-release-'));
  const env = { ...process.env, LOCALAPPDATA: data };
  delete env.ELECTRON_RUN_AS_NODE; // VS Code's terminal sets it, and the app would start as plain Node
  const child = spawn(join(UNPACKED, 'Storage Tree.exe'), { env, stdio: 'ignore' });
  let failed = null;
  child.on('error', (err) => { failed = err.message; });
  try {
    for (let i = 0; i < 60 && !failed; i++) {
      const v = await fetch(`http://127.0.0.1:${mine}/api/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
      if (v) {
        if (v.version !== version || v.dev || !v.app) stop(`the packaged app answered ${JSON.stringify({ version: v.version, dev: v.dev, app: v.app })}`);
        return;
      }
      await sleep(500);
    }
    stop(`the packaged app did not start${failed ? `: ${failed}` : ''}`);
  } finally {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    await sleep(1000);
    try { rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { note(`left behind: ${data}`); }
  }
}

/** Unpacks the installer and compares it with dist/win-unpacked, file by file. False when there is no 7-Zip that can. */
function checkInstaller(setup) {
  const sevenZip = [join(process.env.ProgramFiles ?? '', '7-Zip', '7z.exe'), join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe')].find((p) => existsSync(p));
  if (!sevenZip) return false;
  const dir = mkdtempSync(join(tmpdir(), 'storage-tree-setup-'));
  try {
    const unzip = (file, to) => spawnSync(sevenZip, ['x', '-y', `-o${to}`, file], { stdio: 'ignore' }).status === 0;
    const inner = join(dir, 'setup', '$PLUGINSDIR', 'app-64.7z');
    if (!unzip(setup, join(dir, 'setup')) || !existsSync(inner) || !unzip(inner, join(dir, 'app'))) return false;
    const [a, b] = [filesIn(join(dir, 'app')).sort(), filesIn(UNPACKED).sort()];
    if (a.join('\n') !== b.join('\n')) stop('the installer does not hold the same files as dist/win-unpacked');
    for (const f of a) if (sha256(readFileSync(join(dir, 'app', f))) !== sha256(readFileSync(join(UNPACKED, f)))) stop(`${f} in the installer differs from dist/win-unpacked`);
    return a.length;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

/** The files inside app.asar, as path -> Buffer. */
async function packedFiles() {
  const { listPackage, extractFile, statFile } = await import('@electron/asar').then((m) => ({ ...m.default, ...m })); // comes with electron-builder
  const asar = join(UNPACKED, 'resources', 'app.asar');
  const out = new Map();
  for (const entry of listPackage(asar)) {
    const p = entry.replace(/^[\\/]/, '');
    if (!('files' in statFile(asar, p))) out.set(p.replaceAll('\\', '/'), extractFile(asar, p));
  }
  return out;
}

async function main() {
  const unknown = args.find((a) => a !== '--publish');
  if (unknown) stop(`unknown option ${unknown}`);
  if (process.platform !== 'win32') stop('the installer can only be built and tried on Windows');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const { version } = pkg;
  if (!isVersion(version)) stop(`"${version}" in package.json is not a version like 1.8.0`);
  const tag = `v${version}`;
  console.log(`Storage Tree ${version}: ${PUBLISH ? 'build, check and PUBLISH' : 'build and check only (nothing is sent)'}`);

  step('The repo');
  if (JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).version !== version) stop('package-lock.json has another version: run npm install --package-lock-only');
  const notesFile = `docs/releases/${version}.md`;
  if (!existsSync(join(ROOT, notesFile))) stop(`write what is new in ${notesFile} first`);
  if (git('status', '--porcelain')) must('there are changes that are not committed');
  else good('everything is committed');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') must(`this is the branch ${branch}, not main`);
  git('fetch', '--quiet', 'origin');
  const commit = git('rev-parse', 'HEAD');
  if (commit !== git('rev-parse', 'origin/main')) must('HEAD is not what GitHub has as main: push first');
  else good(`${commit.slice(0, 7)} is on GitHub`);

  const api = PUBLISH ? github(token()) : null;
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) must(`${tag} is on GitHub already: use a new version`);
  else if (api) {
    const old = await api.find(version);
    if (old) stop(`GitHub has a ${old.draft ? 'draft' : 'release'} of ${tag} already: ${old.html_url}`);
  }

  step('Text that must not be published');
  const wordsFile = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'private-words');
  const words = existsSync(wordsFile) ? wordList(readFileSync(wordsFile, 'utf8')) : [];
  if (!words.length) must('no private words are listed in .git/info/private-words, so none are searched for');
  const tracked = git('ls-files').split('\n');
  for (const f of tracked) {
    if (/(^|\/)(\.env|\.dev\.vars)/.test(f)) stop(`${f} must not be in the repo`);
    if (!/\.(png|ico)$/i.test(f) && existsSync(join(ROOT, f))) checkText(f, readFileSync(join(ROOT, f), 'utf8'), words);
  }
  good(`${tracked.length} files, ${words.length} private words`);

  step('Tests');
  good(`${/pass (\d+)/.exec(run('npm test', 'npm test'))?.[1] ?? '?'} passed`);

  step('Building the installer (a minute or two)');
  const setup = join(ROOT, 'dist', setupName(version));
  for (const f of [setup, `${setup}.blockmap`]) rmSync(f, { force: true });
  rmSync(UNPACKED, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  run('npm run dist', 'npm run dist');
  if (!existsSync(setup)) stop(`${setup} was not made`);
  good(`${setupName(version)}, ${Math.round(statSync(setup).size / 1e6)} MB`);

  step('What is in it');
  const packed = await packedFiles();
  const committed = new Map(git('ls-files', 'package.json', 'server.js', 'LICENSE', 'electron', 'api', 'lib', 'public').split('\n').map((f) => [f, gitFile(f)]));
  const problems = compareFiles(packed, committed);
  if (problems.length) must(`the app is not what is committed: ${problems.slice(0, 5).join('; ')}`);
  else good(`all ${packed.size} app files match the commit`);
  for (const [f, data] of packed) checkText(`app.asar/${f}`, data.toString('utf8'), words);
  for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll', 'NOTICE.txt']) if (!existsSync(join(UNPACKED, 'resources', 'adb', f))) stop(`adb's ${f} is missing`);
  const same = checkInstaller(setup);
  if (same) good(`the installer holds the same ${same} files`);
  else note('no 7-Zip that can open the installer, so its inside was not compared');
  await startApp(version);
  good(`the app starts and says ${version}`);

  step('Release notes');
  const data = readFileSync(setup);
  const props = join(UNPACKED, 'resources', 'adb', 'source.properties');
  const adb = existsSync(props) ? /Pkg\.Revision=(\S+)/.exec(readFileSync(props, 'utf8'))?.[1] : null;
  const notes = releaseNotes({ version, whatsNew: readFileSync(join(ROOT, notesFile), 'utf8').replace(/\r/g, ''), hash: sha256(data), adb });
  checkText('the release notes', notes, words);
  const notesOut = join(ROOT, 'dist', `release-notes-${version}.md`);
  writeFileSync(notesOut, notes);
  good(`written to ${notesOut}`);
  good(`SHA-256 ${sha256(data)}`);

  if (!PUBLISH) {
    console.log(`\nNothing was sent. To publish: npm run release:publish`);
    return;
  }

  step('Publishing');
  const rel = await api.publish({ version, commit, notes, data });
  good(rel.html_url);

  step('What people get');
  const problemsAfter = [];
  const dl = await fetch(`https://github.com/${REPO}/releases/download/${tag}/${setupName(version)}`);
  if (!dl.ok || sha256(Buffer.from(await dl.arrayBuffer())) !== sha256(data)) problemsAfter.push(`the public download is not the installer that was built (answer ${dl.status})`);
  if (!git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`).startsWith(commit)) problemsAfter.push(`the tag ${tag} is not on ${commit.slice(0, 7)}`);
  if (problemsAfter.length) stop(`PUBLISHED, but: ${problemsAfter.join('; ')}. Look at ${rel.html_url}`);
  good('the public download has the same SHA-256');
  good(`${tag} is on ${commit.slice(0, 7)}`);
  git('fetch', '--quiet', '--tags', 'origin');
}

main().catch((err) => {
  console.error(`\nStopped: ${err instanceof Stop ? err.message : err.stack ?? err}`);
  process.exitCode = 1;
});
