import { newId } from '../id';
import { orientedSize, readImageHeader, sniffImageKind, SUPPORTED_IMAGE_KINDS, type ImageKind } from './detect';

/**
 * A local image file prepared for embedding in a PDF. Files are read with the
 * File API only; nothing is uploaded.
 */
export interface ImageAsset {
  id: string;
  name: string;
  relativePath: string;
  byteLength: number;
  kind: ImageKind;
  /** Displayed size in pixels (after EXIF orientation). */
  width: number;
  height: number;
  /** Bytes ready for pdf-lib (JPEG or PNG). Null when the image is unusable. */
  pdfBytes: Uint8Array | null;
  pdfKind: 'jpeg' | 'png' | null;
  /** Object URL for on-screen previews. */
  previewUrl: string | null;
  error: string | null;
  /** Note shown to the user, e.g. "Converted from WebP". */
  note: string | null;
}

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

export function isProbablyImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif|svg)$/i.test(file.name);
}

export async function loadImageFile(file: File): Promise<ImageAsset> {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const base: ImageAsset = {
    id: newId('img'),
    name: file.name,
    relativePath,
    byteLength: file.size,
    kind: 'unknown',
    width: 0,
    height: 0,
    pdfBytes: null,
    pdfKind: null,
    previewUrl: null,
    error: null,
    note: null,
  };
  if (file.size > MAX_IMAGE_BYTES) return { ...base, error: 'File is larger than 40 MB.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImageKind(bytes);
  base.kind = kind;
  if (!SUPPORTED_IMAGE_KINDS.includes(kind)) {
    return {
      ...base,
      error: kind === 'unknown' ? 'Not a recognised image file.' : `${kind.toUpperCase()} images are not supported. Use JPEG, PNG or WebP.`,
    };
  }
  const header = readImageHeader(bytes);
  if (!header || header.width === 0 || header.height === 0) return { ...base, error: 'The image header is damaged or unreadable.' };

  // Make sure the browser can actually decode it (catches truncated files).
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${kind}` }));
  } catch {
    return { ...base, error: 'The image could not be decoded. It may be damaged.' };
  }

  const size = orientedSize(header);
  const result: ImageAsset = { ...base, width: size.width, height: size.height };
  try {
    if (kind === 'webp') {
      result.pdfBytes = await bitmapToBytes(bitmap, 'image/png');
      result.pdfKind = 'png';
      result.note = 'Converted from WebP to PNG for the PDF.';
    } else if (kind === 'jpeg' && header.orientation !== 1) {
      // PDF viewers ignore EXIF orientation, so bake the rotation in.
      result.pdfBytes = await bitmapToBytes(bitmap, 'image/jpeg', 0.92);
      result.pdfKind = 'jpeg';
      result.note = 'Rotated according to the camera orientation tag.';
    } else {
      result.pdfBytes = bytes;
      result.pdfKind = kind === 'jpeg' ? 'jpeg' : 'png';
    }
    result.width = bitmap.width;
    result.height = bitmap.height;
  } catch (err) {
    result.error = `Could not prepare the image: ${String(err)}`;
  } finally {
    bitmap.close();
  }
  result.previewUrl = URL.createObjectURL(new Blob([(result.pdfBytes ?? bytes) as Uint8Array<ArrayBuffer>], { type: `image/${result.pdfKind ?? kind}` }));
  return result;
}

async function bitmapToBytes(bitmap: ImageBitmap, type: string, quality?: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('Image conversion failed.');
  return new Uint8Array(await blob.arrayBuffer());
}

export function releaseImage(asset: ImageAsset): void {
  if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl);
}
