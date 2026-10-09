import type { HorizontalAlign, ReplaceFit, TextObjectRef } from '../../types/project';
import { FPDF_PAGEOBJ_TEXT, PdfiumHelpers, type Pdfium } from './module';
import { extentAlong, baselineDirection } from './textIndex';

/**
 * Applies true text replacements to a copy of a PDF with PDFium.
 *
 * - `in-place`: the original text object keeps its font, size, colour and
 *   transform; only its text changes (FPDFText_SetText). Optional
 *   shrink-to-fit scales the object about its baseline origin; alignment
 *   moves it along the baseline.
 * - `remove`: the original object(s) are deleted from the page content, and
 *   the caller draws the new text in another font at the returned geometry.
 *
 * Nothing is painted over the old text; the old text is no longer in the file.
 */

export interface ReplaceOp {
  id: string;
  targets: TextObjectRef[];
  /** Range of the joined original text that is replaced. */
  selection: { start: number; end: number };
  value: string;
  mode: 'in-place' | 'remove';
  align: HorizontalAlign;
  fit: ReplaceFit;
  minScale: number;
  /** Requested scale relative to the original size (manual size override), 1 = original. */
  sizeScale: number;
  /** Width available along the baseline, in points. */
  maxWidth: number;
  /** Width of the original targets along the baseline. */
  originalWidth: number;
  /** Optional colour override as [r, g, b] 0-255. */
  color?: [number, number, number] | null;
}

export interface ReplaceGeometry {
  page: number;
  /** Original text matrix of the first target. */
  matrix: [number, number, number, number, number, number];
  /** Position of the original text start along the baseline (relative to the matrix origin). */
  startOffset: number;
  /** Effective font size of the original text in points. */
  effectiveSize: number;
  color: [number, number, number];
}

export interface ReplaceOutcome {
  id: string;
  mode: ReplaceOp['mode'];
  /** Full text the object now has (prefix + value + suffix). */
  text: string;
  /** Final scale applied (in-place) relative to the original size. */
  scale: number;
  /** The text is wider than the allowed width even after shrinking. */
  overflow: boolean;
  newWidth: number;
  geometry: ReplaceGeometry;
}

export class ReplaceError extends Error {}

export function replacedText(targetTexts: string[], selection: { start: number; end: number }, value: string): string {
  const joined = targetTexts.join('');
  const start = Math.max(0, Math.min(selection.start, joined.length));
  const end = Math.max(start, Math.min(selection.end, joined.length));
  return joined.slice(0, start) + value + joined.slice(end);
}

/** Scale and alignment offset for text of `newWidth` replacing `originalWidth`. */
export function fitAndAlign(op: Pick<ReplaceOp, 'align' | 'fit' | 'minScale' | 'sizeScale' | 'maxWidth' | 'originalWidth'>, newWidthAtOriginalSize: number) {
  let scale = op.sizeScale;
  let overflow = false;
  const width = newWidthAtOriginalSize * scale;
  if (width > op.maxWidth + 0.01) {
    if (op.fit === 'shrink') {
      scale = (op.maxWidth / newWidthAtOriginalSize) * 0.999;
      if (scale < op.minScale) {
        scale = op.minScale;
        overflow = true;
      }
    } else {
      overflow = true;
    }
  }
  const finalWidth = newWidthAtOriginalSize * scale;
  const k = op.align === 'center' ? 0.5 : op.align === 'right' ? 1 : 0;
  const shift = (op.originalWidth - finalWidth) * k;
  return { scale, overflow, shift, finalWidth };
}

