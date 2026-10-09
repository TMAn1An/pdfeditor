import type { ImageField, NormRect, PageInfo, ReplaceField, TemplateField, TextField, TemplateProject } from '../../types/project';
import { extentAlong, type TextObjectInfo } from '../../lib/pdfium/textIndex';
import { newId } from '../../lib/id';
import { DEFAULT_FONT } from '../../lib/fonts/standard';
import { clampRectToPage, userRectToNorm } from '../../lib/pdf/coords';

export function nextLabel(project: TemplateProject, base: string): string {
  const labels = new Set(project.fields.map((f) => f.label.toLowerCase()));
  if (!labels.has(base.toLowerCase())) return base;
  let i = 2;
  while (labels.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

export function createTextField(project: TemplateProject, page: number, rect: NormRect, label?: string, style: Partial<TextField['style']> = {}): TextField {
  return {
    id: newId('fld'),
    type: 'text',
    label: nextLabel(project, label?.trim() || 'Text field'),
    page,
    rect,
    required: false,
    sampleValue: '',
    style: {
      font: DEFAULT_FONT,
      fallbackFont: null,
      fontSize: 14,
      minFontSize: 6,
      lineHeight: 1.2,
      color: '#000000',
      align: 'left',
      verticalAlign: 'middle',
      padding: 2,
      fit: 'shrink',
      rotation: 0,
      background: null,
      ...style,
    },
  };
}

export function createImageField(project: TemplateProject, page: number, rect: NormRect, label?: string): ImageField {
  return {
    id: newId('fld'),
    type: 'image',
    label: nextLabel(project, label?.trim() || 'Photo'),
    page,
    rect,
    required: false,
    style: { fit: 'contain', background: null, horizontalAlign: 'center', verticalAlign: 'middle', rotation: 0 },
  };
}

export function duplicateField(project: TemplateProject, field: TemplateField): TemplateField {
  const offset = 0.02;
  const rect = clampRectToPage({ ...field.rect, x: field.rect.x + offset, y: field.rect.y + offset });
  const copy = structuredClone(field);
  copy.id = newId('fld');
  copy.label = nextLabel(project, `${field.label} copy`);
  copy.rect = rect;
  delete copy.replacement;
  return copy;
}

export function replaceField(project: TemplateProject, field: TemplateField): TemplateProject {
  return { ...project, fields: project.fields.map((f) => (f.id === field.id ? field : f)) };
}

export function removeField(project: TemplateProject, id: string): TemplateProject {
  const mapping = { ...project.mapping };
  delete mapping[id];
  return { ...project, fields: project.fields.filter((f) => f.id !== id), mapping };
}

/**
 * Create a true-replacement field from one or more existing text objects
 * (same page, reading order) and the selected part of their joined text.
 */
export function createReplaceField(
  project: TemplateProject,
  objects: TextObjectInfo[],
  selection: { start: number; end: number },
  label: string,
  pageInfo: PageInfo,
  availableChars: string,
): ReplaceField {
  const first = objects[0]!;
  const bounds = objects.reduce<[number, number, number, number]>(
    (acc, o) => [Math.min(acc[0], o.bounds[0]), Math.min(acc[1], o.bounds[1]), Math.max(acc[2], o.bounds[2]), Math.max(acc[3], o.bounds[3])],
    [...first.bounds],
  );
  const quads = objects.flatMap((o) => [
    { x: o.bounds[0], y: o.bounds[1] },
    { x: o.bounds[2], y: o.bounds[3] },
  ]);
  const ext = extentAlong(quads, first.matrix);
  const width = objects.length === 1 ? first.width : Math.max(first.width, ext.max - ext.min);
  // Guess the alignment: text centred on the page is usually centred in the design.
  const textCenter = (bounds[0] + bounds[2]) / 2;
  const pageCenter = (pageInfo.box.x0 + pageInfo.box.x1) / 2;
  const horizontal = Math.abs(first.rotation) < 1;
  const align: ReplaceField['style']['align'] =
    horizontal && Math.abs(textCenter - pageCenter) < (pageInfo.box.x1 - pageInfo.box.x0) * 0.03 ? 'center' : 'left';
  // Box the new text may use: the original bounds, widened by 30% in the direction text can grow.
  const grow = (bounds[2] - bounds[0]) * 0.3;
  const boxUser = align === 'center' ? [bounds[0] - grow / 2, bounds[1], bounds[2] + grow / 2, bounds[3]] : [bounds[0], bounds[1], bounds[2] + grow, bounds[3]];
  const rect = clampRectToPage(userRectToNorm(pageInfo, boxUser[0]!, boxUser[1]!, boxUser[2]!, boxUser[3]!));
  const joined = objects.map((o) => o.text).join('');
  const canReuse = !first.reuseBlocker;
  return {
    id: newId('fld'),
    type: 'replace',
    label: nextLabel(project, label.trim() || 'Text'),
    page: first.page,
    rect,
    required: false,
    targets: objects.map((o) => ({ page: o.page, objectIndex: o.index, text: o.text })),
    selection,
    sampleValue: joined.slice(selection.start, selection.end),
    original: {
      fontName: first.fontName,
      embedded: first.embedded,
      subset: first.subset,
      standardFont: first.standardFont,
      fontSize: first.fontSize,
      effectiveSize: first.effectiveSize,
      matrix: first.matrix,
      rotation: first.rotation,
      color: first.color,
      bounds,
      width,
      availableChars,
      reuseBlocker: first.reuseBlocker,
    },
    style: {
      fontMode: canReuse ? 'auto' : 'replacement',
      replacementFont: null,
      fallbackFont: null,
      align,
      fit: 'shrink',
      minScale: 0.5,
      fontSizeOverride: null,
      colorOverride: null,
    },
  };
}
