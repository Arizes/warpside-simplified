/**
 * Where the JSON API lives, as a prefix for `/api/...` paths.
 *
 * In production Cloudflare serves this page and Railway serves the API, so the two are different
 * origins and the page needs an absolute base (`<meta name="api-base">`). A local run serves both
 * from one process, so same-origin wins there and the meta tag is ignored; that keeps `npm start`
 * and `npm run dev` working from the same files that ship to Cloudflare.
 *
 * The meta tag is page content, so it is validated rather than trusted: only a plain https origin
 * is accepted, and anything else falls back to same-origin.
 */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;
const ORIGIN = /^https:\/\/[a-z0-9][a-z0-9.-]*[a-z0-9](:\d{1,5})?$/i;

export function apiBase(hostname, metaContent) {
  if (LOCAL.test(String(hostname || ''))) return '';
  const value = String(metaContent || '').trim().replace(/\/+$/, '');
  return ORIGIN.test(value) ? value : '';
}
