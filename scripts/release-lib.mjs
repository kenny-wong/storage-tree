// The parts of scripts/release.mjs that need no build and no network, so they
// are unit tested: the release notes, the checks on text, and the calls to
// GitHub's API (fetch is passed in).

import { createHash } from 'node:crypto';

export const REPO = 'kenny-wong/storage-tree';
export const setupName = (version) => `Storage-Tree-Setup-${version}.exe`;
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** x.y.z only. */
export const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(v ?? '');

/** The release's text: what is new (written by hand for each version), then the parts that are always the same. */
export function releaseNotes({ version, whatsNew, hash, adb }) {
  return `${whatsNew.trim()}

## Install

1. Download **${setupName(version)}** below and run it. It installs for your Windows account only.
2. The installer isn't code-signed, so Windows may show "Windows protected your PC". Click **More info → Run anyway**.
3. Open **Storage Tree** from the Start menu or the desktop shortcut.

**Needs:** Windows 10 or 11 (64-bit). adb, which reads the phone, comes with the installer. For a phone, turn on USB debugging or Wireless debugging first; the [README](https://github.com/${REPO}#phones) has the steps.

There are no automatic updates: download a newer installer from Releases and run it over the old one.

## Check the download

SHA-256: \`${hash}\`

## Included software

adb from Android SDK Platform-Tools${adb ? ` ${adb}` : ''}. Its licences (Apache 2.0 and others) are in \`resources\\adb\\NOTICE.txt\` in the install folder. Electron's and Chromium's licences are in the install folder too.
`;
}

/** "word one\n# comment\n" -> ['word one'] */
export const wordList = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** What must not be published in `text`: which lines hold a private word or something that looks like a key. The word or key itself is not repeated. */
export function privateLines(text, words) {
  const low = words.map((w) => w.toLowerCase());
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const l = line.toLowerCase();
    if (low.some((w) => l.includes(w))) out.push({ line: i + 1, what: 'a private word' });
    else if (TOKENS.test(line)) out.push({ line: i + 1, what: 'what looks like a key' });
  });
  return out;
}

/** The same text whatever the line endings (the working copy has CRLF, git has LF). */
const plain = (data) => Buffer.from(data.toString('latin1').replace(/\r/g, ''), 'latin1');

/**
 * Compares the packaged app's files with the commit's. Both are Maps of
 * path -> Buffer. package.json is compared by version, name and entry point
 * only, because electron-builder takes the scripts out of it.
 */
export function compareFiles(packed, committed) {
  const problems = [];
  for (const [path, data] of packed) {
    const want = committed.get(path);
    if (!want) problems.push(`${path} is in the app but not in the commit`);
    else if (path === 'package.json') {
      const [a, b] = [JSON.parse(data), JSON.parse(want)];
      for (const k of ['name', 'version', 'main']) if (a[k] !== b[k]) problems.push(`package.json: ${k} is ${a[k]}, the commit says ${b[k]}`);
    } else if (!plain(data).equals(plain(want))) problems.push(`${path} differs from the commit`);
  }
  for (const path of committed.keys()) if (!packed.has(path)) problems.push(`${path} is missing from the app`);
  return problems;
}

/** Calls to GitHub's API for one repo. Errors carry GitHub's answer, never the token. */
export function github(token, fetch = globalThis.fetch) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'release-script', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = `https://api.github.com/repos/${REPO}`;
  async function call(url, { missing = false, ...opts } = {}) {
    const res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
    const text = await res.text();
    if (missing && res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub answered ${res.status} to ${opts.method ?? 'GET'} ${url.split('?')[0]}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    /** The release of this version, or an unfinished draft of it, or null. */
    async find(version) {
      const tag = `v${version}`;
      return (await call(`${api}/releases/tags/${tag}`, { missing: true }))
        ?? (await call(`${api}/releases?per_page=100`)).find((r) => r.tag_name === tag) ?? null;
    },
    /**
     * Makes a draft, uploads the installer, checks that GitHub has the same
     * bytes, and only then publishes. If anything before that fails, the
     * draft made here is deleted again.
     */
    async publish({ version, commit, notes, data }) {
      const hash = sha256(data);
      const draft = await call(`${api}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: `v${version}`, target_commitish: commit, name: `Storage Tree ${version}`, body: notes, draft: true }) });
      try {
        const asset = await call(`${draft.upload_url.replace(/\{.*/, '')}?name=${encodeURIComponent(setupName(version))}`, { method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' } });
        if (asset.size !== data.length || asset.digest !== `sha256:${hash}`) throw new Error(`GitHub has ${asset.size} bytes, ${asset.digest}; the installer is ${data.length} bytes, sha256:${hash}`);
      } catch (err) {
        await call(`${api}/releases/${draft.id}`, { method: 'DELETE' }).catch((e) => { err.message += ` (and the draft could not be deleted: ${e.message})`; });
        throw err;
      }
      return call(`${api}/releases/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) });
    },
  };
}
