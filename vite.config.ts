/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
import { pdfjsAssets } from './scripts/vite-plugin-pdfjs-assets.ts';

// Everything runs in the browser. There is no API server and no remote asset
// loading: PDF.js workers, cMaps, standard fonts and WASM files are served
// from this app's own origin. `studio.html` is a second, additive entry
// point (src/integration/) for embedding inside the IEEE IUBAT Laravel
// admin — see docs/PDF_STUDIO_INTEGRATION.md in that repo. The standalone
// `index.html` entry and everything under src/app, src/lib, src/features is
// unchanged by its presence.
export default defineConfig({
  base: './',
  plugins: [react(), pdfjsAssets()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        studio: resolve(rootDir, 'studio.html'),
      },
    },
  },
  optimizeDeps: {
    // harfbuzzjs locates its .wasm file relative to its own module URL.
    exclude: ['harfbuzzjs'],
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
