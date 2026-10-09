import type { HorizontalAlign, ImageFitMode, VerticalAlign } from '../../types/project';

export interface ImagePlacement {
  /** Drawing rectangle in the box frame (origin bottom-left, y up). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The image extends past the box and must be clipped (cover mode). */
  clip: boolean;
}

/**
 * Where to draw an image of `imgW × imgH` pixels inside a `boxW × boxH` box.
 * - contain: whole image visible, aspect ratio kept (may leave empty space)
 * - cover: box completely filled, aspect ratio kept (edges cropped)
 * - stretch: image distorted to exactly fill the box
 */
export function placeImage(
  imgW: number,
  imgH: number,
  boxW: number,
  boxH: number,
  fit: ImageFitMode,
  hAlign: HorizontalAlign = 'center',
  vAlign: VerticalAlign = 'middle',
): ImagePlacement {
  if (imgW <= 0 || imgH <= 0 || boxW <= 0 || boxH <= 0) return { x: 0, y: 0, width: boxW, height: boxH, clip: false };
  if (fit === 'stretch') return { x: 0, y: 0, width: boxW, height: boxH, clip: false };
  const scale = fit === 'contain' ? Math.min(boxW / imgW, boxH / imgH) : Math.max(boxW / imgW, boxH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  const freeX = boxW - width;
  const freeY = boxH - height;
  const x = hAlign === 'left' ? 0 : hAlign === 'right' ? freeX : freeX / 2;
  // y is measured from the bottom: "top" alignment puts the image at the top.
  const y = vAlign === 'top' ? freeY : vAlign === 'bottom' ? 0 : freeY / 2;
  return { x, y, width, height, clip: fit === 'cover' && (width > boxW + 1e-6 || height > boxH + 1e-6) };
}

/** Relative difference between image and box aspect ratios (0 = identical). */
export function aspectMismatch(imgW: number, imgH: number, boxW: number, boxH: number): number {
  if (imgW <= 0 || imgH <= 0 || boxW <= 0 || boxH <= 0) return 0;
  const a = imgW / imgH;
  const b = boxW / boxH;
  return Math.abs(a - b) / Math.min(a, b);
}

/**
 * Effective resolution, in pixels per inch, of an image drawn into a box of
 * `boxW × boxH` PDF points (72 points per inch) with the given fit.
 */
export function effectiveDpi(imgW: number, imgH: number, boxW: number, boxH: number, fit: ImageFitMode): number {
  const p = placeImage(imgW, imgH, boxW, boxH, fit);
  if (p.width <= 0 || p.height <= 0) return Infinity;
  return Math.min(imgW / (p.width / 72), imgH / (p.height / 72));
}

export const LOW_DPI_THRESHOLD = 96;
export const ASPECT_TOLERANCE = 0.15;
