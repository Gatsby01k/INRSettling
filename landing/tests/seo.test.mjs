import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const repo = new URL('../../', import.meta.url);
const origin = 'https://www.inrsettle.com';
const paths = ['/', '/developers', '/docs', '/docs/integration', '/docs/reconciliation', '/security', '/privacy'];
let preview;
let base;
const documents = new Map();

before(async () => {
  preview = spawn(process.execPath, ['landing/scripts/serve-site.mjs'], {
    cwd: repo, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 10000);
    preview.stderr.on('data', data => { errors += data; });
    preview.once('error', error => { clearTimeout(timer); reject(error); });
    preview.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}: ${errors}`)); });
    preview.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  for (const path of paths) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    documents.set(path, await response.text());
  }
});

after(() => { preview?.kill(); });

function meta(html, kind, key) {
  return [...html.matchAll(/<meta\b[^>]*>/g)].filter(([tag]) => tag.includes(`${kind}="${key}"`))
    .map(([tag]) => tag.match(/content="([^"]*)"/)[1]);
}

test('public pages serve unique searchable titles and canonical metadata before JavaScript', () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const [path, html] of documents) {
    const matches = [...html.matchAll(/<title>([^<]+)<\/title>/g)];
    assert.equal(matches.length, 1, path);
    titles.add(matches[0][1]);
    const description = meta(html, 'name', 'description');
    assert.equal(description.length, 1, path);
    descriptions.add(description[0]);
    const canonical = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
    assert.equal(canonical.length, 1, path);
    assert.equal(canonical[0][1], origin + path);
    assert.equal(meta(html, 'property', 'og:url')[0], canonical[0][1]);
    assert.match(meta(html, 'name', 'robots')[0], /^index, follow/);
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1, path);
    assert.match(html, /<html lang="en">/);
  }
  assert.equal(titles.size, paths.length);
  assert.equal(descriptions.size, paths.length);
});

test('site identity and breadcrumbs contain valid, consistent JSON-LD', () => {
  for (const [path, html] of documents) {
    const match = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
    assert.ok(match, path);
    const schema = JSON.parse(match[1]);
    assert.equal(schema['@context'], 'https://schema.org');
    const website = schema['@graph'].find(item => item['@type'] === 'WebSite');
    const organization = schema['@graph'].find(item => item['@type'] === 'Organization');
    assert.equal(website.name, 'INRSettle');
    assert.equal(website.url, origin + '/');
    assert.equal(organization.email, 'info@inrsettle.com');
    assert.ok(organization.logo.url.startsWith(origin + '/assets/'));
    if (path !== '/') {
      const crumbs = schema['@graph'].find(item => item['@type'] === 'BreadcrumbList');
      assert.equal(crumbs.itemListElement.at(-1).item, origin + path);
      assert.equal(crumbs.itemListElement[0].position, 1);
    }
    assert.ok(!schema['@graph'].some(item => item.aggregateRating || item['@type'] === 'SearchAction'));
  }
});

test('sitemap lists only canonical public pages and robots allows noindex to be seen', async () => {
  const response = await fetch(base + '/sitemap.xml');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/xml/);
  const sitemap = await response.text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.deepEqual(urls.sort(), paths.map(path => origin + path).sort());
  assert.match(sitemap, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
  const robotsResponse = await fetch(base + '/robots.txt');
  assert.equal(robotsResponse.status, 200);
  const robots = await robotsResponse.text();
  assert.match(robots, /Sitemap: https:\/\/www\.inrsettle\.com\/sitemap\.xml/);
  assert.ok(!/Disallow:\s*\/app/.test(robots));
});

test('social previews reference a publicly readable 1200 × 630 PNG', async () => {
  const images = new Set();
  for (const html of documents.values()) {
    assert.equal(meta(html, 'name', 'twitter:card')[0], 'summary_large_image');
    assert.equal(meta(html, 'property', 'og:image:width')[0], '1200');
    assert.equal(meta(html, 'property', 'og:image:height')[0], '630');
    const image = meta(html, 'property', 'og:image')[0];
    assert.equal(meta(html, 'name', 'twitter:image')[0], image);
    images.add(new URL(image).pathname);
  }
  for (const path of images) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.ok(png.length < 500000, 'keep the sharing asset lightweight');
  }
});

test('demo responses stay noindex when the preview access code is unset', async () => {
  for (const path of ['/app', '/app/workspace.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    if (path === '/app') assert.match(await response.text(), /name="robots" content="noindex, nofollow, nosnippet"/);
  }
  assert.match(documents.get('/'), /class="dashboard"[^>]*data-nosnippet/);
});

test('resource links and their fragments resolve to real pages', async () => {
  for (const [path, html] of documents) {
    for (const [, href] of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      if (!href.startsWith('/') && !href.startsWith('#')) continue;
      const link = new URL(href, origin + path);
      const destination = documents.get(link.pathname);
      if (destination) {
        if (link.hash) assert.ok(destination.includes(`id="${link.hash.slice(1)}"`), `${path} → ${href}`);
      } else {
        assert.equal((await fetch(base + link.pathname)).status, 200, `${path} → ${href}`);
      }
    }
  }
});

test('known duplicate URLs redirect while missing pages retain a real 404', async () => {
  for (const [source, target] of [['/index.html', '/'], ['/docs/', '/docs'], ['/docs/index.html', '/docs'], ['/docs/integration/', '/docs/integration']]) {
    const response = await fetch(base + source + '?ref=test', { redirect: 'manual' });
    assert.equal(response.status, 308, source);
    assert.equal(response.headers.get('location'), target + '?ref=test');
  }
  assert.equal((await fetch(base + '/unknown-seo-page')).status, 404);
});

test('Vercel deployment configurations preserve domain paths and mark every app response noindex', async () => {
  for (const file of ['vercel.json', 'landing/vercel.json']) {
    const config = JSON.parse(await readFile(new URL(file, repo), 'utf8'));
    const redirect = config.redirects.find(item => item.has?.some(condition => condition.type === 'host' && condition.value === 'inrsettle.com'));
    assert.equal(redirect.destination, origin + '/:path*');
    assert.equal(redirect.permanent, true);
    for (const source of ['/app', '/app/(.*)']) {
      assert.ok(config.headers.find(item => item.source === source).headers.some(header => header.key === 'X-Robots-Tag' && header.value.includes('noindex')));
    }
    assert.equal(config.trailingSlash, false);
    assert.match(config.buildCommand, /build-seo\.mjs$/);
    assert.ok(config.redirects.some(item => item.source === '/legal/privacy' && item.destination === '/privacy' && item.permanent));
    assert.ok(config.redirects.some(item => item.source === '/contact' && item.destination === '/#contact-dialog' && item.permanent));
  }
});

test('legacy URLs reported by Search Console preserve their original intent', async () => {
  for (const [source, target] of [['/legal/privacy.html', '/privacy'], ['/contact.html', '/#contact-dialog'], ['/docs/reconciliation.html', '/docs/reconciliation']]) {
    const response = await fetch(base + source + '?ref=legacy', { redirect: 'manual' });
    assert.equal(response.status, 308, source);
    const destination = new URL(response.headers.get('location'), base);
    assert.equal(destination.pathname + destination.hash, target);
    assert.equal(destination.search, '?ref=legacy');
    assert.equal((await fetch(destination)).status, 200);
  }
});
