import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFiles, github, isVersion, privateLines, releaseNotes, sha256, wordList } from '../scripts/release-lib.mjs';

test('release notes: what is new first, then install, hash and adb version', () => {
  const n = releaseNotes({ version: '1.8.0', whatsNew: '\nNew things.\n\n', hash: 'abc123', adb: '37.0.1' });
  assert.ok(n.startsWith('New things.\n\n## Install'));
  assert.match(n, /\*\*Storage-Tree-Setup-1\.8\.0\.exe\*\*/);
  assert.match(n, /SHA-256: `abc123`/);
  assert.match(n, /Platform-Tools 37\.0\.1\./);
  assert.match(releaseNotes({ version: '1.8.0', whatsNew: 'x', hash: 'h', adb: null }), /Platform-Tools\. Its/);
});

test('versions are x.y.z', () => {
  for (const v of ['1.8.0', '10.20.30']) assert.ok(isVersion(v));
  for (const v of ['1.8', 'v1.8.0', '1.8.0-beta', '', undefined]) assert.ok(!isVersion(v));
});

test('private words and keys are found, and not repeated', () => {
  assert.deepEqual(wordList('# list\nsecret name\r\n\n other \n'), ['secret name', 'other']);
  const key = `ghp_${'a'.repeat(36)}`;
  const found = privateLines(`fine\nthe SECRET Name here\ntoken = ${key}\nfine`, ['secret name']);
  assert.deepEqual(found, [{ line: 2, what: 'a private word' }, { line: 3, what: 'what looks like a key' }]);
  assert.ok(!JSON.stringify(found).includes(key));
  assert.equal(privateLines(`-----BEGIN RSA PRIVATE ${'KEY'}-----`, []).length, 1);
  assert.deepEqual(privateLines('nothing here', ['secret']), []);
});

const files = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));

test('packaged files are compared with the commit, whatever the line endings', () => {
  const pkg = (o) => JSON.stringify({ name: 'a', version: '1.8.0', main: 'm.js', ...o });
  const commit = files({ 'server.js': 'one\ntwo\n', 'package.json': pkg({ scripts: { test: 'x' } }) });
  assert.deepEqual(compareFiles(files({ 'server.js': 'one\r\ntwo\r\n', 'package.json': pkg() }), commit), []);
  assert.deepEqual(compareFiles(files({ 'server.js': 'one\nTWO\n', 'package.json': pkg({ version: '1.7.0' }), 'extra.js': '' }), commit),
    ['server.js differs from the commit', 'package.json: version is 1.7.0, the commit says 1.8.0', 'extra.js is in the app but not in the commit']);
  assert.deepEqual(compareFiles(files({ 'package.json': pkg() }), commit), ['server.js is missing from the app']);
});

/** A stand-in for GitHub: answers by "METHOD path" and keeps what it was asked. */
function fakeGitHub(answers) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method ?? 'GET'} ${u.pathname.replace('/repos/kenny-wong/storage-tree', '')}`;
    calls.push({ key, url, opts });
    const [status, body] = answers[key] ?? [404, { message: 'Not Found' }];
    return { ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

const data = Buffer.from('installer');
const draft = [201, { id: 5, upload_url: 'https://uploads.github.com/up/5/assets{?name,label}' }];
const release = { version: '1.8.0', commit: 'c0ffee', notes: 'notes', data };

test('publishing: draft, upload, check, and only then public', async () => {
  const gh = fakeGitHub({
    'POST /releases': draft,
    'POST /up/5/assets': [201, { size: data.length, digest: `sha256:${sha256(data)}` }],
    'PATCH /releases/5': [200, { html_url: 'https://example.test/r' }],
  });
  assert.equal((await github('t0k', gh.fetch).publish(release)).html_url, 'https://example.test/r');
  assert.deepEqual(gh.calls.map((c) => c.key), ['POST /releases', 'POST /up/5/assets', 'PATCH /releases/5']);
  const made = JSON.parse(gh.calls[0].opts.body);
  assert.equal(made.draft, true);
  assert.equal(made.tag_name, 'v1.8.0');
  assert.equal(made.target_commitish, 'c0ffee');
  assert.equal(gh.calls[1].url, 'https://uploads.github.com/up/5/assets?name=Storage-Tree-Setup-1.8.0.exe');
  assert.equal(JSON.parse(gh.calls[2].opts.body).draft, false);
});

test('a bad or failed upload is never published, and its draft is deleted', async () => {
  for (const upload of [[201, { size: data.length, digest: 'sha256:other' }], [201, { size: 3, digest: `sha256:${sha256(data)}` }], [201, { size: data.length }], [502, { message: 'down' }]]) {
    const gh = fakeGitHub({ 'POST /releases': draft, 'POST /up/5/assets': upload, 'DELETE /releases/5': [204, null] });
    await assert.rejects(github('t0k', gh.fetch).publish(release), (err) => !err.message.includes('t0k') && !/could not be deleted/.test(err.message));
    assert.deepEqual(gh.calls.map((c) => c.key), ['POST /releases', 'POST /up/5/assets', 'DELETE /releases/5']);
  }
});

test('a draft that can’t be deleted is mentioned', async () => {
  const gh = fakeGitHub({ 'POST /releases': draft, 'POST /up/5/assets': [500, {}], 'DELETE /releases/5': [500, {}] });
  await assert.rejects(github('t0k', gh.fetch).publish(release), /could not be deleted/);
});

test('an existing release or draft of the version is found', async () => {
  const pub = fakeGitHub({ 'GET /releases/tags/v1.8.0': [200, { tag_name: 'v1.8.0', draft: false }] });
  assert.equal((await github('t', pub.fetch).find('1.8.0')).draft, false);
  const dr = fakeGitHub({ 'GET /releases': [200, [{ tag_name: 'v1.7.0' }, { tag_name: 'v1.8.0', draft: true }]] });
  assert.equal((await github('t', dr.fetch).find('1.8.0')).draft, true);
  const none = fakeGitHub({ 'GET /releases': [200, []] });
  assert.equal(await github('t', none.fetch).find('1.8.0'), null);
  const broken = fakeGitHub({ 'GET /releases/tags/v1.8.0': [401, { message: 'Bad credentials' }] });
  await assert.rejects(github('t', broken.fetch).find('1.8.0'), /401/);
});
