/**
 * Splits a line of text into runs that share one font and one direction, and
 * orders those runs visually.
 *
 * This is a deliberately small subset of the Unicode Bidirectional Algorithm:
 * strong left-to-right / right-to-left letters, neutrals that take the
 * direction of their surroundings, digits treated as left-to-right, and the
 * standard level-based reordering of runs. It handles common cases such as an
 * Arabic or Hebrew name inside an English sentence (and the reverse). It does
 * not handle explicit embedding controls or every weak-type rule.
 */

export type Dir = 'ltr' | 'rtl';

export interface TextRun {
  /** Text in logical order. */
  text: string;
  /** Index into the font stack, or -1 if no font has these characters. */
  font: number;
  dir: Dir;
  /** Code unit offset of the run in the original string. */
  start: number;
}

const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER_RE = /\p{L}|\p{M}/u;
const DIGIT_RE = /\p{Nd}/u;
const MARK_RE = /\p{M}|\u200C|\u200D/u;

type BidiClass = 'L' | 'R' | 'N';

function bidiClass(ch: string): BidiClass {
  if (RTL_RE.test(ch)) return 'R';
  if (LETTER_RE.test(ch) || DIGIT_RE.test(ch)) return 'L';
  return 'N';
}

export function baseDirection(text: string): Dir {
  for (const ch of text) {
    const c = bidiClass(ch);
    if (c === 'R') return 'rtl';
    if (c === 'L') return 'ltr';
  }
  return 'ltr';
}

export function hasRtl(text: string): boolean {
  return RTL_RE.test(text);
}

/**
 * Resolve the direction of every code point.
 */
function resolveDirections(chars: string[], base: Dir): Dir[] {
  const classes = chars.map(bidiClass);
  const dirs: Dir[] = new Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    const c = classes[i];
    if (c === 'L') dirs[i] = 'ltr';
    else if (c === 'R') dirs[i] = 'rtl';
  }
  // Neutrals: same strong type on both sides → that type, else base direction.
  for (let i = 0; i < chars.length; i++) {
    if (classes[i] !== 'N') continue;
    let j = i;
    while (j < chars.length && classes[j] === 'N') j++;
    const before = i > 0 ? dirs[i - 1] : base;
    const after = j < chars.length ? dirs[j] : base;
    const d = before === after ? before : base;
    for (let k = i; k < j; k++) dirs[k] = d;
    i = j - 1;
  }
  return dirs;
}

/** Checks whether font number `font` in the stack can draw `codePoint`. */
export type HasGlyph = (font: number, codePoint: number) => boolean;

export function pickFont(codePoint: number, fontCount: number, has: HasGlyph): number {
  for (let i = 0; i < fontCount; i++) if (has(i, codePoint)) return i;
  return -1;
}

/**
 * Pick a font for every character: the first font in the stack that has it.
 * Combining marks, joiners and spaces stay with the font of the preceding
 * character when that font can draw them, so clusters and words are not split
 * across fonts.
 */
function resolveFonts(chars: string[], fontCount: number, has: HasGlyph): number[] {
  const fonts: number[] = new Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0)!;
    const prev = i > 0 ? fonts[i - 1]! : -1;
    if (prev >= 0 && (MARK_RE.test(ch) || /\s/.test(ch)) && has(prev, cp)) {
      fonts[i] = prev;
      continue;
    }
    fonts[i] = pickFont(cp, fontCount, has);
  }
  return fonts;
}

/**
 * Split `text` into font/direction runs in *visual* order (left to right).
 * Each run's `text` is still in logical order; RTL runs must be shaped with
 * right-to-left direction (which produces glyphs in visual order).
 */
export function itemize(text: string, fontCount: number, has: HasGlyph): TextRun[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const base = baseDirection(text);
  const dirs = resolveDirections(chars, base);
  const fonts = resolveFonts(chars, fontCount, has);

  const logical: (TextRun & { level: number })[] = [];
  let offset = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const dir = dirs[i]!;
    const font = fonts[i]!;
    const last = logical[logical.length - 1];
    if (last && last.dir === dir && last.font === font) {
      last.text += ch;
    } else {
      const level = base === 'ltr' ? (dir === 'ltr' ? 0 : 1) : dir === 'rtl' ? 1 : 2;
      logical.push({ text: ch, font, dir, start: offset, level });
    }
    offset += ch.length;
  }

  // Rule L2: from the highest level down to 1, reverse every maximal sequence
  // of runs at that level or higher.
  const maxLevel = Math.max(...logical.map((r) => r.level));
  const visual = [...logical];
  for (let level = maxLevel; level >= 1; level--) {
    let i = 0;
    while (i < visual.length) {
      if (visual[i]!.level >= level) {
        let j = i;
        while (j < visual.length && visual[j]!.level >= level) j++;
        const reversed = visual.slice(i, j).reverse();
        visual.splice(i, j - i, ...reversed);
        i = j;
      } else {
        i++;
      }
    }
  }
  return visual.map(({ text: t, font, dir, start }) => ({ text: t, font, dir, start }));
}

/** Characters (deduplicated) that no font in the stack can draw. */
export function missingCharacters(text: string, fontCount: number, has: HasGlyph): string[] {
  const missing = new Set<string>();
  for (const ch of text) {
    if (/\s/.test(ch) || /[\u200B-\u200F\u2028-\u202E\uFEFF]/.test(ch)) continue;
    if (pickFont(ch.codePointAt(0)!, fontCount, has) < 0) missing.add(ch);
  }
  return [...missing];
}
