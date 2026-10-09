import type { ImageField, NormRect, TemplateField, TextField, TemplateProject } from '../../types/project';
import { newId } from '../../lib/id';
import { DEFAULT_FONT } from '../../lib/fonts/standard';
import { clampRectToPage } from '../../lib/pdf/coords';

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
