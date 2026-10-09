import type {
  ExistingFormField,
  FieldSource,
  ImageField,
  SheetRow,
  TemplateField,
  TemplateProject,
  TextField,
  ValidationIssue,
} from '../../types/project';
import { FontStack, type FontLibrary } from '../fonts/engine';
import { DEFAULT_FONT } from '../fonts/standard';
import { aspectMismatch, ASPECT_TOLERANCE, effectiveDpi, LOW_DPI_THRESHOLD } from '../images/fit';
import type { ImageAsset } from '../images/load';
import type { ImageIndex } from '../images/match';
import { resolveText, sourceColumns } from '../mapping/values';
import { contentFrameSize, isRectOutsidePage, normToDisplayRect } from '../pdf/coords';
import { layoutText, type LayoutResult } from '../text/layout';

/**
 * A "row plan" is everything needed to draw one output document: the final
 * text for every field, its layout, the image chosen for every image field,
 * values for existing form fields, and the problems found along the way.
 * Validation, preview and export all use the same plan, so what the user is
 * warned about is exactly what gets exported.
 */

export interface ImageResolver {
  index: ImageIndex | null;
  assets: Map<string, ImageAsset>;
  overrides: Record<string, string>;
  /** Test images chosen for individual fields in the editor. */
  samples: Record<string, ImageAsset | undefined>;
}

export interface RenderContext {
  project: TemplateProject;
  fonts: FontLibrary;
  images: ImageResolver;
  now?: Date;
}

export interface TextPlan {
  field: TextField;
  value: string;
  stack: FontStack;
  layout: LayoutResult;
  contentWidth: number;
  contentHeight: number;
}

export interface ImagePlan {
  field: ImageField;
  asset: ImageAsset | null;
}

export interface FormPlan {
  field: ExistingFormField;
  value: string;
}

export interface RowPlan {
  rowIndex: number | null;
  texts: TextPlan[];
  images: ImagePlan[];
  forms: FormPlan[];
  issues: ValidationIssue[];
}

export const FORM_PREFIX = 'form:';

export function formTarget(name: string): string {
  return FORM_PREFIX + name;
}

function sourceFor(project: TemplateProject, target: string): FieldSource {
  return project.mapping[target] ?? { kind: 'none' };
}

export function fieldStack(ctx: RenderContext, field: TextField, issues: ValidationIssue[]): FontStack {
  const { fonts } = ctx;
  const primary = fonts.isPrepared(field.style.font) ? field.style.font : DEFAULT_FONT;
  if (primary !== field.style.font) {
    issues.push({
      code: 'font-missing',
      severity: 'error',
      fieldId: field.id,
      message: `"${field.label}" uses a font that is not loaded. Add it again in the Fonts panel or pick another font.`,
    });
  }
  let fallback = field.style.fallbackFont;
  if (fallback && !fonts.isPrepared(fallback)) {
    issues.push({
      code: 'font-missing',
      severity: 'warning',
      fieldId: field.id,
      message: `The fallback font of "${field.label}" is not loaded.`,
    });
    fallback = null;
  }
  return fonts.stack(primary, fallback);
}

export function layoutField(field: TextField, value: string, stack: FontStack, pageW: number, pageH: number) {
  const d = normToDisplayRect({ displayWidth: pageW, displayHeight: pageH }, field.rect);
  const content = contentFrameSize(field.style.rotation, d.width, d.height);
  const pad = Math.max(0, field.style.padding);
  const contentWidth = Math.max(0, content.width - 2 * pad);
  const contentHeight = Math.max(0, content.height - 2 * pad);
  const layout = layoutText(
    value,
    {
      width: contentWidth,
      height: contentHeight,
      fontSize: field.style.fontSize,
      minFontSize: field.style.minFontSize,
      lineHeight: field.style.lineHeight,
      fit: field.style.fit,
      align: field.style.align,
      verticalAlign: field.style.verticalAlign,
      ascent: stack.ascent,
      descent: stack.descent,
    },
    stack.measure,
  );
  return { layout, contentWidth, contentHeight };
}

