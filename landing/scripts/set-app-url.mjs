#!/usr/bin/env node
// Point the site's "Get Started" / "Open App" links at the workspace.
//
//   node scripts/set-app-url.mjs https://app.example.com
//   node scripts/set-app-url.mjs /app/            # back to a same-origin path
//
// Rewrites the anchors in public/index.html in place. Idempotent: run it again
// with a different URL and it moves them again. With no argument it reports
// where the links currently point and changes nothing.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");
const ANCHOR = /(<a\b[^>]*\bhref=")([^"]*)("[^>]*>\s*(?:Get Started|Open App)\b)/g;

const html = readFileSync(PAGE, "utf8");
const current = [...html.matchAll(ANCHOR)].map((m) => m[2]);

if (current.length === 0) {
  console.error("No Get Started / Open App links found in public/index.html.");
  process.exit(1);
}

const target = process.argv[2];

if (!target) {
  console.log(`${current.length} app links in public/index.html:`);
  for (const href of new Set(current)) {
    console.log(`  ${href}  ×${current.filter((h) => h === href).length}`);
  }
  console.log("\nPass a URL to change them, e.g. node scripts/set-app-url.mjs https://app.example.com");
  process.exit(0);
}

if (!/^(https?:\/\/|\/)/.test(target)) {
  console.error(`Refusing "${target}": pass an absolute URL or a root-relative path.`);
  process.exit(1);
}

// Trailing slash on a bare origin, so the workspace's own relative assets resolve.
const href = /^https?:\/\/[^/]+$/.test(target) ? `${target}/` : target;

writeFileSync(PAGE, html.replace(ANCHOR, (_m, before, _old, after) => before + href + after), "utf8");
console.log(`Rewrote ${current.length} app links -> ${href}`);
