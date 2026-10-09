/**
 * Core data model.
 *
 * Coordinate convention: every field rectangle is stored in *normalized page
 * display space*. (0, 0) is the top-left corner of the page as a PDF viewer
 * shows it (after the page's own /Rotate entry has been applied) and (1, 1) is
 * the bottom-right corner. Values are converted to PDF user-space points only
 * at render/export time (see `src/lib/pdf/coords.ts`). This keeps fields
 * attached to the same spot of the page at every zoom level, view rotation
 * and screen size.
 */

export const PROJECT_FORMAT = 'pdf-template-studio/project';
export const PROJECT_FORMAT_VERSION = 1;

export type Id = string;

/** Normalized rectangle (0..1 on both axes, relative to the displayed page). */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One quarter-turn rotation value, in degrees clockwise. */
export type QuarterTurn = 0 | 90 | 180 | 270;

// ---------------------------------------------------------------------------
// PDF document
// ---------------------------------------------------------------------------

export interface PageBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageInfo {
  /** 1-based page number. */
  pageNumber: number;
  /** Visible page box in PDF user space (the crop box, PDF.js "view"). */
  box: PageBox;
  /** The page's own /Rotate value. */
  rotation: QuarterTurn;
  /** Displayed size in PDF points after applying `rotation`. */
  displayWidth: number;
  displayHeight: number;
}

