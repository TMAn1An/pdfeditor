import {
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  type ExistingFormField,
  type FieldSource,
  type FontAsset,
  type FontRef,
  type ImageField,
  type NormRect,
  type PageInfo,
  type PdfDocumentMeta,
  type ProjectSettings,
  type TemplateField,
  type TemplateProject,
  type TextField,
} from '../../types/project';
import { DEFAULT_FONT, isValidStandardFontId } from '../fonts/standard';
import { newId } from '../id';

/**
 * Versioned project format.
 *
 * Project files are plain data. Loading one never executes anything: the
 * JSON is parsed with JSON.parse and every value is checked against the
 * expected shape before it is used. Unknown keys are dropped.
 */

export const MAX_PROJECT_JSON_BYTES = 10 * 1024 * 1024;
const MAX_FIELDS = 2000;
const MAX_LABEL = 200;
const MAX_TEXT = 20000;

export function defaultSettings(): ProjectSettings {
  return {
    storePdfInBrowser: true,
    formFieldFont: DEFAULT_FONT,
    imageColumn: null,
    exportDefaults: { fileNamePattern: '{template} - {row}', formMode: 'flatten', zip: true },
  };
}

export function createProject(name = 'Untitled template'): TemplateProject {
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_FORMAT_VERSION,
    id: newId('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    pdf: null,
    fields: [],
    formFields: [],
    mapping: {},
    knownColumns: [],
    fonts: [],
    settings: defaultSettings(),
  };
}

export interface ProjectLoadResult {
  project: TemplateProject;
  warnings: string[];
  migratedFrom: number | null;
}

export class ProjectFileError extends Error {}

type Json = Record<string, unknown>;

/**
 * Migrations from older format versions. Each entry upgrades a project of
 * version N to N+1. Version 0 was the pre-release layout that stored fields
 * under `template.fields` and colors as numbers; it is kept here as the
 * example of how future migrations should be added.
 */
const MIGRATIONS: Record<number, (p: Json) => Json> = {
  0: (p) => {
    const template = isObj(p.template) ? p.template : {};
    return {
      ...p,
      format: PROJECT_FORMAT,
      version: 1,
      fields: Array.isArray(p.fields) ? p.fields : Array.isArray(template.fields) ? template.fields : [],
      mapping: isObj(p.mapping) ? p.mapping : {},
    };
  },
};

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function color(v: unknown, fallback: string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
}

function fontRef(v: unknown, fonts: FontAsset[], fallback: FontRef | null): FontRef | null {
  if (typeof v !== 'string') return fallback;
  if (v.startsWith('std:') && isValidStandardFontId(v.slice(4))) return v as FontRef;
  if (v.startsWith('custom:') && fonts.some((f) => f.id === v.slice(7))) return v as FontRef;
  return fallback;
}

function rect(v: unknown): NormRect | null {
  if (!isObj(v)) return null;
  const r = { x: num(v.x, NaN, -1, 2), y: num(v.y, NaN, -1, 2), w: num(v.w, NaN, 0, 2), h: num(v.h, NaN, 0, 2) };
  return Object.values(r).every(Number.isFinite) ? r : null;
}

const QUARTERS = [0, 90, 180, 270] as const;
const H_ALIGN = ['left', 'center', 'right'] as const;
const V_ALIGN = ['top', 'middle', 'bottom'] as const;
const FITS = ['shrink', 'wrap', 'wrap-shrink', 'clip', 'overflow'] as const;
const IMAGE_FITS = ['contain', 'cover', 'stretch'] as const;
const TRANSFORMS = ['none', 'trim', 'upper', 'lower', 'title', 'bengali-digits'] as const;
const FORM_KINDS = ['text', 'checkbox', 'radio', 'dropdown', 'listbox', 'button', 'signature', 'unknown'] as const;

