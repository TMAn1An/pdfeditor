// The "legacy" build is PDF.js's own build for a wider range of browsers; the
// modern build relies on very recent JavaScript features.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { ExistingFormField, FormFieldKind, NormRect, PageInfo } from '../../types/project';
import { makePageInfo } from './coords';

/**
 * PDF.js is used only to *display* PDFs and to read text/annotations. The
 * worker, cMaps, fonts and WASM decoders are served from this app's origin.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

function assetUrl(path: string): string {
  return new URL(`pdfjs/${path}/`, document.baseURI).href;
}

export const MAX_PDF_BYTES = 300 * 1024 * 1024;
export const LARGE_PDF_BYTES = 50 * 1024 * 1024;

export type PdfOpenErrorKind = 'password-required' | 'password-incorrect' | 'invalid' | 'too-large' | 'unknown';

export class PdfOpenError extends Error {
  constructor(
    readonly kind: PdfOpenErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF-" may be preceded by some junk bytes; check the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfOpenError('too-large', `This PDF is ${(bytes.byteLength / 1048576).toFixed(0)} MB. Files over ${MAX_PDF_BYTES / 1048576} MB are not supported in the browser.`);
  }
  if (!looksLikePdf(bytes)) throw new PdfOpenError('invalid', 'This file is not a PDF (it does not start with a PDF header).');
  const task = pdfjs.getDocument({
    // PDF.js transfers the buffer to its worker; give it a copy so the
    // original bytes stay usable for export.
    data: bytes.slice(),
    password,
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
    enableXfa: false,
    disableAutoFetch: true,
  });
  try {
    return await task.promise;
  } catch (err) {
    const e = err as { name?: string; code?: number; message?: string };
    if (e?.name === 'PasswordException') {
      if (e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD) throw new PdfOpenError('password-incorrect', 'That password is not correct.');
      throw new PdfOpenError('password-required', 'This PDF is protected with a password.');
    }
    if (e?.name === 'InvalidPDFException') throw new PdfOpenError('invalid', 'This PDF is damaged or not a valid PDF file.');
    throw new PdfOpenError('unknown', `The PDF could not be opened: ${e?.message ?? String(err)}`);
  }
}

export async function readPageInfos(doc: PDFDocumentProxy): Promise<PageInfo[]> {
  const infos: PageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    infos.push(makePageInfo(i, { x0, y0, x1, y1 }, page.rotate));
  }
  return infos;
}

/** Converts a PDF user-space rectangle to normalized display coordinates using PDF.js. */
export function pdfRectToNorm(page: PDFPageProxy, rect: number[]): NormRect {
  const vp = page.getViewport({ scale: 1 });
  const [a, b] = vp.convertToViewportPoint(rect[0]!, rect[1]!) as [number, number];
  const [c, d] = vp.convertToViewportPoint(rect[2]!, rect[3]!) as [number, number];
  const left = Math.min(a, c);
  const top = Math.min(b, d);
  return { x: left / vp.width, y: top / vp.height, w: Math.abs(c - a) / vp.width, h: Math.abs(d - b) / vp.height };
}

interface PdfjsAnnotation {
  subtype?: string;
  fieldName?: string;
  fieldType?: string;
  rect?: number[];
  readOnly?: boolean;
  required?: boolean;
  multiLine?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  combo?: boolean;
  options?: { exportValue?: string; displayValue?: string }[];
  buttonValue?: string;
  exportValue?: string;
}

function kindOf(a: PdfjsAnnotation): FormFieldKind {
  switch (a.fieldType) {
    case 'Tx':
      return 'text';
    case 'Btn':
      if (a.checkBox) return 'checkbox';
      if (a.radioButton) return 'radio';
      return 'button';
    case 'Ch':
      return a.combo ? 'dropdown' : 'listbox';
    case 'Sig':
      return 'signature';
    default:
      return 'unknown';
  }
}

/** Find existing AcroForm fields and where their widgets sit. */
export async function detectFormFields(doc: PDFDocumentProxy): Promise<ExistingFormField[]> {
  const byName = new Map<string, ExistingFormField>();
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    let annots: PdfjsAnnotation[];
    try {
      annots = (await page.getAnnotations({ intent: 'display' })) as PdfjsAnnotation[];
    } catch {
      continue;
    }
    for (const a of annots) {
      if (a.subtype !== 'Widget' || !a.fieldName || !a.rect) continue;
      const kind = kindOf(a);
      let f = byName.get(a.fieldName);
      if (!f) {
        f = {
          name: a.fieldName,
          kind,
          readOnly: !!a.readOnly,
          required: !!a.required,
          multiline: !!a.multiLine,
          options: [],
          widgets: [],
          fillable: ['text', 'checkbox', 'radio', 'dropdown', 'listbox'].includes(kind) && !a.readOnly,
        };
        byName.set(a.fieldName, f);
      }
      f.widgets.push({ page: i, rect: pdfRectToNorm(page, a.rect) });
      if (a.options) {
        for (const o of a.options) {
          const v = o.exportValue ?? o.displayValue;
          if (v && !f.options.includes(v)) f.options.push(v);
        }
      }
      if (kind === 'radio' && a.buttonValue && !f.options.includes(a.buttonValue)) f.options.push(a.buttonValue);
    }
  }
  return [...byName.values()];
}

export interface ExtractedTextRun {
  id: string;
  page: number;
  text: string;
  rect: NormRect;
  /** Approximate font size in points. */
  fontSize: number;
  fontName: string;
  fontFamily: string;
  /** Where the text came from: the PDF's own text layer, or OCR (may contain mistakes). */
  source?: 'pdf' | 'ocr';
  /** OCR confidence 0-100. */
  confidence?: number;
}

export interface PageTextInfo {
  runs: ExtractedTextRun[];
  /** Page shows images but has no extractable text: probably scanned. */
  imageOnly: boolean;
  imageCount: number;
}

export async function extractPageText(page: PDFPageProxy): Promise<PageTextInfo> {
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string }>;
  const runs: ExtractedTextRun[] = [];
  content.items.forEach((item, i) => {
    if (!('str' in item) || !item.str.trim()) return;
    const [a, b, , , e, f] = item.transform as number[];
    const size = Math.hypot(a ?? 0, b ?? 0) || item.height || 10;
    const width = item.width;
    const height = item.height || size;
    // Glyph box: from a bit below the baseline to the ascender.
    const rect = pdfRectToNorm(page, [e!, f! - height * 0.22, e! + width, f! + height * 0.9]);
    runs.push({
      id: `${page.pageNumber}-${i}`,
      page: page.pageNumber,
      text: item.str,
      rect,
      fontSize: Math.round(size * 10) / 10,
      fontName: item.fontName,
      fontFamily: styles[item.fontName]?.fontFamily ?? '',
    });
  });
  let imageCount = 0;
  if (runs.length === 0) {
    try {
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) {
        if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) imageCount++;
      }
    } catch {
      /* ignore */
    }
  }
  return { runs, imageOnly: runs.length === 0 && imageCount > 0, imageCount };
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };

/** Release a document and its worker resources. */
export function closePdf(doc: PDFDocumentProxy | null | undefined): Promise<void> {
  return doc ? doc.loadingTask.destroy().catch(() => undefined) : Promise.resolve();
}
