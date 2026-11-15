// Small helpers for the API routes in api/: answers are { status, body } objects
// that the server turns into JSON responses.

export const ok = (body, status = 200) => ({ status, body });

/** An error the page can show: a short `error` code and a sentence for people. */
export const fail = (status, error, message = '') => ({ status, body: { error, message } });

/** A positive whole-number id from a route parameter, or null. */
export const idParam = (v) => (/^\d{1,9}$/.test(v ?? '') && Number(v) >= 0 ? Number(v) : null);

/** Only this PC's own pages may use the API: the Host must be ours, and writes must come from our Origin. */
export function allowed(headers, method, port) {
  const ours = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!ours.includes(headers.host)) return false;
  if (method !== 'GET' && method !== 'HEAD' && headers.origin && !ours.map((h) => `http://${h}`).includes(headers.origin)) return false;
  return true;
}

/** Matches "GET /api/scans/12" against a list of [method, '/api/scans/:id', handler]. */
export function route(routes, method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    const hit = re.exec(pathname);
    if (hit) return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])])) };
  }
  return null;
}
