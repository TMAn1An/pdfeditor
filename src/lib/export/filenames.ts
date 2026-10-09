import type { SheetRow } from '../../types/project';
import { cellToString } from '../spreadsheet/parse';

/**
 * Safe, unique output file names.
 *
 * Names are built from a pattern such as "{Full Name} - certificate". Values
 * from the spreadsheet are sanitized so they can never contain path
 * separators, reserved names or control characters.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASE_LENGTH = 120;

export function sanitizeFileBase(input: string): string {
  let s = input
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s-]+/, '').replace(/[.\s]+$/, '');
  s = s.replace(/-{2,}/g, '-');
  if (Array.from(s).length > MAX_BASE_LENGTH) s = Array.from(s).slice(0, MAX_BASE_LENGTH).join('').trim();
  if (WINDOWS_RESERVED.test(s.split('.')[0] ?? '')) s = `_${s}`;
  return s;
}

export function applyFileNamePattern(pattern: string, row: SheetRow | null, rowNumber: number, templateName: string): string {
  const filled = pattern.replace(/\{([^{}]+)\}/g, (_m, name: string) => {
    const key = name.trim();
    if (key.toLowerCase() === 'row') return String(rowNumber);
    if (key.toLowerCase() === 'template') return templateName;
    if (!row) return '';
    if (key in row.values) return cellToString(row.values[key] ?? null);
    const found = Object.keys(row.values).find((k) => k.toLowerCase() === key.toLowerCase());
    return found ? cellToString(row.values[found] ?? null) : '';
  });
  return filled;
}

/** Hands out unique names; "Amina.pdf", then "Amina (2).pdf", case-insensitively. */
export class FileNameAllocator {
  private readonly used = new Set<string>();

  allocate(base: string, fallback: string, ext = '.pdf'): string {
    let clean = sanitizeFileBase(base);
    if (!clean) clean = sanitizeFileBase(fallback) || 'document';
    let name = `${clean}${ext}`;
    let n = 2;
    while (this.used.has(name.toLowerCase())) name = `${clean} (${n++})${ext}`;
    this.used.add(name.toLowerCase());
    return name;
  }
}
