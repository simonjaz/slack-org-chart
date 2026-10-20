// Prints manifest.yml with the placeholder host replaced by your BASE_URL.
//   npm run manifest -- https://orgchart.acme.com > my-manifest.yml
import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? process.env.BASE_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(base)) {
  console.error('Usage: npm run manifest -- https://your-host (an https origin, no path)');
  process.exit(1);
}
const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
process.stdout.write(manifest.replaceAll('https://orgchart.example.com', base));
