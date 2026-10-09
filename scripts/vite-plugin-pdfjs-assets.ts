import { cpSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Serves library support files from this app's own origin so nothing is
 * fetched from a CDN:
 *   /pdfjs/<dir>/<file>     PDF.js cMaps, standard font data, ICC profiles, WASM decoders
 *   /tesseract/<file>       Tesseract.js worker and WASM core (optional OCR, loaded on demand)
 * In production it also adds a Content-Security-Policy that blocks network
 * requests to any other origin.
 */
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

const TESSERACT_FILES: Record<string, string> = {
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
};

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

function resolveAsset(url: string): string | null {
  const pdfjs = /\/pdfjs\/([a-z_]+)\/([^/]+)$/.exec(url);
  if (pdfjs) {
    const [, dir, file] = pdfjs;
    if (!dir || !file || !(PDFJS_DIRS as readonly string[]).includes(dir)) return null;
    return path.resolve('node_modules/pdfjs-dist', dir, path.basename(decodeURIComponent(file)));
  }
  const tess = /\/tesseract\/([^/]+)$/.exec(url);
  if (tess) {
    const target = TESSERACT_FILES[tess[1] ?? ''];
    return target ? path.resolve(target) : null;
  }
  return null;
}

export function pdfjsAssets(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'local-library-assets',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        const filePath = resolveAsset(url);
        if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return next();
        if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
        createReadStream(filePath).pipe(res);
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (config.command !== 'build') return html;
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
      },
    },
    closeBundle() {
      if (config.command !== 'build') return;
      for (const dir of PDFJS_DIRS) {
        const src = path.resolve('node_modules/pdfjs-dist', dir);
        if (existsSync(src)) cpSync(src, path.join(config.build.outDir, 'pdfjs', dir), { recursive: true });
      }
      const tessOut = path.join(config.build.outDir, 'tesseract');
      mkdirSync(tessOut, { recursive: true });
      for (const [name, src] of Object.entries(TESSERACT_FILES)) {
        if (existsSync(src)) cpSync(src, path.join(tessOut, name));
      }
    },
  };
}
