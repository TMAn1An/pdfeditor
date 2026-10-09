import type { PageInfo, ReplaceField, SheetRow, ValidationIssue } from '../../types/project';
import type { FontStack, FontLibrary } from '../fonts/engine';
import { resolveText } from '../mapping/values';
import type { FieldSource, TemplateProject } from '../../types/project';
import { normRectToUserRect } from '../pdf/coords';
import { COMPLEX_SCRIPT_RE, extentAlong, type PdfTextIndex } from '../pdfium/textIndex';
import { fitAndAlign, replacedText } from '../pdfium/replace';

/**
 * Planning for true text replacement fields (see ReplaceField). Decides, per
 * row, whether the original font can be reused (PDFium edits the text object
 * in place) or whether the object must be removed and the value drawn in the
 * chosen replacement font — and reports every reason explicitly.
 */

export interface ReplacePlan {
  field: ReplaceField;
  /** Value for the selected part. */
  value: string;
  /** Whole new text of the object (unchanged prefix + value + unchanged suffix). */
  fullText: string;
  mode: 'in-place' | 'font';
  /** Font stack for `font` mode. */
  stack: FontStack | null;
  maxWidth: number;
  sizeScale: number;
  /** Estimated final scale and overflow (exact values are computed during export). */
  scale: number;
  overflow: boolean;
  /** The plan cannot be executed (an error issue explains why). */
  blocked: boolean;
}

interface Ctx {
  project: TemplateProject;
  fonts: FontLibrary;
  textIndex?: PdfTextIndex | null;
  now?: Date;
}

function sourceFor(project: TemplateProject, id: string): FieldSource {
  return project.mapping[id] ?? { kind: 'none' };
}

export function replaceValue(ctx: Ctx, field: ReplaceField, row: SheetRow | null, issues: ValidationIssue[], rowIndex: number | null): string {
  const source = sourceFor(ctx.project, field.id);
  if (!row) {
    if (source.kind === 'fixed' || source.kind === 'date') return resolveText(source, null, ctx.now).value;
    return field.sampleValue;
  }
  const r = resolveText(source, row, ctx.now);
  for (const p of r.problems) {
    issues.push({ code: 'required-missing', severity: 'warning', fieldId: field.id, rowIndex: rowIndex ?? undefined, message: `${field.label}: ${p}` });
  }
  if (source.kind === 'none') return field.sampleValue;
  return r.value;
}

/** Allowed width along the baseline: the field box projected on the text direction. */
export function replaceMaxWidth(field: ReplaceField, page: PageInfo): number {
  const r = normRectToUserRect(page, field.rect);
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  const ext = extentAlong(corners, field.original.matrix);
  // For rotated text the axis-aligned box overestimates; never go below the original width.
  return Math.max(field.original.width, ext.max - ext.min);
}

export function sizeScaleOf(field: ReplaceField): number {
  const o = field.style.fontSizeOverride;
  return o && o > 0 && field.original.effectiveSize > 0 ? o / field.original.effectiveSize : 1;
}

