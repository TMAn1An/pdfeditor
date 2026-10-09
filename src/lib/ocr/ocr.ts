import type { NormRect } from '../../types/project';
import type { PDFPageProxy } from '../pdf/pdfjs';

/**
 * Optional OCR for scanned pages, using Tesseract.js (Apache-2.0) running
 * locally in a Web Worker. The worker and WebAssembly core are served by this
 * app; the language data (".traineddata") is a file the user selects, so no
 * network request is ever made. Results are only *suggestions* for placing
 * fields and may contain mistakes.
 */

export interface OcrLine {
  text: string;
  /** 0-100 as reported by Tesseract. */
  confidence: number;
  rect: NormRect;
  fontSize: number;
}

export interface OcrLanguage {
  code: string;
  data: Uint8Array;
}

/** Guess the Tesseract language code from a file name like "ben.traineddata". */
export function languageCodeFromFileName(name: string): string | null {
  const m = /^([a-z]{3}(?:_[a-z]+)?)\.traineddata(?:\.gz)?$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : null;
}

const CACHE_PATH = 'pdf-template-studio-ocr';

function assetUrl(p: string): string {
  return new URL(p, document.baseURI).href;
}

export async function recognizePage(
  page: PDFPageProxy,
  languages: OcrLanguage[],
  onProgress: (status: string, progress: number) => void,
): Promise<OcrLine[]> {
  const { createWorker, OEM } = await import('tesseract.js');
  // Render at roughly 300 dpi (capped) — OCR accuracy drops a lot below ~200 dpi.
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(300 / 72, 4000 / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  onProgress('Rendering page', 0);
  await page.render({ canvas, viewport: vp }).promise;

  // Tesseract.js reads language data from its IndexedDB cache before it would
  // ever download anything. The user's file is placed there only for this run
  // ("readOnly" cache mode: never fetch, never write) and removed afterwards.
  const { set, del } = await import('idb-keyval');
  const keys = languages.map((l) => `${CACHE_PATH}/${l.code}.traineddata`);
  await Promise.all(languages.map((l, i) => set(keys[i]!, l.data)));

  let fail: (err: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  let worker: Awaited<ReturnType<typeof createWorker>>;
  try {
    worker = await Promise.race([
      createWorker(
        languages.map((l) => l.code),
        OEM.LSTM_ONLY,
        {
          workerPath: assetUrl('tesseract/worker.min.js'),
          corePath: assetUrl('tesseract/'),
          // Never used for downloads (data comes from the cache); points at this app just in case.
          langPath: assetUrl('tesseract/lang-data-not-bundled'),
          cachePath: CACHE_PATH,
          cacheMethod: 'readOnly',
          workerBlobURL: false,
          logger: (m) => onProgress(m.status, m.progress),
          errorHandler: (e: unknown) => fail(new Error(String(e))),
        },
      ),
      failed,
    ]);
  } catch (err) {
    await Promise.all(keys.map((k) => del(k)));
    throw new Error(`The OCR engine could not start (${err instanceof Error ? err.message : String(err)}). Check that the language file is a valid Tesseract 4+ ".traineddata" file.`, { cause: err });
  }
  try {
    const result = await Promise.race([worker.recognize(canvas, {}, { blocks: true, text: true }), failed]);
    const lines: OcrLine[] = [];
    for (const block of result.data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const text = line.text.trim();
          if (!text) continue;
          const { x0, y0, x1, y1 } = line.bbox;
          lines.push({
            text,
            confidence: line.confidence,
            rect: { x: x0 / canvas.width, y: y0 / canvas.height, w: (x1 - x0) / canvas.width, h: (y1 - y0) / canvas.height },
            fontSize: Math.round(((y1 - y0) / scale) * 0.8 * 10) / 10,
          });
        }
      }
    }
    return lines;
  } finally {
    await worker.terminate().catch(() => undefined);
    await Promise.all(keys.map((k) => del(k)));
    canvas.width = 0;
    canvas.height = 0;
  }
}
