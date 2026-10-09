import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Serves PDF.js support files (cMaps, standard font data, ICC profiles and
 * WASM decoders) from this app's own origin, so nothing is fetched from a CDN.
 * In production it also adds a Content-Security-Policy that blocks network
 * requests to any other origin.
 */
const ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

export function pdfjsAssets(): Plugin {
  let config: ResolvedConfig;
  const pdfjsRoot = path.resolve('node_modules/pdfjs-dist');
  return {
    name: 'pdfjs-local-assets',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        const match = /\/pdfjs\/([a-z_]+)\/([^/]+)$/.exec(url);
        if (!match) return next();
        const [, dir, file] = match;
        if (!dir || !file || !(ASSET_DIRS as readonly string[]).includes(dir)) return next();
        const filePath = path.join(pdfjsRoot, dir, path.basename(decodeURIComponent(file)));
        if (!existsSync(filePath) || !statSync(filePath).isFile()) return next();
        if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        createReadStream(filePath).pipe(res);
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (config.command !== 'build') return html;
        return html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        );
      },
    },
    closeBundle() {
      if (config.command !== 'build') return;
      for (const dir of ASSET_DIRS) {
        const src = path.join(pdfjsRoot, dir);
        if (existsSync(src)) {
          cpSync(src, path.join(config.build.outDir, 'pdfjs', dir), { recursive: true });
        }
      }
    },
  };
}
