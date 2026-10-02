// Optional asset-authoring tool; Sharp is not required by the deployment build.
// Pass an installed Sharp module path as the first argument, or resolve `sharp`.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shareImage } from '../content/pages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { default: sharp } = await import(process.argv[2] || 'sharp');
let source = await readFile(resolve(root, 'brand/seo-share.svg'), 'utf8');
for (const name of ['brand-symbol.svg', 'brand-lockup.svg']) {
  const bytes = await readFile(resolve(root, 'public/assets', name));
  const mime = name.endsWith('.svg') ? 'image/svg+xml' : 'image/webp';
  source = source.replace(`href="${name}"`, `href="data:${mime};base64,${bytes.toString('base64')}"`);
}
const image = await sharp(Buffer.from(source)).png({ compressionLevel: 9 }).toBuffer();
await writeFile(resolve(root, 'public', '.' + shareImage), image);
console.log('Rendered 1200 × 630 social image:', shareImage);
