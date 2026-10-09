import { StandardFontEmbedder, StandardFonts } from 'pdf-lib';
import type { FontRef, StandardFontId } from '../../types/project';
import { itemize, missingCharacters, type Dir } from '../text/runs';
import type { MeasureFn } from '../text/layout';
import { customFontId, isStandardFontRef, isValidStandardFontId } from './standard';

/**
 * Font metrics and text shaping for export.
 *
 * - Standard PDF fonts (Helvetica, Times, Courier) use pdf-lib's built-in
 *   metrics. They only cover the WinAnsi (Western European) character set.
 * - Uploaded TrueType/OpenType fonts are shaped with HarfBuzz (compiled to
 *   WebAssembly, runs locally). HarfBuzz applies the font's OpenType
 *   substitution and positioning rules, which complex scripts such as Bengali
 *   need for conjuncts, reordered vowel signs and mark placement.
 */

type HarfBuzz = typeof import('harfbuzzjs');
let hbPromise: Promise<HarfBuzz> | null = null;

export function loadHarfBuzz(): Promise<HarfBuzz> {
  hbPromise ??= import('harfbuzzjs').catch((err: unknown) => {
    hbPromise = null;
    throw new Error(`Could not start the text shaping engine (HarfBuzz): ${String(err)}`);
  });
  return hbPromise;
}

export interface ShapedGlyph {
  gid: number;
  /** Advance and offsets in em units (font size 1). */
  ax: number;
  dx: number;
  dy: number;
}

export interface FontMetrics {
  ref: FontRef;
  kind: 'standard' | 'custom';
  /** Ascent/descent as a fraction of the font size (descent is positive). */
  ascent: number;
  descent: number;
  has(codePoint: number): boolean;
}

export class StandardFontMetrics implements FontMetrics {
  readonly kind = 'standard' as const;
  readonly ascent: number;
  readonly descent: number;
  readonly embedder: StandardFontEmbedder;
  private readonly supported: Set<number>;

  constructor(
    readonly ref: FontRef,
    readonly id: StandardFontId,
  ) {
    this.embedder = StandardFontEmbedder.for(StandardFonts[standardKey(id)] as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
    this.supported = new Set(this.embedder.encoding.supportedCodePoints);
    const font = this.embedder.font as unknown as { Ascender?: number; Descender?: number };
    this.ascent = (font.Ascender ?? 718) / 1000;
    this.descent = Math.abs(font.Descender ?? -207) / 1000;
  }

  has(codePoint: number): boolean {
    return this.supported.has(codePoint);
  }

  width(text: string): number {
    return this.embedder.widthOfTextAtSize(text, 1);
  }
}

function standardKey(id: StandardFontId): keyof typeof StandardFonts {
  const map: Record<StandardFontId, keyof typeof StandardFonts> = {
    Helvetica: 'Helvetica',
    'Helvetica-Bold': 'HelveticaBold',
    'Helvetica-Oblique': 'HelveticaOblique',
    'Helvetica-BoldOblique': 'HelveticaBoldOblique',
    'Times-Roman': 'TimesRoman',
    'Times-Bold': 'TimesRomanBold',
    'Times-Italic': 'TimesRomanItalic',
    'Times-BoldItalic': 'TimesRomanBoldItalic',
    Courier: 'Courier',
    'Courier-Bold': 'CourierBold',
  };
  return map[id];
}

type HbFont = InstanceType<HarfBuzz['Font']>;

export class CustomFontMetrics implements FontMetrics {
  readonly kind = 'custom' as const;
  readonly ascent: number;
  readonly descent: number;
  readonly upem: number;
  private readonly hasCache = new Map<number, boolean>();

  constructor(
    readonly ref: FontRef,
    readonly bytes: Uint8Array,
    private readonly hb: HarfBuzz,
    private readonly font: HbFont,
  ) {
    this.upem = font.face.upem || 1000;
    const ext = font.hExtents();
    const asc = ext.ascender / this.upem;
    const desc = Math.abs(ext.descender) / this.upem;
    this.ascent = asc > 0 ? asc : 0.8;
    this.descent = desc > 0 ? desc : 0.2;
  }

  static create(ref: FontRef, bytes: Uint8Array, hb: HarfBuzz): CustomFontMetrics {
    const blob = new hb.Blob(bytes);
    const face = new hb.Face(blob, 0);
    if (!face.upem) throw new Error('This file is not a usable TrueType/OpenType font.');
    const font = new hb.Font(face);
    return new CustomFontMetrics(ref, bytes, hb, font);
  }

  has(codePoint: number): boolean {
    let v = this.hasCache.get(codePoint);
    if (v === undefined) {
      const gid = this.font.nominalGlyph(codePoint);
      v = gid !== undefined && gid !== 0;
      this.hasCache.set(codePoint, v);
    }
    return v;
  }

