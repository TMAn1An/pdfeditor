import type { CellValue, FieldSource, SheetRow, TextTransform } from '../../types/project';
import { cellToString } from '../spreadsheet/parse';

/**
 * Resolves the text value of a field for one data row. Pure and safe: the
 * template syntax only substitutes {Column Name} placeholders; nothing is
 * evaluated as code.
 */

export interface ResolvedValue {
  value: string;
  /** Problems that should be shown to the user (e.g. unknown placeholder). */
  problems: string[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function applyTransform(value: string, t: TextTransform): string {
  switch (t) {
    case 'none':
      return value;
    case 'trim':
      return value.trim().replace(/\s+/g, ' ');
    case 'upper':
      return value.toLocaleUpperCase();
    case 'lower':
      return value.toLocaleLowerCase();
    case 'title':
      return value.toLocaleLowerCase().replace(/(^|[\s\-'(])(\p{L})/gu, (_m, p: string, c: string) => p + c.toLocaleUpperCase());
    case 'bengali-digits':
      return value.replace(/[0-9]/g, (d) => BENGALI_DIGITS[Number(d)]!);
  }
}

/** Interpret a cell as a calendar date (UTC-based y/m/d), or null. */
export function cellToDate(v: CellValue): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial date (days since 1899-12-30).
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
    if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(s);
    if (m) {
      const month = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m![2]!.toLowerCase().slice(0, 3)));
      if (month >= 0) return validDate(Number(m[3]), month + 1, Number(m[1]));
    }
    m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
    if (m) {
      const month = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m![1]!.toLowerCase().slice(0, 3)));
      if (month >= 0) return validDate(Number(m[3]), month + 1, Number(m[2]));
    }
  }
  return null;
}

function validDate(y: number, m: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * Format a date with tokens: YYYY, YY, MMMM (January), MMM (Jan), MM (01),
 * M (1), DD (05), D (5), Do (5th). Text in [brackets] is kept literally.
 */
export function formatDate(date: Date, format: string): string {
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth();
  const d = date.getUTCDate();
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D/g, (tok, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (tok) {
      case 'YYYY':
        return String(y).padStart(4, '0');
      case 'YY':
        return String(y % 100).padStart(2, '0');
      case 'MMMM':
        return MONTHS[mo]!;
      case 'MMM':
        return MONTHS[mo]!.slice(0, 3);
      case 'MM':
        return String(mo + 1).padStart(2, '0');
      case 'M':
        return String(mo + 1);
      case 'DD':
        return String(d).padStart(2, '0');
      case 'D':
        return String(d);
      case 'Do':
        return ordinal(d);
      default:
        return tok;
    }
  });
}

function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

export function todayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** Placeholder names used in a template string, e.g. "{First Name}". */
export function templatePlaceholders(template: string): string[] {
  const out: string[] = [];
  template.replace(/\{([^{}]+)\}/g, (_m, name: string) => {
    out.push(name.trim());
    return '';
  });
  return out;
}

function lookup(row: SheetRow | null, column: string): CellValue | undefined {
  if (!row) return undefined;
  if (column in row.values) return row.values[column];
  const lower = column.toLowerCase();
  const key = Object.keys(row.values).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : row.values[key];
}

/** Columns a source reads from. */
export function sourceColumns(source: FieldSource): string[] {
  switch (source.kind) {
    case 'column':
      return [source.column];
    case 'template':
      return templatePlaceholders(source.template);
    case 'date':
      return source.from === 'today' ? [] : [source.from.column];
    default:
      return [];
  }
}

export function resolveText(source: FieldSource, row: SheetRow | null, now = new Date()): ResolvedValue {
  const problems: string[] = [];
  switch (source.kind) {
    case 'none':
    case 'fixed-image':
      return { value: '', problems };
    case 'fixed':
      return { value: source.value, problems };
    case 'column': {
      const cell = lookup(row, source.column);
      if (row && cell === undefined) problems.push(`Column "${source.column}" is not in the data file.`);
      let value: string;
      if (source.dateFormat) {
        const date = cellToDate(cell ?? null);
        if (date) value = formatDate(date, source.dateFormat);
        else {
          value = cellToString(cell ?? null);
          if (value) problems.push(`"${value}" is not a recognised date.`);
        }
      } else {
        value = cellToString(cell ?? null);
      }
      return { value: applyTransform(value, source.transform), problems };
    }
    case 'template': {
      const value = source.template.replace(/\{([^{}]+)\}/g, (m, name: string) => {
        const cell = lookup(row, name.trim());
        if (cell === undefined) {
          if (row) problems.push(`Placeholder ${m} does not match a column.`);
          return row ? m : `‹${name.trim()}›`;
        }
        return cellToString(cell);
      });
      return { value: applyTransform(value, source.transform), problems };
    }
    case 'date': {
      let date: Date | null;
      if (source.from === 'today') date = todayUtc(now);
      else {
        const cell = lookup(row, source.from.column);
        date = cellToDate(cell ?? null);
        if (!date && row) {
          const text = cellToString(cell ?? null);
          if (text) problems.push(`"${text}" is not a recognised date.`);
          return { value: applyTransform(text, source.transform), problems };
        }
      }
      return { value: date ? applyTransform(formatDate(date, source.format || 'D MMMM YYYY'), source.transform) : '', problems };
    }
  }
}
