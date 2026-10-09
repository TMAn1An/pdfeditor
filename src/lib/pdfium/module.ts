import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

/**
 * PDFium (the PDF engine used by Chrome), compiled to WebAssembly by the
 * @embedpdf/pdfium package. Used for *editing existing text objects*: reading
 * their font, size, colour and position, changing their text in place, or
 * removing them. Everything runs locally; the .wasm file is served by this app.
 */
export type Pdfium = WrappedPdfiumModule;

let modulePromise: Promise<Pdfium> | null = null;
let wasmLoader: (() => Promise<ArrayBuffer | Uint8Array>) | null = null;

/** Tell the engine how to get pdfium.wasm (browser: fetch a URL; tests: read a file). */
export function setPdfiumWasmLoader(loader: () => Promise<ArrayBuffer | Uint8Array>): void {
  wasmLoader = loader;
}

export function loadPdfium(): Promise<Pdfium> {
  modulePromise ??= (async () => {
    if (!wasmLoader) throw new Error('The PDF text engine (PDFium) is not configured.');
    const bytes = await wasmLoader();
    const { init } = await import('@embedpdf/pdfium');
    const wasmBinary = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    const P = await init({ wasmBinary: wasmBinary as ArrayBuffer });
    P.PDFiumExt_Init();
    return P;
  })().catch((err: unknown) => {
    modulePromise = null;
    throw new Error(`Could not start the PDF text engine (PDFium): ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  });
  return modulePromise;
}

export const FPDF_PAGEOBJ_TEXT = 1;
export const FPDF_PAGEOBJ_IMAGE = 3;
export const FPDF_PAGEOBJ_FORM = 5;

/** Thin, typed helpers over PDFium's C API (memory handling included). */
export class PdfiumHelpers {
  constructor(readonly P: Pdfium) {}

  private get m() {
    // Emscripten re-creates these views when memory grows, so always read them from the module.
    return this.P.pdfium as Pdfium['pdfium'] & { HEAPU8: Uint8Array; HEAPU16: Uint16Array; HEAPU32: Uint32Array; HEAPF32: Float32Array };
  }

  malloc(n: number): number {
    return this.m.wasmExports.malloc(n);
  }

  free(p: number): void {
    this.m.wasmExports.free(p);
  }

  f32(p: number, i = 0): number {
    return this.m.HEAPF32[(p >> 2) + i]!;
  }

  u32(p: number, i = 0): number {
    return this.m.HEAPU32[(p >> 2) + i]!;
  }

  /** Copy bytes into WASM memory (caller frees). */
  copyIn(bytes: Uint8Array): number {
    const p = this.malloc(Math.max(1, bytes.length));
    this.m.HEAPU8.set(bytes, p);
    return p;
  }

  utf16(str: string): number {
    const p = this.malloc((str.length + 1) * 2);
    const base = p >> 1;
    for (let i = 0; i < str.length; i++) this.m.HEAPU16[base + i] = str.charCodeAt(i);
    this.m.HEAPU16[base + str.length] = 0;
    return p;
  }

  objText(obj: number, textPage: number): string {
    const n = this.P.FPDFTextObj_GetText(obj, textPage, 0, 0);
    if (n <= 2) return '';
    const p = this.malloc(n);
    this.P.FPDFTextObj_GetText(obj, textPage, p, n);
    const s = this.m.UTF16ToString(p);
    this.free(p);
    return s;
  }

  fontName(font: number): string {
    const n = this.P.FPDFFont_GetBaseFontName(font, 0, 0);
    if (n <= 0) return '';
    const p = this.malloc(n + 1);
    this.P.FPDFFont_GetBaseFontName(font, p, n);
    const s = this.m.UTF8ToString(p);
    this.free(p);
    return s;
  }

  fontSize(obj: number): number {
    const p = this.malloc(4);
    this.P.FPDFTextObj_GetFontSize(obj, p);
    const v = this.f32(p);
    this.free(p);
    return v;
  }

  matrix(obj: number): [number, number, number, number, number, number] {
    const p = this.malloc(24);
    this.P.FPDFPageObj_GetMatrix(obj, p);
    const r = [0, 1, 2, 3, 4, 5].map((i) => this.f32(p, i)) as [number, number, number, number, number, number];
    this.free(p);
    return r;
  }

  bounds(obj: number): [number, number, number, number] {
    const p = this.malloc(16);
    this.P.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12);
    const r = [0, 1, 2, 3].map((i) => this.f32(p, i)) as [number, number, number, number];
    this.free(p);
    return r;
  }

  /** The four corners of the (possibly rotated) object box. */
  quad(obj: number): { x: number; y: number }[] {
    const p = this.malloc(32);
    const ok = this.P.FPDFPageObj_GetRotatedBounds(obj, p);
    const pts = ok ? [0, 1, 2, 3].map((i) => ({ x: this.f32(p, i * 2), y: this.f32(p, i * 2 + 1) })) : [];
    this.free(p);
    if (pts.length) return pts;
    const [l, b, r, t] = this.bounds(obj);
    return [
      { x: l, y: b },
      { x: r, y: b },
      { x: r, y: t },
      { x: l, y: t },
    ];
  }

  fillColor(obj: number): [number, number, number, number] {
    const p = this.malloc(16);
    this.P.FPDFPageObj_GetFillColor(obj, p, p + 4, p + 8, p + 12);
    const r = [0, 1, 2, 3].map((i) => this.u32(p, i)) as [number, number, number, number];
    this.free(p);
    return r;
  }

  setText(obj: number, text: string): boolean {
    const p = this.utf16(text);
    const ok = this.P.FPDFText_SetText(obj, p);
    this.free(p);
    return ok;
  }

  /** Signature of a glyph outline + advance, used to detect `.notdef` fallbacks. */
  glyphSignature(font: number, codePoint: number): string {
    const P = this.P;
    const wp = this.malloc(4);
    const hasWidth = P.FPDFFont_GetGlyphWidth(font, codePoint, 100, wp);
    const w = hasWidth ? this.f32(wp).toFixed(2) : 'x';
    this.free(wp);
    const path = P.FPDFFont_GetGlyphPath(font, codePoint, 100);
    if (!path) return `null|${w}`;
    const n = P.FPDFGlyphPath_CountGlyphSegments(path);
    const pts: string[] = [];
    const pp = this.malloc(8);
    for (let i = 0; i < n; i++) {
      const seg = P.FPDFGlyphPath_GetGlyphPathSegment(path, i);
      P.FPDFPathSegment_GetPoint(seg, pp, pp + 4);
      pts.push(this.f32(pp).toFixed(1), this.f32(pp, 1).toFixed(1));
    }
    this.free(pp);
    return `${n}|${w}|${pts.join(',')}`;
  }

  /** Save a document to bytes. */
  save(doc: number): Uint8Array {
    const P = this.P;
    const w = P.PDFiumExt_OpenFileWriter();
    try {
      if (!P.PDFiumExt_SaveAsCopy(doc, w)) throw new Error('PDFium could not save the edited PDF.');
      const size = P.PDFiumExt_GetFileWriterSize(w);
      const p = this.malloc(size);
      P.PDFiumExt_GetFileWriterData(w, p, size);
      const out = this.m.HEAPU8.slice(p, p + size);
      this.free(p);
      return out;
    } finally {
      P.PDFiumExt_CloseFileWriter(w);
    }
  }

  openDocument(bytes: Uint8Array, password = ''): { doc: number; close: () => void } {
    const ptr = this.copyIn(bytes);
    const doc = this.P.FPDF_LoadMemDocument(ptr, bytes.length, password);
    if (!doc) {
      const code = this.P.FPDF_GetLastError();
      this.free(ptr);
      throw new Error(code === 4 ? 'This PDF needs a password.' : `PDFium could not open this PDF (error ${code}).`);
    }
    let closed = false;
    return {
      doc,
      close: () => {
        if (closed) return;
        closed = true;
        this.P.FPDF_CloseDocument(doc);
        this.free(ptr);
      },
    };
  }
}
