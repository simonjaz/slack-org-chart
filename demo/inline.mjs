// Folds the built demo into one HTML file (dist/demo/org-chart-demo.html)
// that opens straight from disk or can be shared as a single page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/demo');
const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
let html = read('index.html');
html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+)"[^>]*>/g, (_, file) => `<style>${read(file)}</style>`);
html = html.replace(
  /<script type="module"[^>]*src="\.\/(assets\/[^"]+)"[^>]*><\/script>/g,
  (_, file) => `<script type="module">${read(file).replace(/<\/script/gi, '<\\/script')}</script>`,
);
if (/\.\/assets\//.test(html)) throw new Error('Some assets were not inlined.');
fs.writeFileSync(path.join(dir, 'org-chart-demo.html'), html);
console.log(`dist/demo/org-chart-demo.html (${Math.round(html.length / 1024)} KB)`);