function parseField(v: unknown, fonts: FontAsset[], pageCount: number, warnings: string[]): TemplateField | null {
  if (!isObj(v)) return null;
  const r = rect(v.rect);
  const type = v.type;
  if (!r || (type !== 'text' && type !== 'image')) {
    warnings.push('A field with an invalid position or type was skipped.');
    return null;
  }
  const id = typeof v.id === 'string' && /^[\w-]{1,64}$/.test(v.id) ? v.id : newId('fld');
  const page = Math.round(num(v.page, 1, 1, 100000));
  if (pageCount > 0 && page > pageCount) warnings.push(`Field "${str(v.label, id, MAX_LABEL)}" refers to page ${page}, which the PDF does not have.`);
  const base = {
    id,
    label: str(v.label, 'Field', MAX_LABEL) || 'Field',
    page,
    rect: r,
    required: bool(v.required, false),
    ...(isObj(v.replacement) ? { replacement: { originalText: str(v.replacement.originalText, '', 2000) } } : {}),
  };
  const s = isObj(v.style) ? v.style : {};
  if (type === 'text') {
    const font = fontRef(s.font, fonts, DEFAULT_FONT)!;
    if (typeof s.font === 'string' && s.font !== font) warnings.push(`Field "${base.label}" used a font that is not in the project; Helvetica is used instead.`);
    const fontSize = num(s.fontSize, 12, 1, 400);
    const field: TextField = {
      ...base,
      type: 'text',
      sampleValue: str(v.sampleValue, ''),
      style: {
        font,
        fallbackFont: fontRef(s.fallbackFont, fonts, null),
        fontSize,
        minFontSize: num(s.minFontSize, Math.min(6, fontSize), 1, fontSize),
        lineHeight: num(s.lineHeight, 1.2, 0.5, 4),
        color: color(s.color, '#000000') ?? '#000000',
        align: oneOf(s.align, H_ALIGN, 'left'),
        verticalAlign: oneOf(s.verticalAlign, V_ALIGN, 'middle'),
        padding: num(s.padding, 2, 0, 200),
        fit: oneOf(s.fit, FITS, 'shrink'),
        rotation: oneOf(s.rotation, QUARTERS, 0),
        background: color(s.background, null),
      },
    };
    return field;
  }
  const field: ImageField = {
    ...base,
    type: 'image',
    style: {
      fit: oneOf(s.fit, IMAGE_FITS, 'contain'),
      background: color(s.background, null),
      horizontalAlign: oneOf(s.horizontalAlign, H_ALIGN, 'center'),
      verticalAlign: oneOf(s.verticalAlign, V_ALIGN, 'middle'),
      rotation: oneOf(s.rotation, QUARTERS, 0),
    },
  };
  return field;
}

function parseSource(v: unknown): FieldSource | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case 'none':
      return { kind: 'none' };
    case 'column':
      if (typeof v.column !== 'string' || !v.column) return null;
      return {
        kind: 'column',
        column: str(v.column, '', 500),
        transform: oneOf(v.transform, TRANSFORMS, 'none'),
        ...(typeof v.dateFormat === 'string' && v.dateFormat ? { dateFormat: str(v.dateFormat, '', 100) } : {}),
      };
    case 'fixed':
      return { kind: 'fixed', value: str(v.value, '') };
    case 'template':
      return { kind: 'template', template: str(v.template, ''), transform: oneOf(v.transform, TRANSFORMS, 'none') };
    case 'date': {
      const from = v.from === 'today' ? 'today' : isObj(v.from) && typeof v.from.column === 'string' ? { column: str(v.from.column, '', 500) } : null;
      if (!from) return null;
      return { kind: 'date', from, format: str(v.format, 'D MMMM YYYY', 100), transform: oneOf(v.transform, TRANSFORMS, 'none') };
    }
    case 'fixed-image':
      return typeof v.imageId === 'string' ? { kind: 'fixed-image', imageId: str(v.imageId, '', 100) } : null;
    default:
      return null;
  }
}

function parsePdfMeta(v: unknown): PdfDocumentMeta | null {
  if (!isObj(v) || !Array.isArray(v.pages)) return null;
  const pages: PageInfo[] = [];
  for (const p of v.pages) {
    if (!isObj(p) || !isObj(p.box)) return null;
    const box = { x0: num(p.box.x0, NaN), y0: num(p.box.y0, NaN), x1: num(p.box.x1, NaN), y1: num(p.box.y1, NaN) };
    if (!Object.values(box).every(Number.isFinite)) return null;
    pages.push({
      pageNumber: Math.round(num(p.pageNumber, pages.length + 1, 1)),
      box,
      rotation: oneOf(p.rotation, QUARTERS, 0),
      displayWidth: num(p.displayWidth, 612, 1, 1e6),
      displayHeight: num(p.displayHeight, 792, 1, 1e6),
    });
  }
  return {
    fileName: str(v.fileName, 'template.pdf', 300),
    byteLength: num(v.byteLength, 0, 0),
    pageCount: pages.length,
    sha256: typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256) ? v.sha256 : '',
    title: typeof v.title === 'string' ? str(v.title, '', 300) : undefined,
    pages,
    hasAcroForm: bool(v.hasAcroForm, false),
  };
}

function parseFonts(v: unknown): FontAsset[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f): FontAsset[] => {
    if (!isObj(f) || typeof f.id !== 'string' || !/^[\w-]{1,64}$/.test(f.id)) return [];
    return [
      {
        id: f.id,
        name: str(f.name, 'Font', 200),
        fileName: str(f.fileName, 'font.ttf', 300),
        family: str(f.family, '', 200),
        postscriptName: str(f.postscriptName, '', 200),
        glyphCount: Math.round(num(f.glyphCount, 0, 0)),
        format: oneOf(f.format, ['ttf', 'otf'] as const, 'ttf'),
      },
    ];
  });
}

