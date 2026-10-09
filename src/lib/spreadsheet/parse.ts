import Papa from 'papaparse';
import type { CellValue, DataIssue, SheetColumn, SheetData, SheetRow } from '../../types/project';

/**
 * Spreadsheet import. Only cell *values* are read: formulas are never
 * evaluated (for .xlsx the value the spreadsheet app last calculated is used)
 * and nothing in the file is executed.
 */

export const MAX_DATA_ROWS = 20000;

export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function isBlank(v: CellValue | undefined): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

export interface GridSource {
  fileName: string;
  sheetName: string | null;
  availableSheets: string[];
  /** 1-based row number of the header row. */
  headerRow: number;
  /** Extra problems found by the file parser (e.g. CSV quoting errors). */
  parserIssues?: DataIssue[];
}

/** Turn a 2D grid of cells into columns + rows, reporting data problems. */
export function buildSheet(grid: CellValue[][], src: GridSource): SheetData {
  const issues: DataIssue[] = [...(src.parserIssues ?? [])];
  const headerIndex = Math.max(0, src.headerRow - 1);
  const headerCells = grid[headerIndex] ?? [];
  const dataGrid = grid.slice(headerIndex + 1);

  // Width = header width, extended if data rows have more non-empty cells.
  let width = lastNonBlank(headerCells) + 1;
  const wideRows: number[] = [];
  dataGrid.forEach((row, i) => {
    const w = lastNonBlank(row) + 1;
    if (w > width) wideRows.push(headerIndex + 2 + i);
  });
  for (const row of dataGrid) width = Math.max(width, lastNonBlank(row) + 1);

  const columns: SheetColumn[] = [];
  const used = new Map<string, number>();
  for (let c = 0; c < width; c++) {
    const raw = headerCells[c];
    const original = isBlank(raw) ? '' : cellToString(raw ?? null).trim();
    let key = original;
    if (key === '') {
      key = `Column ${columnLetter(c)}`;
      issues.push({
        kind: 'missing-header',
        severity: 'warning',
        column: key,
        message: `Column ${columnLetter(c)} has no header. It is shown as "${key}".`,
      });
    }
    const lower = key.toLowerCase();
    const seen = used.get(lower) ?? 0;
    if (seen > 0) {
      const renamed = `${key} (${seen + 1})`;
      issues.push({
        kind: 'duplicate-header',
        severity: 'warning',
        column: renamed,
        message: `The header "${key}" appears more than once. Column ${columnLetter(c)} is shown as "${renamed}".`,
      });
      key = renamed;
    }
    used.set(lower, seen + 1);
    columns.push({ key, original, index: c });
  }

  if (wideRows.length > 0 && lastNonBlank(headerCells) + 1 < width) {
    issues.push({
      kind: 'malformed-row',
      severity: 'warning',
      rows: wideRows.slice(0, 50),
      message: `${wideRows.length} row(s) have values to the right of the last header (e.g. row ${wideRows[0]}).`,
    });
  }

  const rows: SheetRow[] = [];
  let skippedEmpty = 0;
  dataGrid.forEach((cells, i) => {
    if (cells.every((v) => isBlank(v))) {
      skippedEmpty++;
      return;
    }
    if (rows.length >= MAX_DATA_ROWS) return;
    const values: Record<string, CellValue> = {};
    for (const col of columns) values[col.key] = normalizeCell(cells[col.index] ?? null);
    rows.push({ sourceRow: headerIndex + 2 + i, values });
  });

  const nonEmptyRowCount = dataGrid.length - skippedEmpty;
  if (nonEmptyRowCount > MAX_DATA_ROWS) {
    issues.push({
      kind: 'malformed-row',
      severity: 'warning',
      message: `Only the first ${MAX_DATA_ROWS.toLocaleString()} data rows were loaded.`,
    });
  }
  if (skippedEmpty > 0) {
    // Trailing empty rows are normal; only mention empty rows in the middle.
    const trailing = countTrailingEmpty(dataGrid);
    const middle = skippedEmpty - trailing;
    if (middle > 0) {
      issues.push({ kind: 'empty-rows-skipped', severity: 'info', message: `${middle} empty row(s) were skipped.` });
    }
  }
  if (rows.length === 0) {
    issues.push({ kind: 'no-rows', severity: 'error', message: 'No data rows were found below the header row.' });
  }

  for (const col of columns) {
    const blanks = rows.filter((r) => isBlank(r.values[col.key] ?? null));
    if (rows.length > 0 && blanks.length === rows.length) {
      issues.push({ kind: 'empty-column', severity: 'warning', column: col.key, message: `Column "${col.key}" is empty.` });
    } else if (blanks.length > 0) {
      issues.push({
        kind: 'blank-values',
        severity: 'info',
        column: col.key,
        rows: blanks.slice(0, 50).map((r) => r.sourceRow),
        message: `Column "${col.key}" has ${blanks.length} blank value(s) (e.g. row ${blanks[0]!.sourceRow}).`,
      });
    }
  }

  return {
    fileName: src.fileName,
    sheetName: src.sheetName,
    availableSheets: src.availableSheets,
    headerRow: headerIndex + 1,
    columns,
    rows,
    issues,
  };
}

