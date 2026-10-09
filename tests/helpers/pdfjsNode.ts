import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

export async function openWithPdfjs(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
}

export interface PositionedText {
  str: string;
  /** Position of the text origin in normalized display coordinates. */
  nx: number;
  ny: number;
}

export async function textPositions(bytes: Uint8Array, pageNumber = 1): Promise<PositionedText[]> {
  const doc = await openWithPdfjs(bytes);
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const out: PositionedText[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    const [x, y] = vp.convertToViewportPoint(item.transform[4], item.transform[5]) as [number, number];
    out.push({ str: item.str, nx: x / vp.width, ny: y / vp.height });
  }
  return out;
}

export { pdfjs };
