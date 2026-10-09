import type { HorizontalAlign, TextFitMode, VerticalAlign } from '../../types/project';

/**
 * Pure text layout used by export, preview and validation.
 *
 * Measuring is injected so the same algorithm works with PDF fonts (export)
 * and with canvas fonts (on-screen editing hints).
 */
export type MeasureFn = (text: string, fontSize: number) => number;

export interface LayoutOptions {
  width: number;
  height: number;
  fontSize: number;
  minFontSize: number;
  lineHeight: number;
  fit: TextFitMode;
  align: HorizontalAlign;
  verticalAlign: VerticalAlign;
  /** Ascent and descent as a fraction of the font size (descent positive). */
  ascent?: number;
  descent?: number;
}

export interface LaidOutLine {
  text: string;
  width: number;
  /** x offset of the line start inside the box. */
  x: number;
  /** Baseline y, measured from the *bottom* of the box (PDF style, y up). */
  baseline: number;
}

export interface LayoutResult {
  lines: LaidOutLine[];
  fontSize: number;
  /** Some text is cut off, does not fit, or runs past the field edge. */
  overflow: boolean;
  /** Font size had to be reduced below the requested size. */
  shrunk: boolean;
  /** Shrinking hit `minFontSize` and the text still did not fit. */
  hitMinimum: boolean;
  /** The output must be clipped to the box. */
  clip: boolean;
  /** Lines that were dropped entirely because they did not fit (wrap mode). */
  droppedLines: number;
}

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = 0.2;

/** Split text into paragraphs on explicit line breaks. */
function paragraphs(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Break text into lines no wider than `maxWidth`. Breaks at spaces; a single
 * word wider than the line is broken by grapheme.
 */
export function wrapText(text: string, maxWidth: number, fontSize: number, measure: MeasureFn): string[] {
  const out: string[] = [];
  for (const para of paragraphs(text)) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, fontSize) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = '';
      if (measure(word, fontSize) <= maxWidth) {
        line = word;
      } else {
        // A single word wider than the line: break it between graphemes.
        const pieces = breakWord(word, maxWidth, fontSize, measure);
        out.push(...pieces.slice(0, -1));
        line = pieces[pieces.length - 1] ?? '';
      }
    }
    out.push(line);
  }
  return out;
}

function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

function breakWord(word: string, maxWidth: number, fontSize: number, measure: MeasureFn): string[] {
  const parts: string[] = [];
  let current = '';
  for (const g of graphemes(word)) {
    if (current !== '' && measure(current + g, fontSize) > maxWidth) {
      parts.push(current);
      current = g;
    } else {
      current += g;
    }
  }
  parts.push(current);
  return parts;
}

function singleLineText(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

function fitsSingle(text: string, opts: LayoutOptions, size: number, measure: MeasureFn): boolean {
  const lineH = size * (opts.ascent ?? DEFAULT_ASCENT) + size * (opts.descent ?? DEFAULT_DESCENT);
  return measure(text, size) <= opts.width + 1e-6 && lineH <= opts.height + 1e-6;
}

function wrappedHeight(lineCount: number, size: number, opts: LayoutOptions): number {
  if (lineCount === 0) return 0;
  const ascent = opts.ascent ?? DEFAULT_ASCENT;
  const descent = opts.descent ?? DEFAULT_DESCENT;
  return (lineCount - 1) * size * opts.lineHeight + size * (ascent + descent);
}

function fitsWrapped(text: string, opts: LayoutOptions, size: number, measure: MeasureFn): boolean {
  const lines = wrapText(text, opts.width, size, measure);
  const tooWide = lines.some((l) => measure(l, size) > opts.width + 1e-6);
  return !tooWide && wrappedHeight(lines.length, size, opts) <= opts.height + 1e-6;
}

/** Largest size in [min, max] (0.25pt steps) for which `fits` holds, or min. */
function searchSize(max: number, min: number, fits: (size: number) => boolean): { size: number; ok: boolean } {
  if (fits(max)) return { size: max, ok: true };
  let lo = min;
  let hi = max;
  if (!fits(lo)) return { size: min, ok: false };
  while (hi - lo > 0.25) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { size: Math.floor(lo * 4) / 4, ok: true };
}

export function layoutText(rawText: string, opts: LayoutOptions, measure: MeasureFn): LayoutResult {
  const ascent = opts.ascent ?? DEFAULT_ASCENT;
  const minSize = Math.max(1, Math.min(opts.minFontSize, opts.fontSize));
  const width = Math.max(0, opts.width);
  const height = Math.max(0, opts.height);
  const o = { ...opts, width, height };

  let size = opts.fontSize;
  let lineTexts: string[];
  let overflow = false;
  let hitMinimum = false;
  let clip = true;
  let droppedLines = 0;

  switch (opts.fit) {
    case 'shrink': {
      const text = singleLineText(rawText);
      const r = searchSize(opts.fontSize, minSize, (s) => fitsSingle(text, o, s, measure));
      size = r.size;
      hitMinimum = !r.ok;
      overflow = !r.ok;
      lineTexts = [text];
      break;
    }
    case 'wrap-shrink': {
      const r = searchSize(opts.fontSize, minSize, (s) => fitsWrapped(rawText, o, s, measure));
      size = r.size;
      hitMinimum = !r.ok;
      overflow = !r.ok;
      lineTexts = wrapText(rawText, width, size, measure);
      break;
    }
    case 'wrap': {
      lineTexts = wrapText(rawText, width, size, measure);
      overflow = !fitsWrapped(rawText, o, size, measure);
      break;
    }
    case 'clip': {
      const text = singleLineText(rawText);
      lineTexts = [text];
      overflow = !fitsSingle(text, o, size, measure);
      break;
    }
    case 'overflow': {
      const text = singleLineText(rawText);
      lineTexts = [text];
      overflow = !fitsSingle(text, o, size, measure);
      clip = false;
      break;
    }
  }

  // When wrapping, drop whole lines that would be clipped at the bottom
  // (keeps output tidy; the overflow flag already reports the problem).
  if ((opts.fit === 'wrap' || opts.fit === 'wrap-shrink') && lineTexts.length > 1) {
    let keep = lineTexts.length;
    while (keep > 1 && wrappedHeight(keep, size, o) > height + 1e-6) keep--;
    droppedLines = lineTexts.length - keep;
    lineTexts = lineTexts.slice(0, keep);
  }

  const blockHeight = wrappedHeight(lineTexts.length, size, o);
  let top: number; // distance from box bottom to the top of the text block
  switch (opts.verticalAlign) {
    case 'top':
      top = height;
      break;
    case 'bottom':
      top = blockHeight;
      break;
    default:
      top = (height + blockHeight) / 2;
  }

  const lines: LaidOutLine[] = lineTexts.map((text, i) => {
    const w = measure(text, size);
    let x = 0;
    if (opts.align === 'center') x = (width - w) / 2;
    else if (opts.align === 'right') x = width - w;
    const baseline = top - size * ascent - i * size * opts.lineHeight;
    return { text, width: w, x, baseline };
  });

  return {
    lines,
    fontSize: size,
    overflow,
    shrunk: size < opts.fontSize - 1e-6,
    hitMinimum,
    clip,
    droppedLines,
  };
}