function lastNonBlank(row: CellValue[]): number {
  for (let i = row.length - 1; i >= 0; i--) if (!isBlank(row[i])) return i;
  return -1;
}

function countTrailingEmpty(grid: CellValue[][]): number {
  let n = 0;
  for (let i = grid.length - 1; i >= 0; i--) {
    if (grid[i]!.every((v) => isBlank(v))) n++;
    else break;
  }
  return n;
}

function normalizeCell(v: CellValue): CellValue {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') return v;
  return v ?? null;
}

/** Display string for a cell value. */
export function cellToString(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.\d+Z$/, '');
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v)) return String(v);
    return String(Number.parseFloat(v.toPrecision(12)));
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function parseCsvText(text: string, fileName: string, headerRow = 1): SheetData {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
  });
  const parserIssues: DataIssue[] = [];
  const bad = new Map<string, number[]>();
  for (const err of result.errors) {
    const row = (err.row ?? 0) + 1;
    const list = bad.get(err.code) ?? [];
    list.push(row);
    bad.set(err.code, list);
  }
  for (const [code, rows] of bad) {
    if (code === 'UndetectableDelimiter') continue;
    parserIssues.push({
      kind: 'malformed-row',
      severity: 'warning',
      rows: rows.slice(0, 50),
      message: `${rows.length} row(s) could not be read cleanly (${describeCsvError(code)}), e.g. row ${rows[0]}.`,
    });
  }
  // Detect rows whose field count differs from the header row.
  const grid = result.data as string[][];
  const headerLen = grid[headerRow - 1]?.length ?? 0;
  const ragged: number[] = [];
  grid.forEach((row, i) => {
    if (i < headerRow) return;
    if (row.length === 1 && row[0] === '') return;
    if (row.length !== headerLen) ragged.push(i + 1);
  });
  if (ragged.length > 0 && !bad.has('TooFewFields') && !bad.has('TooManyFields')) {
    parserIssues.push({
      kind: 'malformed-row',
      severity: 'warning',
      rows: ragged.slice(0, 50),
      message: `${ragged.length} row(s) have a different number of cells than the header (e.g. row ${ragged[0]}).`,
    });
  }
  return buildSheet(grid, { fileName, sheetName: null, availableSheets: [], headerRow, parserIssues });
}

function describeCsvError(code: string): string {
  switch (code) {
    case 'MissingQuotes':
      return 'a quoted value is not closed';
    case 'InvalidQuotes':
      return 'unexpected quote characters';
    case 'TooFewFields':
      return 'too few cells';
    case 'TooManyFields':
      return 'too many cells';
    default:
      return code;
  }
}

/** Decode CSV bytes: UTF-8 (with or without BOM), falling back to Windows-1252. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

export interface XlsxWorkbook {
  sheets: { name: string; grid: CellValue[][] }[];
}

export async function readXlsxWorkbook(data: ArrayBuffer): Promise<XlsxWorkbook> {
  const { default: readXlsxFile } = await import('read-excel-file/universal');
  let sheets;
  try {
    sheets = await readXlsxFile(data);
  } catch (err) {
    throw new Error(`This Excel file could not be read. Make sure it is a .xlsx file (not .xls or password-protected). Details: ${errorMessage(err)}`);
  }
  return {
    sheets: sheets.map((s) => ({
      name: s.sheet,
      grid: s.data.map((row) => row.map((v) => (v === undefined ? null : (v as unknown as CellValue)))),
    })),
  };
}

export function sheetFromWorkbook(wb: XlsxWorkbook, fileName: string, sheetName: string | null, headerRow = 1): SheetData {
  const sheet = wb.sheets.find((s) => s.name === sheetName) ?? wb.sheets[0];
  if (!sheet) throw new Error('This workbook has no worksheets.');
  return buildSheet(sheet.grid, {
    fileName,
    sheetName: sheet.name,
    availableSheets: wb.sheets.map((s) => s.name),
    headerRow,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type DataFileKind = 'csv' | 'xlsx' | 'unsupported';

export function dataFileKind(name: string, bytes: Uint8Array): DataFileKind {
  const lower = name.toLowerCase();
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return isZip ? 'xlsx' : 'unsupported';
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) return 'csv';
  if (isZip) return 'xlsx';
  return 'unsupported';
}
