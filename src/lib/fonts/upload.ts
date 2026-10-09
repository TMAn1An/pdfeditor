import fontkit from '@pdf-lib/fontkit';
import type { FontAsset, FontRef } from '../../types/project';
import { newId } from '../id';
import { loadHarfBuzz } from './engine';

const MAX_FONT_BYTES = 40 * 1024 * 1024;

export function fontSignature(bytes: Uint8Array): 'ttf' | 'otf' | 'woff' | 'woff2' | 'ttc' | 'unknown' {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return 'ttf';
  if (tag === 'true') return 'ttf';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'ttcf') return 'ttc';
  return 'unknown';
}

/** Validate an uploaded font file and describe it. Throws a readable error. */
export async function inspectFontFile(bytes: Uint8Array, fileName: string): Promise<FontAsset> {
  if (bytes.byteLength > MAX_FONT_BYTES) throw new Error('This font file is larger than 40 MB.');
  const sig = fontSignature(bytes);
  if (sig === 'woff' || sig === 'woff2') throw new Error('WOFF/WOFF2 web fonts are not supported. Use the .ttf or .otf version of the font.');
  if (sig === 'ttc') throw new Error('Font collections (.ttc) are not supported. Use a single .ttf or .otf file.');
  if (sig === 'unknown') throw new Error('This is not a TrueType (.ttf) or OpenType (.otf) font file.');
  let font: { postscriptName?: string; familyName?: string; fullName?: string; numGlyphs?: number };
  try {
    font = fontkit.create(bytes) as unknown as typeof font;
  } catch (err) {
    throw new Error(`The font file could not be read: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  // Make sure the shaping engine accepts it too.
  const hb = await loadHarfBuzz();
  const face = new hb.Face(new hb.Blob(bytes), 0);
  if (!face.upem) throw new Error('The font has no usable glyph data.');
  return {
    id: newId('font'),
    name: font.fullName || font.familyName || fileName.replace(/\.(ttf|otf)$/i, ''),
    fileName,
    family: font.familyName ?? '',
    postscriptName: font.postscriptName ?? '',
    glyphCount: font.numGlyphs ?? 0,
    format: sig,
  };
}

const registered = new Map<string, FontFace>();

export function cssFamilyFor(fontId: string): string {
  return `pts-font-${fontId}`;
}

/** Make an uploaded font available to on-screen previews (CSS FontFace, local only). */
export async function registerBrowserFont(fontId: string, bytes: Uint8Array): Promise<void> {
  if (registered.has(fontId) || typeof FontFace === 'undefined') return;
  const face = new FontFace(cssFamilyFor(fontId), bytes.slice().buffer as ArrayBuffer);
  await face.load();
  document.fonts.add(face);
  registered.set(fontId, face);
}

export function unregisterBrowserFont(fontId: string): void {
  const face = registered.get(fontId);
  if (face) {
    document.fonts.delete(face);
    registered.delete(fontId);
  }
}

export function fontRefFor(asset: FontAsset): FontRef {
  return `custom:${asset.id}`;
}
