// E9 (1.6.1): cross-site request guard for every POST.
//
// The server listens on 127.0.0.1, but any web page open in the same browser
// can still send it a "simple" cross-site POST (text/plain, no preflight),
// and readBody parses JSON whatever the content-type says. So a page could
// post {"ids":[1,2,3]} to /api/os/recycle. Two checks close that:
//   1. A POST must declare a non-simple content-type: application/json, or
//      application/octet-stream for the .xlsx import. Browsers will not send
//      those cross-site without a CORS preflight, which this server never
//      answers, so the request never leaves the browser.
//   2. When the browser sends an Origin header, it must be this app's own
//      origin (its host matches the Host header, or a proxy's forwarded host,
//      or an entry in config.json "allowedOrigins").
// Returns '' when the request may proceed, or the reason it may not.
export function postGuard(req, { allowedOrigins = [] } = {}) {
  const h = req.headers || {};
  const url = String(req.url || '');
  const ct = String(h['content-type'] || '').split(';')[0].trim().toLowerCase();
  const want = url.split('?')[0] === '/api/import/xlsx' ? 'application/octet-stream' : 'application/json';
  if (ct !== want) return `POST needs content-type ${want}`;
  const origin = h.origin;
  if (origin !== undefined) {
    if (allowedOrigins.includes(origin)) return '';
    let host = '';
    try { host = new URL(origin).host.toLowerCase(); } catch { return 'cross-site request refused'; }
    const own = [h.host, h['x-forwarded-host']].filter(Boolean).map(x => String(x).split(',')[0].trim().toLowerCase());
    if (!own.includes(host)) return 'cross-site request refused';
  }
  return '';
}