export function applyReplacements(P: Pdfium, source: Uint8Array, ops: ReplaceOp[]): { bytes: Uint8Array; outcomes: ReplaceOutcome[] } {
  const h = new PdfiumHelpers(P);
  // PDFium may keep a reference to the input buffer; work on a copy so the caller's bytes are never touched.
  const handle = h.openDocument(source.slice());
  const pages = new Map<number, { page: number; textPage: number }>();
  try {
    const loadPage = (n: number) => {
      let ph = pages.get(n);
      if (!ph) {
        const page = P.FPDF_LoadPage(handle.doc, n - 1);
        if (!page) throw new ReplaceError(`Page ${n} of the template could not be loaded.`);
        ph = { page, textPage: P.FPDFText_LoadPage(page) };
        pages.set(n, ph);
      }
      return ph;
    };

    // Resolve every object handle before changing anything (removals shift indices).
    const resolved = ops.map((op) => {
      if (op.targets.length === 0) throw new ReplaceError('A replacement field has no target text.');
      const objs = op.targets.map((t) => {
        const { page, textPage } = loadPage(t.page);
        const obj = P.FPDFPage_GetObject(page, t.objectIndex);
        if (!obj || P.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT || h.objText(obj, textPage) !== t.text) {
          throw new ReplaceError(
            `The text “${t.text}” is no longer at its recorded position on page ${t.page}. The PDF does not match the template; select the text again.`,
          );
        }
        return obj;
      });
      return { op, objs };
    });

    const outcomes: ReplaceOutcome[] = [];
    for (const { op, objs } of resolved) {
      const first = objs[0]!;
      const pageNo = op.targets[0]!.page;
      const { page } = loadPage(pageNo);
      const matrix = h.matrix(first);
      const [r, g, b] = h.fillColor(first);
      const allQuads = objs.flatMap((o) => h.quad(o));
      const ext = extentAlong(allQuads, matrix);
      const effectiveSize = h.fontSize(first) * (Math.hypot(matrix[2], matrix[3]) || 1);
      const text = replacedText(
        op.targets.map((t) => t.text),
        op.selection,
        op.value,
      );
      const geometry: ReplaceGeometry = { page: pageNo, matrix, startOffset: ext.min, effectiveSize, color: [r, g, b] };

      if (op.mode === 'remove') {
        for (const o of objs) {
          if (!P.FPDFPage_RemoveObject(page, o)) throw new ReplaceError(`The text “${op.targets[0]!.text}” could not be removed from the page.`);
          P.FPDFPageObj_Destroy(o);
        }
        outcomes.push({ id: op.id, mode: 'remove', text, scale: 1, overflow: false, newWidth: 0, geometry });
        continue;
      }

      // In place: the first object receives the full new text, the others are removed.
      if (!h.setText(first, text)) throw new ReplaceError(`The text “${op.targets[0]!.text}” could not be changed.`);
      // A fresh text page is needed: the cached one still holds the old characters.
      const freshTextPage = P.FPDFText_LoadPage(page);
      const readBack = h.objText(first, freshTextPage);
      P.FPDFText_ClosePage(freshTextPage);
      if (readBack !== text) {
        const lost = [...new Set(Array.from(text).filter((ch) => !readBack.includes(ch) && !/\s/.test(ch)))].join(' ');
        throw new ReplaceError(
          `The original font of “${op.targets[0]!.text}” cannot encode ${lost ? `“${lost}”` : 'some characters'} of “${op.value}”. Choose a replacement font for this field.`,
        );
      }
      for (const o of objs.slice(1)) {
        P.FPDFPage_RemoveObject(page, o);
        P.FPDFPageObj_Destroy(o);
      }
      const newExt = extentAlong(h.quad(first), matrix);
      const newWidth = Math.max(0, newExt.max - newExt.min);
      const fit = fitAndAlign(op, newWidth);
      const [e, f] = [matrix[4], matrix[5]];
      if (Math.abs(fit.scale - 1) > 1e-4) {
        // Uniform scale about the baseline origin keeps the baseline and rotation.
        P.FPDFPageObj_Transform(first, fit.scale, 0, 0, fit.scale, e * (1 - fit.scale), f * (1 - fit.scale));
      }
      // Align relative to where the original text started.
      const { ux, uy } = baselineDirection(matrix);
      const startNow = newExt.min * fit.scale;
      const dx = ext.min + fit.shift - startNow;
      if (Math.abs(dx) > 1e-3) P.FPDFPageObj_Transform(first, 1, 0, 0, 1, dx * ux, dx * uy);
      if (op.color) P.FPDFPageObj_SetFillColor(first, op.color[0], op.color[1], op.color[2], 255);
      outcomes.push({ id: op.id, mode: 'in-place', text, scale: fit.scale, overflow: fit.overflow, newWidth: fit.finalWidth, geometry });
    }

    for (const { page } of pages.values()) {
      if (!P.FPDFPage_GenerateContent(page)) throw new ReplaceError('PDFium could not write the edited page content.');
    }
    for (const { page, textPage } of pages.values()) {
      P.FPDFText_ClosePage(textPage);
      P.FPDF_ClosePage(page);
    }
    pages.clear();
    return { bytes: h.save(handle.doc), outcomes };
  } finally {
    for (const { page, textPage } of pages.values()) {
      P.FPDFText_ClosePage(textPage);
      P.FPDF_ClosePage(page);
    }
    handle.close();
  }
}