function textValue(ctx: RenderContext, field: TextField, row: SheetRow | null, issues: ValidationIssue[], rowIndex: number | null): string {
  const source = sourceFor(ctx.project, field.id);
  if (!row) {
    // No data row: show the sample value, or what a fixed/date source gives.
    if (source.kind === 'fixed' || source.kind === 'date') return resolveText(source, null, ctx.now).value;
    if (field.sampleValue) return field.sampleValue;
    return resolveText(source, null, ctx.now).value;
  }
  const r = resolveText(source, row, ctx.now);
  for (const p of r.problems) {
    issues.push({ code: 'required-missing', severity: 'warning', fieldId: field.id, rowIndex: rowIndex ?? undefined, message: `${field.label}: ${p}` });
  }
  return r.value;
}

function imageFor(ctx: RenderContext, field: ImageField, row: SheetRow | null, issues: ValidationIssue[], rowIndex: number | null): ImageAsset | null {
  const source = sourceFor(ctx.project, field.id);
  const rowIdx = rowIndex ?? undefined;
  const severity = field.required ? 'error' : 'warning';
  if (source.kind === 'fixed-image') {
    const asset = ctx.images.assets.get(source.imageId) ?? null;
    if (!asset) {
      issues.push({ code: 'image-missing', severity, fieldId: field.id, rowIndex: rowIdx, message: `${field.label}: the chosen image is no longer loaded. Add it again on the Images step.` });
    }
    return checkAsset(asset, field, issues, rowIdx);
  }
  if (!row || source.kind !== 'column') {
    return checkAsset(ctx.images.samples[field.id] ?? null, field, issues, rowIdx);
  }
  const value = row.values[source.column];
  if (!ctx.images.index) {
    if (value != null && String(value).trim() !== '') {
      issues.push({ code: 'image-missing', severity, fieldId: field.id, rowIndex: rowIdx, message: `${field.label}: no image files have been added yet.` });
    }
    return null;
  }
  const match = ctx.images.index.match(value, ctx.images.overrides);
  switch (match.status) {
    case 'empty':
      return null;
    case 'not-found':
      issues.push({ code: 'image-missing', severity, fieldId: field.id, rowIndex: rowIdx, message: `${field.label}: no selected file matches "${String(value)}".` });
      return null;
    case 'ambiguous':
      issues.push({
        code: 'image-ambiguous',
        severity,
        fieldId: field.id,
        rowIndex: rowIdx,
        message: `${field.label}: "${String(value)}" matches ${match.candidates.length} files. Choose one on the Images step.`,
      });
      return null;
    default:
      return checkAsset(ctx.images.assets.get(match.fileId!) ?? null, field, issues, rowIdx);
  }
}

function checkAsset(asset: ImageAsset | null, field: ImageField, issues: ValidationIssue[], rowIndex: number | undefined): ImageAsset | null {
  if (!asset) return null;
  if (asset.error || !asset.pdfBytes) {
    issues.push({
      code: asset.kind === 'unknown' || asset.error?.includes('not supported') ? 'image-unsupported' : 'image-invalid',
      severity: field.required ? 'error' : 'warning',
      fieldId: field.id,
      rowIndex,
      message: `${field.label}: ${asset.name} — ${asset.error ?? 'unusable image'}`,
    });
    return null;
  }
  return asset;
}