export function planReplace(
  ctx: Ctx,
  field: ReplaceField,
  page: PageInfo,
  row: SheetRow | null,
  rowIndex: number | null,
  issues: ValidationIssue[],
): ReplacePlan {
  const rowIdx = rowIndex ?? undefined;
  const value = replaceValue(ctx, field, row, issues, rowIndex);
  const fullText = replacedText(
    field.targets.map((t) => t.text),
    field.selection,
    value,
  );
  const maxWidth = replaceMaxWidth(field, page);
  const sizeScale = sizeScaleOf(field);
  const plan: ReplacePlan = { field, value, fullText, mode: 'in-place', stack: null, maxWidth, sizeScale, scale: sizeScale, overflow: false, blocked: false };
  const err = (message: string, code: ValidationIssue['code'] = 'replace-font') => {
    issues.push({ code, severity: 'error', fieldId: field.id, rowIndex: rowIdx, message: `${field.label}: ${message}` });
    plan.blocked = true;
  };

  if (field.required && value.trim() === '') {
    issues.push({ code: 'required-missing', severity: 'error', fieldId: field.id, rowIndex: rowIdx, message: `${field.label} is required but has no value.` });
  }

  const index = ctx.textIndex;
  const first = field.targets[0];
  if (!index || !first) {
    err('the PDF text engine is not ready, so this replacement cannot be checked yet.', 'replace-unsupported');
    return plan;
  }
  const info = index.object(first.page, first.objectIndex);
  if (!info || info.text !== first.text) {
    err(`the original text “${first.text}” was not found at its recorded place in this PDF. Select it again.`, 'replace-unsupported');
    return plan;
  }

  // Can the original font draw the new text?
  let originalProblem: string | null = info.reuseBlocker;
  if (!originalProblem && COMPLEX_SCRIPT_RE.test(fullText)) {
    originalProblem = 'the new text uses a script that needs OpenType shaping, which in-place PDF text editing cannot do';
  }
  if (!originalProblem) {
    const missing = index.missingChars(first.page, first.objectIndex, fullText);
    if (missing.length) {
      originalProblem = `the original font “${info.fontName}” ${info.subset ? '(a subset with only some characters) ' : ''}has no glyphs for ${missing
        .slice(0, 10)
        .map((c) => `“${c}”`)
        .join(' ')}`;
    }
  }

  const replacement = field.style.replacementFont;
  const applyReplacementFont = () => {
    if (!replacement) return false;
    if (!ctx.fonts.isPrepared(replacement)) {
      err('the chosen replacement font is not loaded. Add it again in the Fonts panel.', 'font-missing');
      return true;
    }
    const fallback = field.style.fallbackFont && ctx.fonts.isPrepared(field.style.fallbackFont) ? field.style.fallbackFont : null;
    plan.stack = ctx.fonts.stack(replacement, fallback);
    plan.mode = 'font';
    const missing = plan.stack.missing(fullText);
    if (missing.length)
      err(
        `the replacement font cannot draw ${missing
          .slice(0, 8)
          .map((c) => `“${c}”`)
          .join(' ')}.`,
        'unsupported-character',
      );
    return true;
  };

  switch (field.style.fontMode) {
    case 'original':
      if (originalProblem) err(`${originalProblem}. Choose “Use a replacement font” or “Original font when possible”, and pick a font.`);
      break;
    case 'replacement':
      if (!applyReplacementFont()) err('no replacement font is chosen.');
      break;
    case 'auto':
      if (originalProblem) {
        if (applyReplacementFont()) {
          if (!plan.blocked) {
            issues.push({
              code: 'replace-font',
              severity: 'info',
              fieldId: field.id,
              rowIndex: rowIdx,
              message: `${field.label}: ${originalProblem}, so this row uses the replacement font.`,
            });
          }
        } else {
          err(`${originalProblem}. Choose a replacement font for this field.`);
        }
      }
      break;
  }
  if (plan.blocked) return plan;

  // Width estimate at the original size.
  const width = plan.mode === 'in-place' ? index.measure(first.page, first.objectIndex, fullText) : plan.stack!.measure(fullText, field.original.effectiveSize);
  const fit = fitAndAlign(
    { align: field.style.align, fit: field.style.fit, minScale: field.style.minScale, sizeScale, maxWidth, originalWidth: field.original.width },
    width,
  );
  plan.scale = fit.scale;
  plan.overflow = fit.overflow;
  if (fit.overflow && value.trim()) {
    issues.push({
      code: 'text-too-long',
      severity: 'warning',
      fieldId: field.id,
      rowIndex: rowIdx,
      message:
        field.style.fit === 'shrink'
          ? `${field.label}: the text does not fit even at ${Math.round(fit.scale * 100)}% size; it runs past the field box.`
          : `${field.label}: the text is wider than the field box (${Math.round(fit.finalWidth)} pt of ${Math.round(maxWidth)} pt). Turn on shrink-to-fit, widen the box, or set a smaller size.`,
    });
  } else if (fit.scale < sizeScale - 0.005 && value.trim()) {
    issues.push({
      code: 'text-too-long',
      severity: 'info',
      fieldId: field.id,
      rowIndex: rowIdx,
      message: `${field.label}: shrunk to ${Math.round((fit.scale / sizeScale) * 100)}% to fit.`,
    });
  }
  return plan;
}