function parseFormFields(v: unknown): ExistingFormField[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f): ExistingFormField[] => {
    if (!isObj(f) || typeof f.name !== 'string') return [];
    return [
      {
        name: str(f.name, '', 500),
        kind: oneOf(f.kind, FORM_KINDS, 'unknown'),
        readOnly: bool(f.readOnly, false),
        required: bool(f.required, false),
        multiline: bool(f.multiline, false),
        options: Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === 'string').slice(0, 500) : [],
        widgets: Array.isArray(f.widgets)
          ? f.widgets.flatMap((w) => {
              const r = isObj(w) ? rect(w.rect) : null;
              return r && isObj(w) ? [{ page: Math.round(num(w.page, 1, 1)), rect: r }] : [];
            })
          : [],
        fillable: bool(f.fillable, false),
      },
    ];
  });
}

/** Validate (and migrate) parsed project JSON. Throws ProjectFileError if unusable. */
export function validateProject(input: unknown): ProjectLoadResult {
  if (!isObj(input)) throw new ProjectFileError('This is not a project file.');
  let data: Json = input;
  const format = data.format;
  const version = typeof data.version === 'number' ? data.version : format === undefined && 'template' in data ? 0 : NaN;
  if (format !== undefined && format !== PROJECT_FORMAT) throw new ProjectFileError('This file is not a PDF Template Studio project.');
  if (!Number.isInteger(version) || version < 0) throw new ProjectFileError('The project file has no valid version number.');
  if (version > PROJECT_FORMAT_VERSION) {
    throw new ProjectFileError(`This project was saved by a newer version of the app (format ${version}). Update the app to open it.`);
  }
  let migratedFrom: number | null = null;
  for (let v = version; v < PROJECT_FORMAT_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new ProjectFileError(`No upgrade path from project format ${v}.`);
    data = step(data);
    migratedFrom ??= version;
  }

  const warnings: string[] = [];
  const pdf = parsePdfMeta(data.pdf);
  const fonts = parseFonts(data.fonts);
  const rawFields = Array.isArray(data.fields) ? data.fields.slice(0, MAX_FIELDS) : [];
  const fields: TemplateField[] = [];
  const ids = new Set<string>();
  for (const raw of rawFields) {
    const f = parseField(raw, fonts, pdf?.pageCount ?? 0, warnings);
    if (!f) continue;
    if (ids.has(f.id)) f.id = newId('fld');
    ids.add(f.id);
    fields.push(f);
  }
  const mapping: Record<string, FieldSource> = {};
  if (isObj(data.mapping)) {
    for (const [k, v] of Object.entries(data.mapping)) {
      const s = parseSource(v);
      if (s && k.length <= 600) mapping[k] = s;
      else warnings.push(`An invalid mapping entry was skipped.`);
    }
  }
  const s = isObj(data.settings) ? data.settings : {};
  const d = defaultSettings();
  const ed = isObj(s.exportDefaults) ? s.exportDefaults : {};
  const settings: ProjectSettings = {
    storePdfInBrowser: bool(s.storePdfInBrowser, d.storePdfInBrowser),
    formFieldFont: fontRef(s.formFieldFont, fonts, DEFAULT_FONT)!,
    imageColumn: typeof s.imageColumn === 'string' ? str(s.imageColumn, '', 500) : null,
    exportDefaults: {
      fileNamePattern: str(ed.fileNamePattern, d.exportDefaults.fileNamePattern, 300) || d.exportDefaults.fileNamePattern,
      formMode: oneOf(ed.formMode, ['flatten', 'interactive'] as const, 'flatten'),
      zip: bool(ed.zip, true),
    },
  };
  const now = new Date().toISOString();
  const project: TemplateProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_FORMAT_VERSION,
    id: typeof data.id === 'string' && /^[\w-]{1,64}$/.test(data.id) ? data.id : newId('prj'),
    name: str(data.name, 'Imported template', 200) || 'Imported template',
    createdAt: str(data.createdAt, now, 40),
    updatedAt: str(data.updatedAt, now, 40),
    pdf,
    fields,
    formFields: parseFormFields(data.formFields),
    mapping,
    knownColumns: Array.isArray(data.knownColumns) ? data.knownColumns.filter((c): c is string => typeof c === 'string').slice(0, 1000) : [],
    fonts,
    settings,
  };
  return { project, warnings, migratedFrom };
}

export function parseProjectJson(text: string): ProjectLoadResult {
  if (text.length > MAX_PROJECT_JSON_BYTES) throw new ProjectFileError('The project file is too large.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProjectFileError('The project file is damaged (invalid JSON).');
  }
  return validateProject(json);
}

export function serializeProject(project: TemplateProject): string {
  return JSON.stringify(project, null, 2);
}
