// The app's server: runs on this PC only (127.0.0.1), serves the page from
// public/ and the API from api/. Start it with `npm start`; it opens a Chrome
// app window.

process.env.UV_THREADPOOL_SIZE ??= '16'; // more file-system calls at once for local scans; set before any are made

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { allowed, fail, route } from './lib/http.js';
import * as sources from './api/sources.js';
import * as scans from './api/scans.js';
import * as tasks from './api/tasks.js';
import * as browse from './api/browse.js';
import { homedir } from 'node:os';

export const PORT = Number(process.env.PORT) || 8850;
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// Every copy but the installed app is a development copy (`npm start`, `npm run app`): the page then says "(dev)" in its title.
export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const ROUTES = [
  ['GET', '/api/version', () => ({ status: 200, body: { version: VERSION, downloads: join(homedir(), 'Downloads'), app: Boolean(process.versions.electron), dev: !process.env.STORAGE_TREE_INSTALLED } })],
  ['GET', '/api/drives', sources.drives],
  ['GET', '/api/devices', sources.devices],
  ['GET', '/api/devices/:serial/storage', sources.storage],
  ['POST', '/api/wireless/pair', sources.pair],
  ['POST', '/api/wireless/connect', sources.connect],
  ['POST', '/api/wireless/disconnect', sources.disconnect],
  ['POST', '/api/scans', scans.create],
  ['GET', '/api/scans/:id', scans.status],
  ['POST', '/api/scans/:id/cancel', scans.cancel],
  ['DELETE', '/api/scans/:id', scans.remove],
  ['GET', '/api/scans/:id/nodes/:nid', scans.node],
  ['GET', '/api/scans/:id/largest', scans.largest],
  ['GET', '/api/scans/:id/types', scans.types],
  ['POST', '/api/scans/:id/reveal', scans.reveal],
  ['POST', '/api/scans/:id/delete', scans.removeItem],
  ['POST', '/api/scans/:id/protected', scans.readProtected],
  ['POST', '/api/scans/:id/pull', scans.pull],
  ['GET', '/api/scans/:id/file', scans.file],
  ['GET', '/api/browse/places', browse.places],
  ['POST', '/api/browse', browse.list],
  ['GET', '/api/browse/:id/media', browse.media],
  ['POST', '/api/browse/:id/thumbs', browse.thumbs],
  ['GET', '/api/browse/:id/file', browse.file],
  ['POST', '/api/browse/:id/open', browse.open],
  ['POST', '/api/browse/:id/measure', browse.measure],
  ['POST', '/api/browse/:id/pull', browse.pull],
  ['POST', '/api/browse/:id/delete', browse.remove],
  ['GET', '/api/tasks', tasks.list],
  ['POST', '/api/tasks/:id/cancel', tasks.cancel],
  ['POST', '/api/tasks/:id/reveal', tasks.reveal],
  ['DELETE', '/api/tasks/:id', tasks.dismiss],
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY });
  createReadStream(file).pipe(res);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) return null; // thousands of selected names fit
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function createApp({ port = PORT } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (!allowed(req.headers, req.method, port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const hit = route(ROUTES, req.method, url.pathname);
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : null;
        const out = hit ? await hit.handler({ params: hit.params, query: url.searchParams, body }) : fail(404, 'no-route', 'No such API route.');
        if (out.raw) return out.raw(res); // a file's bytes, streamed
        res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(out.body));
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') return sendStatic(res, url.pathname);
      res.writeHead(405).end();
    } catch (err) {
      console.error(req.method, url.pathname, err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'server', message: err?.message ?? String(err) }));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));
  const server = createApp();
  server.listen(PORT, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${PORT}/`;
    console.log(`Storage Tree ${VERSION} running at ${address}`);
    if (process.argv.includes('--open') && existsSync(CHROME)) {
      spawn(CHROME, [`--app=${address}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}
