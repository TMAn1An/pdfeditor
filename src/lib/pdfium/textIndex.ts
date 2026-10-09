import type { NormRect, PageInfo } from '../../types/project';
import { makePageInfo, userRectToNorm } from '../pdf/coords';
import { FPDF_PAGEOBJ_FORM, FPDF_PAGEOBJ_IMAGE, FPDF_PAGEOBJ_TEXT, PdfiumHelpers, type Pdfium } from './module';

/**
 * Index of the existing text objects in a PDF, built with PDFium.
 *
 * Kept open for the lifetime of a template so the editor and the validator
 * can ask synchronous questions ("can this font draw these characters?",
 * "how wide would this text be?") without re-parsing the PDF.
 */

export const STANDARD_14 = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Symbol',
  'ZapfDingbats',
]);

/** Scripts whose text needs OpenType shaping; PDFium's in-place editing does not shape. */
export const COMPLEX_SCRIPT_RE = /[\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF\uFB1D-\uFDFF\uFE70-\uFEFE]/u;

const SAMPLE_RANGES: [number, number][] = [
  [0x20, 0x7e],
  [0xa0, 0x17f],
  [0x2010, 0x2027],
  [0x20ac, 0x20ac],
];

export interface TextObjectInfo {
  page: number;
  index: number;
  text: string;
  fontName: string;
  embedded: number;
  subset: boolean;
  standardFont: boolean;
  fontSize: number;
  effectiveSize: number;
  matrix: [number, number, number, number, number, number];
  rotation: number;
  color: string;
  bounds: [number, number, number, number];
  /** Width along the baseline, in points. */
  width: number;
  renderMode: number;
  /** Normalized display rect (for showing it on screen). */
  rect: NormRect;
  /** Null when this object can be replaced; otherwise why not. */
  unsupported: string | null;
  /** Null when the original font can be reused (for its available characters). */
  reuseBlocker: string | null;
  fontKey: string;
}

export interface BlockedRegion {
  page: number;
  rect: NormRect;
  reason: string;
}

export interface PageTextObjects {
  page: number;
  info: PageInfo;
  objects: TextObjectInfo[];
  /** Areas with text the engine cannot edit (e.g. inside Form XObjects). */
  blocked: BlockedRegion[];
  imageCount: number;
}

function hex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');
}

export function baselineDirection(m: readonly number[]): { ux: number; uy: number } {
  const len = Math.hypot(m[0]!, m[1]!) || 1;
  return { ux: m[0]! / len, uy: m[1]! / len };
}

/** Extent of a set of points along the baseline direction. */
export function extentAlong(points: { x: number; y: number }[], m: readonly number[]): { min: number; max: number } {
  const { ux, uy } = baselineDirection(m);
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const t = (p.x - m[4]!) * ux + (p.y - m[5]!) * uy;
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  return { min, max };
}

export class PdfTextIndex {
  readonly h: PdfiumHelpers;
  private readonly handle: { doc: number; close: () => void };
  private readonly pageHandles = new Map<number, { page: number; textPage: number }>();
  private readonly pagesCache = new Map<number, PageTextObjects>();
  private readonly coverageCache = new Map<string, Map<number, boolean>>();
  private readonly notdefCache = new Map<string, string>();
  readonly pageCount: number;
  private closed = false;

  constructor(P: Pdfium, bytes: Uint8Array, password?: string) {
    this.h = new PdfiumHelpers(P);
    this.handle = this.h.openDocument(bytes, password);
    this.pageCount = P.FPDF_GetPageCount(this.handle.doc);
  }

  private get P() {
    return this.h.P;
  }

  private loadPage(n: number) {
    let ph = this.pageHandles.get(n);
    if (!ph) {
      const page = this.P.FPDF_LoadPage(this.handle.doc, n - 1);
      if (!page) throw new Error(`Page ${n} could not be loaded.`);
      ph = { page, textPage: this.P.FPDFText_LoadPage(page) };
      this.pageHandles.set(n, ph);
    }
    return ph;
  }

