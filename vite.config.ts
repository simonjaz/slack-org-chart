import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // In development the API and Slack routes live on the Node service.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/slack': 'http://localhost:3000',
    },
  },
});
