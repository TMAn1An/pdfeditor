import fontkit from '@pdf-lib/fontkit';
import {
  beginText,
  clip,
  concatTransformationMatrix,
  degrees,
  endPath,
  endText,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFFont,
  PDFHexString,
  PDFImage,
  PDFName,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFTextField,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  StandardFonts,
  TextAlignment,
  EncryptedPDFError,
  fill,
} from 'pdf-lib';
import type { FontRef, FormOutputMode, ValidationIssue } from '../../types/project';
import { CustomFontMetrics, StandardFontMetrics, type FontStack } from '../fonts/engine';
import { customFontId, isStandardFontRef } from '../fonts/standard';
import { placeImage } from '../images/fit';
import type { ImageAsset } from '../images/load';
import { contentFrameSize, contentRotationMatrix, fieldFrameMatrix, makePageInfo, normRectToUserRect, type Matrix } from '../pdf/coords';
import type { ImagePlan, RowPlan, TextPlan } from './plan';
import { loadPdfium } from '../pdfium/module';
import { applyReplacements, fitAndAlign, ReplaceError, type ReplaceOp, type ReplaceOutcome } from '../pdfium/replace';
import type { ReplacePlan } from './replacePlan';
import { baselineDirection } from '../pdfium/textIndex';

/**
 * Draws a row plan onto a fresh copy of the template PDF with pdf-lib.
 *
 * The source PDF bytes are never modified: every call loads a new document
 * from the original bytes and returns new bytes.
 */

export interface GenerateOptions {
  templateBytes: Uint8Array;
  plan: RowPlan;
  formMode: FormOutputMode;
  formFieldFont: FontRef;
  fontBytes: (id: string) => Uint8Array | undefined;
  /** Title metadata for the output. */
  title?: string;
}

export interface GenerateResult {
  bytes: Uint8Array;
  issues: ValidationIssue[];
}

export class TemplatePdfError extends Error {}