  private pageInfo(n: number): PageInfo {
    const { page } = this.loadPage(n);
    const p = this.h.malloc(16);
    // FPDF_GetPageBoundingBox gives the crop box ∩ media box ([l, b, r, t]).
    this.P.FPDF_GetPageBoundingBox(page, p);
    const l = this.h.f32(p, 0);
    const t = this.h.f32(p, 1);
    const r = this.h.f32(p, 2);
    const b = this.h.f32(p, 3);
    this.h.free(p);
    const rotation = this.P.FPDFPage_GetRotation(page) * 90;
    return makePageInfo(n, { x0: l, y0: Math.min(b, t), x1: r, y1: Math.max(b, t) }, rotation);
  }

  private fontKey(font: number, name: string): string {
    return `${font}:${name}`;
  }

  private notdef(font: number, key: string): string {
    let sig = this.notdefCache.get(key);
    if (sig === undefined) {
      sig = this.h.glyphSignature(font, 0xe000);
      this.notdefCache.set(key, sig);
    }
    return sig;
  }

  private hasGlyph(font: number, key: string, cp: number): boolean {
    let cache = this.coverageCache.get(key);
    if (!cache) {
      cache = new Map();
      this.coverageCache.set(key, cache);
    }
    let v = cache.get(cp);
    if (v === undefined) {
      const sig = this.h.glyphSignature(font, cp);
      v = sig !== this.notdef(font, key) && !sig.startsWith('null|x');
      cache.set(cp, v);
    }
    return v;
  }

  private describe(n: number, index: number, obj: number, info: PageInfo): TextObjectInfo {
    const { textPage } = this.loadPage(n);
    const h = this.h;
    const P = this.P;
    const text = h.objText(obj, textPage);
    const font = P.FPDFTextObj_GetFont(obj);
    const fontName = font ? h.fontName(font) : '';
    const baseName = fontName.replace(/^[A-Z]{6}\+/, '');
    const embedded = font ? P.FPDFFont_GetIsEmbedded(font) : -1;
    const standardFont = embedded !== 1 && STANDARD_14.has(baseName);
    const fontSize = h.fontSize(obj);
    const matrix = h.matrix(obj);
    const scaleY = Math.hypot(matrix[2], matrix[3]) || 1;
    const rotation = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI;
    const [r, g, b] = h.fillColor(obj);
    const bounds = h.bounds(obj);
    const ext = extentAlong(h.quad(obj), matrix);
    const renderMode = P.FPDFTextObj_GetTextRenderMode(obj);
    const key = this.fontKey(font, fontName);

    let unsupported: string | null = null;
    if (renderMode === 3 || renderMode === 7) {
      unsupported =
        'This text is invisible (usually an OCR text layer placed over a scanned image). Changing it would not change what the page shows; the visible letters are part of an image.';
    } else if (!text.trim()) {
      unsupported = 'This object contains no readable text.';
    } else if (!font) {
      unsupported = 'The font of this text could not be read.';
    }

    let reuseBlocker: string | null = null;
    let subset = /^[A-Z]{6}\+/.test(fontName);
    if (!unsupported) {
      if (embedded !== 1 && !standardFont) {
        reuseBlocker = `“${fontName || 'Unknown font'}” is not embedded in the PDF. PDF viewers substitute a similar font, so the original letter shapes are not available to reuse.`;
      } else if (COMPLEX_SCRIPT_RE.test(text)) {
        reuseBlocker =
          'This text uses a script that needs OpenType shaping (e.g. Bangla, Arabic, Devanagari). Editing the PDF text object in place does not shape text, so a replacement font (shaped with HarfBuzz) is required.';
      } else if (embedded === 1) {
        // Subset fonts without the ABCDEF+ prefix: check basic Latin coverage.
        let present = 0;
        const probe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (const ch of probe) if (this.hasGlyph(font, key, ch.codePointAt(0)!)) present++;
        if (present < probe.length) subset = true;
      }
    }

    return {
      page: n,
      index,
      text,
      fontName: fontName || 'Unknown font',
      embedded,
      subset,
      standardFont,
      fontSize,
      effectiveSize: fontSize * scaleY,
      matrix,
      rotation,
      color: `#${hex(r)}${hex(g)}${hex(b)}`,
      bounds,
      width: Math.max(0, ext.max - ext.min),
      renderMode,
      rect: userRectToNorm(info, bounds[0], bounds[1], bounds[2], bounds[3]),
      unsupported,
      reuseBlocker,
      fontKey: key,
    };
  }