function imageQualityIssues(field: ImageField, asset: ImageAsset, pageW: number, pageH: number, issues: ValidationIssue[], rowIndex: number | undefined) {
  const d = normToDisplayRect({ displayWidth: pageW, displayHeight: pageH }, field.rect);
  const box = contentFrameSize(field.style.rotation, d.width, d.height);
  const mismatch = aspectMismatch(asset.width, asset.height, box.width, box.height);
  if (mismatch > ASPECT_TOLERANCE) {
    const effect =
      field.style.fit === 'cover' ? 'parts of the image will be cropped' : field.style.fit === 'stretch' ? 'the image will look stretched' : 'there will be empty space around it';
    issues.push({
      code: 'image-aspect',
      severity: field.style.fit === 'contain' ? 'info' : 'warning',
      fieldId: field.id,
      rowIndex,
      message: `${field.label}: ${asset.name} has a different shape than the field (${asset.width}×${asset.height}px); ${effect}.`,
    });
  }
  const dpi = effectiveDpi(asset.width, asset.height, box.width, box.height, field.style.fit);
  if (dpi < LOW_DPI_THRESHOLD) {
    issues.push({
      code: 'image-low-resolution',
      severity: 'warning',
      fieldId: field.id,
      rowIndex,
      message: `${field.label}: ${asset.name} is small (${asset.width}×${asset.height}px) and will be enlarged to about ${Math.round(dpi)} dpi; it may look blurry.`,
    });
  }
}

export function planRow(ctx: RenderContext, row: SheetRow | null, rowIndex: number | null): RowPlan {
  const { project } = ctx;
  const issues: ValidationIssue[] = [];
  const texts: TextPlan[] = [];
  const images: ImagePlan[] = [];
  const forms: FormPlan[] = [];
  const rowIdx = rowIndex ?? undefined;
  const pages = project.pdf?.pages ?? [];

  for (const field of project.fields) {
    const page = pages[field.page - 1];
    if (!page) continue;
    if (field.type === 'text') {
      const value = textValue(ctx, field, row, issues, rowIndex);
      const stack = fieldStack(ctx, field, issues);
      const { layout, contentWidth, contentHeight } = layoutField(field, value, stack, page.displayWidth, page.displayHeight);
      texts.push({ field, value, stack, layout, contentWidth, contentHeight });
      if (field.required && value.trim() === '') {
        issues.push({ code: 'required-missing', severity: 'error', fieldId: field.id, rowIndex: rowIdx, message: `${field.label} is required but has no value.` });
      }
      const missing = stack.missing(value);
      if (missing.length > 0) {
        issues.push({
          code: 'unsupported-character',
          severity: 'error',
          fieldId: field.id,
          rowIndex: rowIdx,
          message: `${field.label}: the font cannot draw ${missing
            .slice(0, 8)
            .map((c) => `"${c}"`)
            .join(', ')}${missing.length > 8 ? '…' : ''}. Choose a font (or fallback font) that supports these characters.`,
        });
      }
      if (layout.overflow && value.trim() !== '') {
        const how =
          field.style.fit === 'overflow'
            ? 'runs past the field edge'
            : field.style.fit === 'clip'
              ? 'is cut off'
              : layout.hitMinimum
                ? `does not fit even at ${layout.fontSize}pt`
                : layout.droppedLines > 0
                  ? `does not fit; ${layout.droppedLines} line(s) are hidden`
                  : 'does not fit';
        issues.push({ code: 'text-too-long', severity: 'warning', fieldId: field.id, rowIndex: rowIdx, message: `${field.label}: the text ${how}.` });
      }
    } else {
      const asset = imageFor(ctx, field, row, issues, rowIndex);
      images.push({ field, asset });
      if (asset) imageQualityIssues(field, asset, page.displayWidth, page.displayHeight, issues, rowIdx);
      else if (field.required && !issues.some((i) => i.fieldId === field.id && i.severity === 'error')) {
        issues.push({ code: 'required-missing', severity: 'error', fieldId: field.id, rowIndex: rowIdx, message: `${field.label} is required but has no image.` });
      }
    }
  }

  for (const ff of project.formFields) {
    const source = sourceFor(project, formTarget(ff.name));
    if (source.kind === 'none' || !ff.fillable) continue;
    const r = resolveText(source, row, ctx.now);
    forms.push({ field: ff, value: r.value });
    if ((ff.kind === 'dropdown' || ff.kind === 'listbox' || ff.kind === 'radio') && r.value && ff.options.length > 0 && !ff.options.includes(r.value)) {
      issues.push({
        code: 'form-value-invalid',
        severity: 'warning',
        rowIndex: rowIdx,
        message: `Form field "${ff.name}": "${r.value}" is not one of its options (${ff.options.slice(0, 6).join(', ')}).`,
      });
    }
    if (ff.kind === 'text') {
      const fontRef = project.settings.formFieldFont;
      if (ctx.fonts.isPrepared(fontRef)) {
        const missing = ctx.fonts.stack(fontRef, null).missing(r.value);
        if (missing.length > 0) {
          issues.push({
            code: 'unsupported-character',
            severity: 'error',
            rowIndex: rowIdx,
            message: `Form field "${ff.name}": the form font cannot draw ${missing.slice(0, 8).map((c) => `"${c}"`).join(', ')}. Choose a different form field font in the Fonts panel.`,
          });
        }
      }
    }
    if (ff.required && r.value.trim() === '') {
      issues.push({ code: 'required-missing', severity: 'error', rowIndex: rowIdx, message: `Form field "${ff.name}" is required but has no value.` });
    }
  }

  return { rowIndex, texts, images, forms, issues };
}

