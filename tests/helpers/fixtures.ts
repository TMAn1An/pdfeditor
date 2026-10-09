import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, degrees } from 'pdf-lib';
import { FontLibrary } from '../../src/lib/fonts/engine';
import { createProject } from '../../src/lib/storage/projectFile';
import { makePageInfo } from '../../src/lib/pdf/coords';
import type { ImageField, NormRect, TemplateProject, TextField } from '../../src/types/project';
import type { RenderContext } from '../../src/lib/render/plan';

export const bengaliFontBytes = () => new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/fonts/NotoSansBengali-Regular.ttf', import.meta.url))));

export async function makeTemplatePdf(rotations: number[] = [0], size: [number, number] = [612, 792]) {
  const doc = await PDFDocument.create();
  for (const r of rotations) {
    const p = doc.addPage(size);
    p.setRotation(degrees(r));
  }
  return doc.save();
}

export function projectFor(bytesPages: { rotation: number; width: number; height: number }[]): TemplateProject {
  const p = createProject('Test template');
  p.pdf = {
    fileName: 'test.pdf',
    byteLength: 0,
    pageCount: bytesPages.length,
    sha256: '',
    pages: bytesPages.map((pg, i) => makePageInfo(i + 1, { x0: 0, y0: 0, x1: pg.width, y1: pg.height }, pg.rotation)),
    hasAcroForm: false,
  };
  return p;
}

export function textField(id: string, page: number, rect: NormRect, extra: Partial<TextField['style']> = {}, label = id): TextField {
  return {
    id,
    type: 'text',
    label,
    page,
    rect,
    required: false,
    sampleValue: '',
    style: {
      font: 'std:Helvetica',
      fallbackFont: null,
      fontSize: 12,
      minFontSize: 6,
      lineHeight: 1.2,
      color: '#000000',
      align: 'left',
      verticalAlign: 'middle',
      padding: 2,
      fit: 'shrink',
      rotation: 0,
      background: null,
      ...extra,
    },
  };
}

export function imageField(id: string, page: number, rect: NormRect, extra: Partial<ImageField['style']> = {}): ImageField {
  return {
    id,
    type: 'image',
    label: id,
    page,
    rect,
    required: false,
    style: { fit: 'contain', background: null, horizontalAlign: 'center', verticalAlign: 'middle', rotation: 0, ...extra },
  };
}

export async function contextFor(project: TemplateProject, customFonts: Record<string, Uint8Array> = {}): Promise<RenderContext> {
  const fonts = new FontLibrary((id) => customFonts[id]);
  const refs = new Set(project.fields.flatMap((f) => (f.type === 'text' ? [f.style.font, ...(f.style.fallbackFont ? [f.style.fallbackFont] : [])] : [])));
  refs.add(project.settings.formFieldFont);
  await fonts.prepare(refs);
  return { project, fonts, images: { index: null, assets: new Map(), overrides: {}, samples: {} } };
}

/** A tiny valid PNG of the given size (solid red). */
export function makePng(width: number, height: number): Uint8Array {
  // Built with zlib "stored" blocks so no compression library is needed.
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(255, 0, 0);
  }
  const data = Uint8Array.from(raw);
  const zlib: number[] = [0x78, 0x01];
  for (let off = 0; off < data.length || off === 0; off += 65535) {
    const chunk = data.subarray(off, off + 65535);
    const last = off + 65535 >= data.length ? 1 : 0;
    zlib.push(last, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255, ...chunk);
    if (last) break;
  }
  let a = 1;
  let b = 0;
  for (const v of data) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  zlib.push(adler >>> 24, (adler >> 16) & 255, (adler >> 8) & 255, adler & 255);
  const chunks: Uint8Array[] = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  chunks.push(pngChunk('IHDR', ihdr), pngChunk('IDAT', Uint8Array.from(zlib)), pngChunk('IEND', new Uint8Array()));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = CRC_TABLE[(crc ^ out[i]!) & 255]! ^ (crc >>> 8);
  dv.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}
