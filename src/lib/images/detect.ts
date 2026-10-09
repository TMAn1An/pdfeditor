/**
 * Image type detection and header parsing. Pure functions over bytes: the file
 * extension is never trusted on its own.
 */

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'unknown';

export function sniffImageKind(bytes: Uint8Array): ImageKind {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return 'unknown';
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

export interface ImageHeader {
  kind: ImageKind;
  width: number;
  height: number;
  /** EXIF orientation (1-8) for JPEG, 1 otherwise. */
  orientation: number;
}

/** Read width/height (and JPEG EXIF orientation) without decoding pixels. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const kind = sniffImageKind(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (kind === 'png') {
      if (ascii(bytes, 12, 4) !== 'IHDR') return null;
      return { kind, width: view.getUint32(16), height: view.getUint32(20), orientation: 1 };
    }
    if (kind === 'jpeg') return readJpegHeader(bytes, view);
    if (kind === 'webp') return readWebpHeader(bytes, view);
    if (kind === 'gif') return { kind, width: view.getUint16(6, true), height: view.getUint16(8, true), orientation: 1 };
    if (kind === 'bmp') return { kind, width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)), orientation: 1 };
  } catch {
    return null;
  }
  return null;
}

function readJpegHeader(bytes: Uint8Array, view: DataView): ImageHeader | null {
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && ascii(bytes, offset + 4, 4) === 'Exif') {
      orientation = readExifOrientation(view, offset + 10, length - 8) ?? orientation;
    }
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return { kind: 'jpeg', width, height, orientation };
    }
    offset += 2 + length;
  }
  return null;
}

function readExifOrientation(view: DataView, tiffStart: number, length: number): number | null {
  if (tiffStart + 8 > view.byteLength || length < 8) return null;
  const order = view.getUint16(tiffStart);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  const ifdOffset = view.getUint32(tiffStart + 4, little);
  const ifd = tiffStart + ifdOffset;
  if (ifd + 2 > view.byteLength) return null;
  const entries = view.getUint16(ifd, little);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return null;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function readWebpHeader(bytes: Uint8Array, view: DataView): ImageHeader | null {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { kind: 'webp', width: w, height: h, orientation: 1 };
  }
  if (chunk === 'VP8 ') {
    return { kind: 'webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, orientation: 1 };
  }
  if (chunk === 'VP8L') {
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { kind: 'webp', width: w, height: h, orientation: 1 };
  }
  return null;
}

/** Orientations 5-8 swap width and height when displayed. */
export function orientedSize(h: ImageHeader): { width: number; height: number } {
  return h.orientation >= 5 ? { width: h.height, height: h.width } : { width: h.width, height: h.height };
}

export const SUPPORTED_IMAGE_KINDS: ImageKind[] = ['jpeg', 'png', 'webp'];
