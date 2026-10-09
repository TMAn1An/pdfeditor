import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadPdfium, setPdfiumWasmLoader, PdfiumHelpers, type Pdfium } from '../../src/lib/pdfium/module';

const require = createRequire(import.meta.url);
setPdfiumWasmLoader(async () => new Uint8Array(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))));

export const pdfium = (): Promise<Pdfium> => loadPdfium();

export const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/pdfs/${name}`, import.meta.url)));
export const liberation = (bold = false) =>
  new Uint8Array(readFileSync(require.resolve(`pdfjs-dist/standard_fonts/LiberationSans-${bold ? 'Bold' : 'Regular'}.ttf`)));

export interface Rendered {
  w: number;
  h: number;
  stride: number;
  px: Uint8Array;
  scale: number;
  pageHeight: number;
}

/** Render a page with PDFium to raw RGBA pixels. */
export function renderPage(P: Pdfium, bytes: Uint8Array, pageIndex = 0, scale = 1.5): Rendered {
  const h = new PdfiumHelpers(P);
  const d = h.openDocument(bytes);
  const page = P.FPDF_LoadPage(d.doc, pageIndex);
  const pageHeight = P.FPDF_GetPageHeightF(page);
  const w = Math.round(P.FPDF_GetPageWidthF(page) * scale);
  const hh = Math.round(pageHeight * scale);
  const bmp = P.FPDFBitmap_Create(w, hh, 0);
  P.FPDFBitmap_FillRect(bmp, 0, 0, w, hh, 0xffffffff);
  P.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, hh, 0, 0x10);
  const buf = P.FPDFBitmap_GetBuffer(bmp);
  const stride = P.FPDFBitmap_GetStride(bmp);
  const px = (P.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8.slice(buf, buf + stride * hh);
  P.FPDFBitmap_Destroy(bmp);
  P.FPDF_ClosePage(page);
  d.close();
  return { w, h: hh, stride, px, scale, pageHeight };
}

/** Pixels that differ outside the given PDF-space rectangles [l, b, r, t]. */
export function pixelsChangedOutside(a: Rendered, b: Rendered, rects: number[][], pad = 3): number {
  let diff = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const X = x / a.scale;
      const Y = a.pageHeight - y / a.scale;
      if (rects.some(([l, bt, r, t]) => X >= l! - pad && X <= r! + pad && Y >= bt! - pad && Y <= t! + pad)) continue;
      const i = y * a.stride + x * 4;
      if (Math.abs(a.px[i]! - b.px[i]!) > 8 || Math.abs(a.px[i + 1]! - b.px[i + 1]!) > 8 || Math.abs(a.px[i + 2]! - b.px[i + 2]!) > 8) diff++;
    }
  }
  return diff;
}

/** Text of every text object on a page, read back with PDFium. */
export function pageTexts(P: Pdfium, bytes: Uint8Array, pageIndex = 0): { text: string; font: string }[] {
  const h = new PdfiumHelpers(P);
  const d = h.openDocument(bytes);
  const page = P.FPDF_LoadPage(d.doc, pageIndex);
  const tp = P.FPDFText_LoadPage(page);
  const out: { text: string; font: string }[] = [];
  const n = P.FPDFPage_CountObjects(page);
  for (let i = 0; i < n; i++) {
    const o = P.FPDFPage_GetObject(page, i);
    if (P.FPDFPageObj_GetType(o) === 1) out.push({ text: h.objText(o, tp), font: h.fontName(P.FPDFTextObj_GetFont(o)) });
  }
  P.FPDFText_ClosePage(tp);
  P.FPDF_ClosePage(page);
  d.close();
  return out;
}
