import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

// The chart page imports Slack's slack:// links from ./actions. In the demo
// they are swapped for links the mock Slack handles (demo/slackLinks.ts).
const slackLinks: Plugin = {
  name: 'demo-slack-links',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './actions' && importer?.replace(/\\/g, '/').endsWith('web/src/ChartPage.tsx')) {
      return path.join(here, 'slackLinks.ts');
    }
    return null;
  },
};

export default defineConfig({
  root: here,
  base: './',
  plugins: [slackLinks, react()],
  build: {
    outDir: path.join(here, '../dist/demo'),
    emptyOutDir: true,
    assetsInlineLimit: 100_000,
  },
});