export interface PdfDocumentMeta {
  fileName: string;
  byteLength: number;
  pageCount: number;
  /** SHA-256 of the original file, hex. Used to confirm a re-selected PDF. */
  sha256: string;
  title?: string;
  pages: PageInfo[];
  hasAcroForm: boolean;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export type FieldType = 'text' | 'image';

export type StandardFontId =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold';

/** `std:<StandardFontId>` or `custom:<font id>` */
export type FontRef = `std:${StandardFontId}` | `custom:${string}`;

export type HorizontalAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/**
 * - `shrink`: keep one line, reduce the font size until it fits.
 * - `wrap`: wrap onto several lines at the chosen size; lines that do not fit are clipped (and flagged).
 * - `wrap-shrink`: wrap onto several lines and reduce the font size until everything fits.
 * - `clip`: one line at the chosen size, cut off at the field edge.
 * - `overflow`: one line at the chosen size, allowed to run past the field edge.
 */
export type TextFitMode = 'shrink' | 'wrap' | 'wrap-shrink' | 'clip' | 'overflow';

export interface TextFieldStyle {
  font: FontRef;
  /** Optional fallback font used for characters missing from `font`. */
  fallbackFont: FontRef | null;
  fontSize: number;
  minFontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  color: string;
  align: HorizontalAlign;
  verticalAlign: VerticalAlign;
  /** Inner padding in PDF points. */
  padding: number;
  fit: TextFitMode;
  /** Rotation of the text inside the field box. */
  rotation: QuarterTurn;
  /** Fill colour painted behind the text, or null for transparent. */
  background: string | null;
}

export type ImageFitMode = 'contain' | 'cover' | 'stretch';

export interface ImageFieldStyle {
  fit: ImageFitMode;
  /** Fill colour painted behind the image, or null for transparent. */
  background: string | null;
  horizontalAlign: HorizontalAlign;
  verticalAlign: VerticalAlign;
  rotation: QuarterTurn;
}

interface FieldBase {
  id: Id;
  label: string;
  page: number;
  rect: NormRect;
  required: boolean;
  /** Set when the field was created by the best-effort text replacement tool. */
  replacement?: ReplacementInfo;
}

export interface ReplacementInfo {
  originalText: string;
}

export interface TextField extends FieldBase {
  type: 'text';
  style: TextFieldStyle;
  sampleValue: string;
}

export interface ImageField extends FieldBase {
  type: 'image';
  style: ImageFieldStyle;
}

export type TemplateField = TextField | ImageField;

/** An AcroForm field that already exists in the source PDF. */
export type FormFieldKind =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'listbox'
  | 'button'
  | 'signature'
  | 'unknown';

export interface ExistingFormWidget {
  page: number;
  rect: NormRect;
}

export interface ExistingFormField {
  /** Fully qualified field name; this is the stable key. */
  name: string;
  kind: FormFieldKind;
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  options: string[];
  widgets: ExistingFormWidget[];
  /** Whether this app can fill it. */
  fillable: boolean;
}

// ---------------------------------------------------------------------------
// Spreadsheet data
// ---------------------------------------------------------------------------

export type CellValue = string | number | boolean | Date | null;

export interface SheetColumn {
  /** Unique, display-safe header (duplicates/blanks are renamed). */
  key: string;
  /** Header text as it appeared in the file. */
  original: string;
  index: number;
}

export interface SheetRow {
  /** Row number in the source file (1-based, as a spreadsheet app shows it). */
  sourceRow: number;
  values: Record<string, CellValue>;
}

export type DataIssueKind =
  | 'missing-header'
  | 'duplicate-header'
  | 'empty-column'
  | 'blank-values'
  | 'malformed-row'
  | 'empty-rows-skipped'
  | 'no-rows';

export interface DataIssue {
  kind: DataIssueKind;
  severity: Severity;
  message: string;
  column?: string;
  rows?: number[];
}

export interface SheetData {
  fileName: string;
  sheetName: string | null;
  availableSheets: string[];
  headerRow: number;
  columns: SheetColumn[];
  rows: SheetRow[];
  issues: DataIssue[];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export type TextTransform =
  | 'none'
  | 'trim'
  | 'upper'
  | 'lower'
  | 'title'
  | 'bengali-digits';

export type FieldSource =
  | { kind: 'none' }
  | { kind: 'column'; column: string; transform: TextTransform; dateFormat?: string }
  /** Fixed text for every row. */
  | { kind: 'fixed'; value: string }
  /** Text with {Column Name} placeholders, e.g. "Dr. {First Name} {Last Name}". */
  | { kind: 'template'; template: string; transform: TextTransform }
  /** A date: today's date or a date column, formatted with `format`. */
  | { kind: 'date'; from: 'today' | { column: string }; format: string; transform: TextTransform }
  /** Image fields only: the same uploaded image on every row (logo, signature). */
  | { kind: 'fixed-image'; imageId: Id };

/** Target is a template field id or `form:<existing field name>`. */
export type MappingTarget = string;

export type FieldMapping = Record<MappingTarget, FieldSource>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info';

export type ValidationCode =
  | 'required-missing'
  | 'text-too-long'
  | 'image-missing'
  | 'image-ambiguous'
  | 'image-invalid'
  | 'image-unsupported'
  | 'image-aspect'
  | 'image-low-resolution'
  | 'field-outside-page'
  | 'unsupported-character'
  | 'font-missing'
  | 'unmapped-required'
  | 'unused-column'
  | 'form-value-invalid'
  | 'complex-script';

export interface ValidationIssue {
  code: ValidationCode;
  severity: Severity;
  message: string;
  fieldId?: string;
  /** 0-based index into SheetData.rows. */
  rowIndex?: number;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportScope = 'current' | 'selected' | 'valid';
export type FormOutputMode = 'flatten' | 'interactive';

export interface ExportOptions {
  scope: ExportScope;
  /** File name pattern, e.g. "{Full Name} - certificate". */
  fileNamePattern: string;
  formMode: FormOutputMode;
  zip: boolean;
}

export interface ExportJob {
  id: Id;
  rowIndexes: number[];
  options: ExportOptions;
  startedAt: number;
}

export type ExportResult =
  | { rowIndex: number; status: 'ok'; fileName: string; bytes: Uint8Array; warnings: ValidationIssue[] }
  | { rowIndex: number; status: 'failed'; fileName: string; error: string; issues: ValidationIssue[] };

export interface ExportSummary {
  job: ExportJob;
  results: ExportResult[];
  completed: number;
  failed: number;
  cancelled: boolean;
  finishedAt: number;
}

// ---------------------------------------------------------------------------
// Fonts and images
// ---------------------------------------------------------------------------

export interface FontAsset {
  id: Id;
  /** Name the user sees. */
  name: string;
  fileName: string;
  family: string;
  postscriptName: string;
  glyphCount: number;
  format: 'ttf' | 'otf';
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface ProjectSettings {
  /** Store the PDF bytes in this browser's IndexedDB with the project. */
  storePdfInBrowser: boolean;
  /** Font used to draw values into existing AcroForm fields. */
  formFieldFont: FontRef;
  imageColumn: string | null;
  exportDefaults: Omit<ExportOptions, 'scope'>;
}

export interface TemplateProject {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_FORMAT_VERSION;
  id: Id;
  name: string;
  createdAt: string;
  updatedAt: string;
  pdf: PdfDocumentMeta | null;
  fields: TemplateField[];
  formFields: ExistingFormField[];
  mapping: FieldMapping;
  /** Column headers of the last imported data file (no row data). */
  knownColumns: string[];
  fonts: FontAsset[];
  settings: ProjectSettings;
}