  shape(text: string, dir: Dir): ShapedGlyph[] {
    const buf = new this.hb.Buffer();
    buf.addText(text);
    buf.setDirection(dir === 'rtl' ? this.hb.Direction.RTL : this.hb.Direction.LTR);
    buf.guessSegmentProperties();
    this.hb.shape(this.font, buf);
    const infos = buf.getGlyphInfos();
    const positions = buf.getGlyphPositions();
    const s = 1 / this.upem;
    return infos.map((info, i) => {
      const p = positions[i]!;
      return { gid: info.codepoint, ax: p.xAdvance * s, dx: p.xOffset * s, dy: p.yOffset * s };
    });
  }
}

export type PreparedRun =
  | { kind: 'standard'; font: number; text: string; width: number }
  | { kind: 'custom'; font: number; glyphs: ShapedGlyph[]; width: number }
  | { kind: 'missing'; font: -1; text: string; width: number };

export interface PreparedLine {
  runs: PreparedRun[];
  /** Width at font size 1. */
  width: number;
}

/**
 * An ordered list of fonts: the field's font first, then its fallback.
 * Characters are drawn with the first font that has them.
 */
export class FontStack {
  private readonly cache = new Map<string, PreparedLine>();

  constructor(readonly fonts: FontMetrics[]) {
    if (fonts.length === 0) throw new Error('A font stack needs at least one font.');
  }

  get primary(): FontMetrics {
    return this.fonts[0]!;
  }

  get ascent(): number {
    return this.primary.ascent;
  }

  get descent(): number {
    return this.primary.descent;
  }

  private has = (font: number, cp: number) => this.fonts[font]!.has(cp);

  prepare(text: string): PreparedLine {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const runs: PreparedRun[] = [];
    let total = 0;
    for (const run of itemize(text, this.fonts.length, this.has)) {
      if (run.font < 0) {
        // Not drawable. Reserve a little space so layout stays stable; the
        // validator reports these characters and blocks export of the row.
        const w = Array.from(run.text).length * 0.5;
        runs.push({ kind: 'missing', font: -1, text: run.text, width: w });
        total += w;
        continue;
      }
      const font = this.fonts[run.font]!;
      if (font instanceof CustomFontMetrics) {
        const glyphs = font.shape(run.text, run.dir);
        const w = glyphs.reduce((sum, g) => sum + g.ax, 0);
        runs.push({ kind: 'custom', font: run.font, glyphs, width: w });
        total += w;
      } else if (font instanceof StandardFontMetrics) {
        // Standard fonts do no shaping; reverse RTL runs into visual order.
        const t = run.dir === 'rtl' ? Array.from(run.text).reverse().join('') : run.text;
        const w = font.width(t);
        runs.push({ kind: 'standard', font: run.font, text: t, width: w });
        total += w;
      }
    }
    const line = { runs, width: total };
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(text, line);
    return line;
  }

  measure: MeasureFn = (text, size) => this.prepare(text).width * size;

  missing(text: string): string[] {
    return missingCharacters(text, this.fonts.length, this.has);
  }
}

/**
 * Loads and caches font metrics for standard fonts and uploaded fonts.
 */
export class FontLibrary {
  private readonly metrics = new Map<FontRef, FontMetrics>();

  constructor(private readonly customBytes: (id: string) => Uint8Array | undefined) {}

  /** Load everything needed for these refs. Unknown fonts throw. */
  async prepare(refs: Iterable<FontRef>): Promise<void> {
    for (const ref of refs) {
      if (this.metrics.has(ref)) continue;
      if (isStandardFontRef(ref)) {
        const id = ref.slice(4);
        if (!isValidStandardFontId(id)) throw new Error(`Unknown standard font "${id}".`);
        this.metrics.set(ref, new StandardFontMetrics(ref, id));
      } else {
        const id = customFontId(ref)!;
        const bytes = this.customBytes(id);
        if (!bytes) throw new Error('A font used by this template has not been loaded. Re-add it in the Fonts panel.');
        const hb = await loadHarfBuzz();
        this.metrics.set(ref, CustomFontMetrics.create(ref, bytes, hb));
      }
    }
  }

  get(ref: FontRef): FontMetrics {
    const m = this.metrics.get(ref);
    if (!m) throw new Error(`Font ${ref} has not been prepared.`);
    return m;
  }

  isPrepared(ref: FontRef): boolean {
    return this.metrics.has(ref);
  }

  stack(primary: FontRef, fallback: FontRef | null): FontStack {
    const fonts = [this.get(primary)];
    if (fallback && fallback !== primary) fonts.push(this.get(fallback));
    return new FontStack(fonts);
  }

  /** Forget a custom font (after it is removed or replaced). */
  forget(ref: FontRef): void {
    this.metrics.delete(ref);
  }
}
