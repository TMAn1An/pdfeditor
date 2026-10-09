/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pdfjsAssets } from './scripts/vite-plugin-pdfjs-assets.ts';

// Everything runs in the browser. There is no API server and no remote asset
// loading: PDF.js workers, cMaps, standard fonts and WASM files are served
// from this app's own origin.
export default defineConfig({
  base: './',
  plugins: [react(), pdfjsAssets()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
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
