// Local preview with the real inquiry handler. Without mail credentials the UI
// uses the email fallback. This never pretends to be the product API or edge gate.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import contact from '../../api/contact.js';
import { legacyRedirects } from '../content/pages.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.otf': 'font/otf', '.xml': 'application/xml', '.txt': 'text/plain', '.md': 'text/plain; charset=utf-8' };
const server = createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (path.startsWith('/api/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (path === '/api/contact') return contact(req, res);
  if (path === '/app' || path.startsWith('/app/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow, nosnippet');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  const legacyTarget = legacyRedirects[path.replace(/\.html$/, '')];
  if (legacyTarget) {
    const destination = new URL(legacyTarget, 'http://localhost');
    res.writeHead(308, { Location: destination.pathname + new URL(req.url, 'http://localhost').search + destination.hash });
    res.end();
    return;
  }
  let file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
  try {
    // Vercel cleanUrls also accepts an old .html URL for an existing page.
    if (path.endsWith('.html') && !path.endsWith('/index.html')) {
      const clean = path.slice(0, -5);
      await stat(resolve(root, '.' + clean, 'index.html'));
      res.writeHead(308, { Location: clean + new URL(req.url, 'http://localhost').search });
      res.end();
      return;
    }
    const info = await stat(file);
    let canonicalPath = path;
    if (info.isDirectory()) {
      file = resolve(file, 'index.html');
      if (path !== '/') canonicalPath = path.replace(/\/+$/, '');
    } else if (path.endsWith('/index.html')) {
      canonicalPath = path.slice(0, -11) || '/';
    }
    if (canonicalPath !== path) {
      res.writeHead(308, { Location: canonicalPath + new URL(req.url, 'http://localhost').search });
      res.end();
      return;
    }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found</title><p>Page not found. <a href="/">Return to INRSettle</a></p></html>'); }
});
server.listen(Number(process.env.PORT || 8080), '127.0.0.1', () => console.log('INRSettle preview: http://127.0.0.1:' + server.address().port));