  /** All text objects of a page (1-based), cached. */
  page(n: number): PageTextObjects {
    const cached = this.pagesCache.get(n);
    if (cached) return cached;
    const { page } = this.loadPage(n);
    const info = this.pageInfo(n);
    const objects: TextObjectInfo[] = [];
    const blocked: BlockedRegion[] = [];
    let imageCount = 0;
    const count = this.P.FPDFPage_CountObjects(page);
    for (let i = 0; i < count; i++) {
      const obj = this.P.FPDFPage_GetObject(page, i);
      const type = this.P.FPDFPageObj_GetType(obj);
      if (type === FPDF_PAGEOBJ_TEXT) objects.push(this.describe(n, i, obj, info));
      else if (type === FPDF_PAGEOBJ_IMAGE) imageCount++;
      else if (type === FPDF_PAGEOBJ_FORM && this.formContainsText(obj, 0)) {
        const [l, b, r, t] = this.h.bounds(obj);
        blocked.push({
          page: n,
          rect: userRectToNorm(info, l, b, r, t),
          reason:
            'This text is inside a Form XObject (a reusable drawing group, often used for headers, stamps or imported pages). The engine cannot rewrite text inside it without affecting every place it is used, so it cannot be replaced.',
        });
      }
    }
    const result = { page: n, info, objects, blocked, imageCount };
    this.pagesCache.set(n, result);
    return result;
  }

  private formContainsText(form: number, depth: number): boolean {
    if (depth > 4) return false;
    const n = this.P.FPDFFormObj_CountObjects(form);
    for (let i = 0; i < n; i++) {
      const o = this.P.FPDFFormObj_GetObject(form, i);
      const t = this.P.FPDFPageObj_GetType(o);
      if (t === FPDF_PAGEOBJ_TEXT) return true;
      if (t === FPDF_PAGEOBJ_FORM && this.formContainsText(o, depth + 1)) return true;
    }
    return false;
  }

  object(page: number, index: number): TextObjectInfo | undefined {
    return this.page(page).objects.find((o) => o.index === index);
  }

  private handleFor(page: number, index: number): number {
    const { page: ph } = this.loadPage(page);
    return this.P.FPDFPage_GetObject(ph, index);
  }

  /** Characters of `text` the object's own font cannot draw (whitespace is ignored). */
  missingChars(page: number, index: number, text: string): string[] {
    const info = this.object(page, index);
    if (!info) return Array.from(new Set(text));
    const font = this.P.FPDFTextObj_GetFont(this.handleFor(page, index));
    const out = new Set<string>();
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      if (!this.hasGlyph(font, info.fontKey, ch.codePointAt(0)!)) out.add(ch);
    }
    return [...out];
  }

  /** Characters (from common ranges + the original text) the object's font has. */
  availableChars(page: number, index: number): string {
    const info = this.object(page, index);
    if (!info) return '';
    const font = this.P.FPDFTextObj_GetFont(this.handleFor(page, index));
    const chars = new Set<string>();
    for (const [a, b] of SAMPLE_RANGES) {
      for (let cp = a; cp <= b; cp++) if (cp !== 0x20 && this.hasGlyph(font, info.fontKey, cp)) chars.add(String.fromCodePoint(cp));
    }
    for (const ch of info.text) if (!/\s/.test(ch) && this.hasGlyph(font, info.fontKey, ch.codePointAt(0)!)) chars.add(ch);
    return [...chars].join('');
  }

  /**
   * Width (points, along the baseline) the object would have with `text`,
   * measured by actually setting the text and restoring it afterwards.
   */
  measure(page: number, index: number, text: string): number {
    const info = this.object(page, index);
    if (!info) return 0;
    const obj = this.handleFor(page, index);
    this.h.setText(obj, text);
    const ext = extentAlong(this.h.quad(obj), info.matrix);
    this.h.setText(obj, info.text);
    return Math.max(0, ext.max - ext.min);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { page, textPage } of this.pageHandles.values()) {
      this.P.FPDFText_ClosePage(textPage);
      this.P.FPDF_ClosePage(page);
    }
    this.pageHandles.clear();
    this.handle.close();
  }
}