/** Problems with the template itself (not tied to a data row). */
export function templateIssues(project: TemplateProject, columns: string[] | null): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pageCount = project.pdf?.pageCount ?? 0;
  for (const f of project.fields) {
    if (f.page < 1 || f.page > pageCount) {
      issues.push({ code: 'field-outside-page', severity: 'error', fieldId: f.id, message: `"${f.label}" is on page ${f.page}, which does not exist in this PDF.` });
    } else if (isRectOutsidePage(f.rect)) {
      issues.push({ code: 'field-outside-page', severity: 'warning', fieldId: f.id, message: `"${f.label}" extends past the edge of page ${f.page}.` });
    }
    if (f.rect.w <= 0.002 || f.rect.h <= 0.002) {
      issues.push({ code: 'field-outside-page', severity: 'warning', fieldId: f.id, message: `"${f.label}" is too small to hold anything.` });
    }
  }
  if (columns) {
    const used = new Set<string>();
    for (const [target, source] of Object.entries(project.mapping)) {
      for (const c of sourceColumns(source)) used.add(c.toLowerCase());
      if (source.kind === 'column' && !columns.some((c) => c.toLowerCase() === source.column.toLowerCase())) {
        issues.push({ code: 'unmapped-required', severity: 'warning', message: `${labelForTarget(project, target)} is matched to "${source.column}", which is not in the data file.` });
      }
    }
    if (project.settings.imageColumn) used.add(project.settings.imageColumn.toLowerCase());
    for (const f of project.fields) {
      const s = project.mapping[f.id];
      if (f.required && (!s || s.kind === 'none')) {
        issues.push({
          code: 'unmapped-required',
          severity: 'error',
          fieldId: f.id,
          message: `"${f.label}" is required but not matched to a column or value.`,
        });
      }
    }
    const unused = columns.filter((c) => !used.has(c.toLowerCase()));
    if (unused.length > 0) {
      issues.push({ code: 'unused-column', severity: 'info', message: `Columns not used by any field: ${unused.join(', ')}.` });
    }
  }
  return issues;
}

export function labelForTarget(project: TemplateProject, target: string): string {
  if (target.startsWith(FORM_PREFIX)) return `Form field "${target.slice(FORM_PREFIX.length)}"`;
  const f = project.fields.find((x) => x.id === target);
  return f ? `"${f.label}"` : 'A removed field';
}

export function isRowValid(plan: RowPlan): boolean {
  return !plan.issues.some((i) => i.severity === 'error');
}

export function fieldById(project: TemplateProject, id: string): TemplateField | undefined {
  return project.fields.find((f) => f.id === id);
}