export async function loadTemplateForEditing(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError || (err instanceof Error && /is encrypted/i.test(err.message))) {
      throw new TemplatePdfError(
        'This PDF is encrypted (it has a password or editing restrictions). It can be viewed, but filled copies cannot be created. Save an unprotected copy of the PDF and open that instead.',
      );
    }
    throw new TemplatePdfError(`The PDF could not be prepared for filling: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseColor(hex: string | null | undefined, fallback = '#000000') {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex ?? fallback).trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback)!;
  let h = m[1]!;
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const STANDARD_ENUM: Record<string, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Oblique': StandardFonts.HelveticaOblique,
  'Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
  'Times-Roman': StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic,
  'Times-BoldItalic': StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold,
};

class DocResources {
  private readonly fonts = new Map<FontRef, Promise<PDFFont>>();
  private readonly images = new Map<string, Promise<PDFImage>>();
  private readonly fontKeys = new Map<string, PDFName>();

  constructor(
    readonly doc: PDFDocument,
    private readonly fontBytes: (id: string) => Uint8Array | undefined,
  ) {}

  font(ref: FontRef): Promise<PDFFont> {
    let p = this.fonts.get(ref);
    if (!p) {
      if (isStandardFontRef(ref)) {
        p = this.doc.embedFont(STANDARD_ENUM[ref.slice(4)] ?? StandardFonts.Helvetica);
      } else {
        const bytes = this.fontBytes(customFontId(ref)!);
        if (!bytes) return Promise.reject(new Error('A custom font is not loaded.'));
        // Embed the whole font (no subsetting): glyphs are placed by glyph id
        // after HarfBuzz shaping, so glyph ids must stay unchanged.
        p = this.doc.embedFont(bytes, { subset: false });
      }
      this.fonts.set(ref, p);
    }
    return p;
  }

  image(asset: ImageAsset): Promise<PDFImage> {
    let p = this.images.get(asset.id);
    if (!p) {
      const bytes = asset.pdfBytes!;
      p = asset.pdfKind === 'jpeg' ? this.doc.embedJpg(bytes) : this.doc.embedPng(bytes);
      this.images.set(asset.id, p);
    }
    return p;
  }

  fontKey(page: PDFPage, font: PDFFont): PDFName {
    const id = `${page.ref.toString()}|${font.ref.toString()}`;
    let key = this.fontKeys.get(id);
    if (!key) {
      key = page.node.newFontDictionary(font.name, font.ref);
      this.fontKeys.set(id, key);
    }
    return key;
  }
}

function cm(m: Matrix) {
  return concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]);
}

function pageInfoFor(page: PDFPage, pageNumber: number) {
  const box = page.getCropBox();
  return makePageInfo(pageNumber, { x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height }, page.getRotation().angle);
}

async function drawTextLine(
  res: DocResources,
  page: PDFPage,
  stack: FontStack,
  text: string,
  x: number,
  baseline: number,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  const line = stack.prepare(text);
  let pen = x;
  for (const run of line.runs) {
    if (run.kind === 'missing') {
      pen += run.width * size;
      continue;
    }
    const metrics = stack.fonts[run.font]!;
    const pdfFont = await res.font(metrics.ref);
    if (run.kind === 'standard' && metrics instanceof StandardFontMetrics) {
      page.drawText(run.text, { x: pen, y: baseline, size, font: pdfFont, color });
    } else if (run.kind === 'custom' && metrics instanceof CustomFontMetrics) {
      const key = res.fontKey(page, pdfFont);
      const ops = [beginText(), setFillingRgbColor(color.red, color.green, color.blue), setFontAndSize(key, size)];
      let gx = pen;
      for (const g of run.glyphs) {
        ops.push(setTextMatrix(1, 0, 0, 1, round(gx + g.dx * size), round(baseline + g.dy * size)));
        ops.push(showText(PDFHexString.of(g.gid.toString(16).padStart(4, '0'))));
        gx += g.ax * size;
      }
      ops.push(endText());
      page.pushOperators(...ops);
    }
    pen += run.width * size;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function drawTextField(res: DocResources, page: PDFPage, pageNumber: number, t: TextPlan) {
  const { field, layout } = t;
  const info = pageInfoFor(page, pageNumber);
  const frame = fieldFrameMatrix(info, field.rect);
  const content = contentFrameSize(field.style.rotation, frame.width, frame.height);
  const pad = Math.max(0, field.style.padding);
  page.pushOperators(pushGraphicsState(), cm(frame.matrix));
  if (field.style.background) {
    const c = parseColor(field.style.background, '#ffffff');
    page.pushOperators(setFillingRgbColor(c.red, c.green, c.blue), rectangle(0, 0, frame.width, frame.height), fill());
  }
  page.pushOperators(cm(contentRotationMatrix(field.style.rotation, frame.width, frame.height)));
  if (layout.clip) page.pushOperators(rectangle(0, 0, content.width, content.height), clip(), endPath());
  const color = parseColor(field.style.color);
  for (const line of layout.lines) {
    if (line.text === '') continue;
    await drawTextLine(res, page, t.stack, line.text, pad + line.x, pad + line.baseline, layout.fontSize, color);
  }
  page.pushOperators(popGraphicsState());
}

async function drawImageField(res: DocResources, page: PDFPage, pageNumber: number, p: ImagePlan) {
  const { field, asset } = p;
  const info = pageInfoFor(page, pageNumber);
  const frame = fieldFrameMatrix(info, field.rect);
  const content = contentFrameSize(field.style.rotation, frame.width, frame.height);
  page.pushOperators(pushGraphicsState(), cm(frame.matrix));
  if (field.style.background) {
    const c = parseColor(field.style.background, '#ffffff');
    page.pushOperators(setFillingRgbColor(c.red, c.green, c.blue), rectangle(0, 0, frame.width, frame.height), fill());
  }
  if (asset?.pdfBytes) {
    const image = await res.image(asset);
    page.pushOperators(cm(contentRotationMatrix(field.style.rotation, frame.width, frame.height)));
    page.pushOperators(rectangle(0, 0, content.width, content.height), clip(), endPath());
    const place = placeImage(image.width, image.height, content.width, content.height, field.style.fit, field.style.horizontalAlign, field.style.verticalAlign);
    page.drawImage(image, { x: place.x, y: place.y, width: place.width, height: place.height });
  }
  page.pushOperators(popGraphicsState());
}

const TRUTHY = /^(1|y|yes|true|x|✓|✔|on|checked|হ্যাঁ)$/i;

function uniqueFieldName(existing: Set<string>, base: string): string {
  const clean = base.replace(/[.\s]+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '') || 'field';
  let name = clean;
  let i = 2;
  while (existing.has(name)) name = `${clean}_${i++}`;
  existing.add(name);
  return name;
}

function replaceOp(r: ReplacePlan): ReplaceOp {
  const f = r.field;
  const color = f.style.colorOverride ? parseColor(f.style.colorOverride) : null;
  return {
    id: f.id,
    targets: f.targets,
    selection: f.selection,
    value: r.value,
    mode: r.mode === 'in-place' ? 'in-place' : 'remove',
    align: f.style.align,
    fit: f.style.fit,
    minScale: f.style.minScale,
    sizeScale: r.sizeScale,
    maxWidth: r.maxWidth,
    originalWidth: f.original.width,
    color: color ? [color.red * 255, color.green * 255, color.blue * 255] : null,
  };
}

/** Draw a replacement value in the chosen font where the original text object was removed. */
async function drawReplacementText(res: DocResources, page: PDFPage, r: ReplacePlan, outcome: ReplaceOutcome, issues: ValidationIssue[]) {
  const stack = r.stack!;
  const g = outcome.geometry;
  const size = g.effectiveSize;
  const widthAtOriginal = stack.measure(outcome.text, size);
  const fit = fitAndAlign(replaceOp(r), widthAtOriginal);
  const { ux, uy } = baselineDirection(g.matrix);
  const color = r.field.style.colorOverride ? parseColor(r.field.style.colorOverride) : rgb(g.color[0] / 255, g.color[1] / 255, g.color[2] / 255);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(ux, uy, -uy, ux, g.matrix[4], g.matrix[5]));
  await drawTextLine(res, page, stack, outcome.text, g.startOffset + fit.shift, 0, size * fit.scale, color);
  page.pushOperators(popGraphicsState());
  // The plan already warns when it predicted the overflow; only report a surprise.
  if (fit.overflow && !r.overflow) {
    issues.push({ code: 'text-too-long', severity: 'warning', fieldId: r.field.id, message: `${r.field.label}: the text runs past the field box.` });
  }
}

export async function generateFilledPdf(opts: GenerateOptions): Promise<GenerateResult> {
  const issues: ValidationIssue[] = [];
  let templateBytes = opts.templateBytes;
  let outcomes: ReplaceOutcome[] = [];
  const blocked = opts.plan.replacements.filter((r) => r.blocked);
  if (blocked.length) {
    throw new ReplaceError(`${blocked.map((b) => b.field.label).join(', ')}: the replacement cannot be done for this row (see the checks).`);
  }
  if (opts.plan.replacements.length > 0) {
    // True replacement first: PDFium rewrites or removes the original text objects.
    const P = await loadPdfium();
    const result = applyReplacements(P, opts.templateBytes, opts.plan.replacements.map(replaceOp));
    templateBytes = result.bytes;
    outcomes = result.outcomes;
    for (const o of outcomes) {
      const r = opts.plan.replacements.find((x) => x.field.id === o.id)!;
      if (o.overflow && !r.overflow) {
        issues.push({ code: 'text-too-long', severity: 'warning', fieldId: o.id, message: `${r.field.label}: the text runs past the field box.` });
      }
    }
  }
  const doc = await loadTemplateForEditing(templateBytes);
  doc.registerFontkit(fontkit);
  if (opts.title) doc.setTitle(opts.title);
  doc.setProducer('PDF Template Studio (pdf-lib)');
  doc.setModificationDate(new Date());
  const res = new DocResources(doc, opts.fontBytes);
  const pages = doc.getPages();
  const { plan } = opts;
  const interactive = opts.formMode === 'interactive';

  let form: ReturnType<PDFDocument['getForm']> | null = null;
  const getForm = () => (form ??= doc.getForm());

  // Existing AcroForm fields.
  let formFont: PDFFont | null = null;
  if (plan.forms.length > 0) {
    formFont = await res.font(opts.formFieldFont);
    for (const { field, value } of plan.forms) {
      try {
        const f = getForm().getFieldMaybe(field.name);
        if (!f) {
          issues.push({ code: 'form-value-invalid', severity: 'warning', message: `Form field "${field.name}" was not found in the PDF.` });
          continue;
        }
        if (f instanceof PDFTextField) {
          const maxLen = f.getMaxLength();
          f.setText(maxLen !== undefined && value.length > maxLen ? value.slice(0, maxLen) : value);
          if (maxLen !== undefined && value.length > maxLen) {
            issues.push({
              code: 'text-too-long',
              severity: 'warning',
              message: `Form field "${field.name}" accepts at most ${maxLen} characters; the value was shortened.`,
            });
          }
        } else if (f instanceof PDFCheckBox) {
          if (TRUTHY.test(value.trim())) f.check();
          else f.uncheck();
        } else if (f instanceof PDFDropdown) {
          if (value) {
            if (!f.getOptions().includes(value) && !f.isEditable()) {
              issues.push({ code: 'form-value-invalid', severity: 'warning', message: `Form field "${field.name}": "${value}" is not an option, left empty.` });
            } else f.select(value);
          }
        } else if (f instanceof PDFOptionList) {
          if (value && f.getOptions().includes(value)) f.select(value);
        } else if (f instanceof PDFRadioGroup) {
          if (value && f.getOptions().includes(value)) f.select(value);
          else if (value) issues.push({ code: 'form-value-invalid', severity: 'warning', message: `Form field "${field.name}": "${value}" is not an option.` });
        }
      } catch (err) {
        issues.push({ code: 'form-value-invalid', severity: 'warning', message: `Form field "${field.name}" could not be filled: ${String(err)}` });
      }
    }
  }

  // Overlay fields.
  const existingNames = interactive
    ? new Set(
        getForm()
          .getFields()
          .map((f) => f.getName()),
      )
    : new Set<string>();
  for (const t of plan.texts) {
    const page = pages[t.field.page - 1];
    if (!page) continue;
    if (interactive && t.field.style.rotation === 0) {
      // Keep the value editable: create a real form field at the same spot.
      const f = getForm();
      const info = pageInfoFor(page, t.field.page);
      const r = normRectToUserRect(info, t.field.rect);
      const tf = f.createTextField(uniqueFieldName(existingNames, t.field.label));
      const primary = t.stack.primary;
      const font = await res.font(primary.ref);
      if (t.field.style.fit === 'wrap' || t.field.style.fit === 'wrap-shrink') tf.enableMultiline();
      tf.setText(t.value);
      tf.setAlignment(t.field.style.align === 'center' ? TextAlignment.Center : t.field.style.align === 'right' ? TextAlignment.Right : TextAlignment.Left);
      tf.addToPage(page, {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        font,
        textColor: parseColor(t.field.style.color),
        backgroundColor: t.field.style.background ? parseColor(t.field.style.background) : undefined,
        borderWidth: 0,
        rotate: degrees(info.rotation),
      });
      tf.setFontSize(t.field.style.fit === 'shrink' || t.field.style.fit === 'wrap-shrink' ? 0 : t.layout.fontSize);
      try {
        tf.updateAppearances(font);
      } catch (err) {
        issues.push({
          code: 'unsupported-character',
          severity: 'warning',
          fieldId: t.field.id,
          message: `"${t.field.label}": interactive appearance could not be generated (${String(err)}).`,
        });
      }
      continue;
    }
    await drawTextField(res, page, t.field.page, t);
  }
  for (const p of plan.images) {
    const page = pages[p.field.page - 1];
    if (!page) continue;
    await drawImageField(res, page, p.field.page, p);
  }
  for (const o of outcomes) {
    if (o.mode !== 'remove') continue;
    const r = plan.replacements.find((x) => x.field.id === o.id)!;
    const page = pages[o.geometry.page - 1];
    if (page) await drawReplacementText(res, page, r, o, issues);
  }

  if (form || doc.catalog.getAcroForm()) {
    const f = getForm();
    if (plan.forms.length > 0 && formFont) {
      try {
        f.updateFieldAppearances(formFont);
      } catch (err) {
        issues.push({
          code: 'unsupported-character',
          severity: 'warning',
          message: `Form field appearances could not be generated with the chosen font: ${String(err)}`,
        });
      }
    }
    if (!interactive) {
      try {
        f.flatten({ updateFieldAppearances: false });
      } catch (err) {
        issues.push({ code: 'form-value-invalid', severity: 'warning', message: `Form fields could not be flattened: ${String(err)}` });
      }
    }
  }

  const bytes = await doc.save({ updateFieldAppearances: false, useObjectStreams: true });
  return { bytes, issues };
}
