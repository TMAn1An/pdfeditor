import type { FontRef, StandardFontId } from '../../types/project';

export interface StandardFontInfo {
  id: StandardFontId;
  label: string;
  /** CSS font stack used for on-screen approximations. */
  css: string;
  weight: 'normal' | 'bold';
  style: 'normal' | 'italic';
}

export const STANDARD_FONTS: StandardFontInfo[] = [
  { id: 'Helvetica', label: 'Helvetica (sans-serif)', css: 'Helvetica, Arial, "Liberation Sans", sans-serif', weight: 'normal', style: 'normal' },
  { id: 'Helvetica-Bold', label: 'Helvetica Bold', css: 'Helvetica, Arial, "Liberation Sans", sans-serif', weight: 'bold', style: 'normal' },
  { id: 'Helvetica-Oblique', label: 'Helvetica Oblique', css: 'Helvetica, Arial, "Liberation Sans", sans-serif', weight: 'normal', style: 'italic' },
  { id: 'Helvetica-BoldOblique', label: 'Helvetica Bold Oblique', css: 'Helvetica, Arial, "Liberation Sans", sans-serif', weight: 'bold', style: 'italic' },
  { id: 'Times-Roman', label: 'Times (serif)', css: '"Times New Roman", Times, "Liberation Serif", serif', weight: 'normal', style: 'normal' },
  { id: 'Times-Bold', label: 'Times Bold', css: '"Times New Roman", Times, "Liberation Serif", serif', weight: 'bold', style: 'normal' },
  { id: 'Times-Italic', label: 'Times Italic', css: '"Times New Roman", Times, "Liberation Serif", serif', weight: 'normal', style: 'italic' },
  { id: 'Times-BoldItalic', label: 'Times Bold Italic', css: '"Times New Roman", Times, "Liberation Serif", serif', weight: 'bold', style: 'italic' },
  { id: 'Courier', label: 'Courier (monospace)', css: '"Courier New", Courier, "Liberation Mono", monospace', weight: 'normal', style: 'normal' },
  { id: 'Courier-Bold', label: 'Courier Bold', css: '"Courier New", Courier, "Liberation Mono", monospace', weight: 'bold', style: 'normal' },
];

export const DEFAULT_FONT: FontRef = 'std:Helvetica';

export function isStandardFontRef(ref: FontRef): ref is `std:${StandardFontId}` {
  return ref.startsWith('std:');
}

export function standardFontInfo(ref: FontRef): StandardFontInfo | undefined {
  if (!isStandardFontRef(ref)) return undefined;
  const id = ref.slice(4);
  return STANDARD_FONTS.find((f) => f.id === id);
}

export function customFontId(ref: FontRef): string | null {
  return ref.startsWith('custom:') ? ref.slice(7) : null;
}

export function isValidStandardFontId(id: string): id is StandardFontId {
  return STANDARD_FONTS.some((f) => f.id === id);
}

/** Map a PDF.js font family / name to the closest standard font. */
export function guessStandardFont(fontName: string, family?: string): StandardFontId {
  const n = `${fontName} ${family ?? ''}`.toLowerCase();
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  if (/courier|mono/.test(n)) return bold ? 'Courier-Bold' : 'Courier';
  if (/times|serif|roman|georgia|garamond|minion|cambria/.test(n) && !/sans/.test(n)) {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}
