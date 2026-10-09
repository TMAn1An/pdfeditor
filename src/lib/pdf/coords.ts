import type { NormRect, PageBox, PageInfo, QuarterTurn } from '../../types/project';

/**
 * Coordinate spaces used in this app:
 *
 * 1. Normalized display space (stored): 0..1, origin top-left of the page as
 *    a viewer displays it (page /Rotate applied), y grows downward.
 * 2. Display points: same orientation, measured in PDF points
 *    (0..displayWidth, 0..displayHeight).
 * 3. View space: CSS pixels of the on-screen page after the user's extra view
 *    rotation and zoom. Only used for pointer input.
 * 4. PDF user space: the coordinate system of the page content stream,
 *    origin bottom-left of the media box, y grows upward, before /Rotate.
 */

export interface Point {
  x: number;
  y: number;
}

/** A 2D affine matrix in PDF order: [a b c d e f] maps (x,y) → (a x + c y + e, b x + d y + f). */
export type Matrix = [number, number, number, number, number, number];

export function normalizeQuarterTurn(deg: number): QuarterTurn {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as QuarterTurn;
}

export function makePageInfo(pageNumber: number, box: PageBox, rotation: number): PageInfo {
  const rot = normalizeQuarterTurn(rotation);
  const w = Math.abs(box.x1 - box.x0);
  const h = Math.abs(box.y1 - box.y0);
  const swap = rot === 90 || rot === 270;
  return {
    pageNumber,
    box: {
      x0: Math.min(box.x0, box.x1),
      y0: Math.min(box.y0, box.y1),
      x1: Math.max(box.x0, box.x1),
      y1: Math.max(box.y0, box.y1),
    },
    rotation: rot,
    displayWidth: swap ? h : w,
    displayHeight: swap ? w : h,
  };
}

/**
 * Affine matrix mapping display points (top-left origin, y down) to PDF user
 * space for a page with the given box and /Rotate.
 */
export function displayToUserMatrix(page: Pick<PageInfo, 'box' | 'rotation'>): Matrix {
  const { x0, y0, x1, y1 } = page.box;
  switch (page.rotation) {
    case 0:
      // X = x0 + dx, Y = y1 - dy
      return [1, 0, 0, -1, x0, y1];
    case 90:
      // X = x0 + dy, Y = y0 + dx
      return [0, 1, 1, 0, x0, y0];
    case 180:
      // X = x1 - dx, Y = y0 + dy
      return [-1, 0, 0, 1, x1, y0];
    case 270:
      // X = x1 - dy, Y = y1 - dx
      return [0, -1, -1, 0, x1, y1];
  }
}

export function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Returns a × b, i.e. first apply b, then a. */
export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error('Matrix is not invertible');
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function displayPointToUser(page: PageInfo, p: Point): Point {
  return applyMatrix(displayToUserMatrix(page), p);
}

export function userPointToDisplay(page: PageInfo, p: Point): Point {
  return applyMatrix(invertMatrix(displayToUserMatrix(page)), p);
}

/** Normalized rect → rect in display points. */
export function normToDisplayRect(page: Pick<PageInfo, 'displayWidth' | 'displayHeight'>, r: NormRect) {
  return {
    left: r.x * page.displayWidth,
    top: r.y * page.displayHeight,
    width: r.w * page.displayWidth,
    height: r.h * page.displayHeight,
  };
}

/** Axis-aligned rect in PDF user space ([x, y, width, height], y up) for a normalized rect. */
export function normRectToUserRect(page: PageInfo, r: NormRect) {
  const d = normToDisplayRect(page, r);
  const a = displayPointToUser(page, { x: d.left, y: d.top });
  const b = displayPointToUser(page, { x: d.left + d.width, y: d.top + d.height });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Convert a PDF user-space rectangle (two corners) to a normalized display rect. */
export function userRectToNorm(page: PageInfo, x1: number, y1: number, x2: number, y2: number): NormRect {
  const a = userPointToDisplay(page, { x: x1, y: y1 });
  const b = userPointToDisplay(page, { x: x2, y: y2 });
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return {
    x: left / page.displayWidth,
    y: top / page.displayHeight,
    w: Math.abs(b.x - a.x) / page.displayWidth,
    h: Math.abs(b.y - a.y) / page.displayHeight,
  };
}

/**
 * Matrix mapping a field's local frame to PDF user space.
 *
 * Local frame: origin at the bottom-left corner of the field *as displayed*,
 * x to the right, y up, units in PDF points, size `width × height`. Drawing
 * in this frame makes content appear upright on the displayed page whatever
 * the page's /Rotate value is.
 */
export function fieldFrameMatrix(page: PageInfo, rect: NormRect): { matrix: Matrix; width: number; height: number } {
  const d = normToDisplayRect(page, rect);
  // local (u, v) → display (dx, dy) = (left + u, top + height - v)
  const localToDisplay: Matrix = [1, 0, 0, -1, d.left, d.top + d.height];
  return {
    matrix: multiplyMatrix(displayToUserMatrix(page), localToDisplay),
    width: d.width,
    height: d.height,
  };
}

/**
 * Matrix mapping a rotated content frame into the field's local frame.
 * For 90/270 the content frame is `height × width` (swapped).
 * Rotation is clockwise as seen on the page.
 */
export function contentRotationMatrix(rotation: QuarterTurn, width: number, height: number): Matrix {
  switch (rotation) {
    case 0:
      return [1, 0, 0, 1, 0, 0];
    case 90:
      // text runs downward; content (p, q) → (q, height - p)
      return [0, -1, 1, 0, 0, height];
    case 180:
      return [-1, 0, 0, -1, width, height];
    case 270:
      // text runs upward; content (p, q) → (width - q, p)
      return [0, 1, -1, 0, width, 0];
  }
}

export function contentFrameSize(rotation: QuarterTurn, width: number, height: number) {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

// ---------------------------------------------------------------------------
// View space (pointer input)
// ---------------------------------------------------------------------------

/**
 * Converts a point inside the on-screen page container to normalized display
 * coordinates. `viewRotation` is the extra rotation the user applied in the
 * viewer (not the page's own /Rotate). `viewWidth/viewHeight` are the size of
 * the rotated container in CSS pixels.
 */
export function viewPointToNorm(vx: number, vy: number, viewWidth: number, viewHeight: number, viewRotation: QuarterTurn): Point {
  const u = vx / viewWidth;
  const v = vy / viewHeight;
  switch (viewRotation) {
    case 0:
      return { x: u, y: v };
    case 90:
      return { x: v, y: 1 - u };
    case 180:
      return { x: 1 - u, y: 1 - v };
    case 270:
      return { x: 1 - v, y: u };
  }
}

/** Inverse of `viewPointToNorm`. */
export function normPointToView(nx: number, ny: number, viewWidth: number, viewHeight: number, viewRotation: QuarterTurn): Point {
  switch (viewRotation) {
    case 0:
      return { x: nx * viewWidth, y: ny * viewHeight };
    case 90:
      return { x: (1 - ny) * viewWidth, y: nx * viewHeight };
    case 180:
      return { x: (1 - nx) * viewWidth, y: (1 - ny) * viewHeight };
    case 270:
      return { x: ny * viewWidth, y: (1 - nx) * viewHeight };
  }
}

/** Size of the on-screen container for a page shown at `scale` CSS px per point. */
export function viewSize(page: Pick<PageInfo, 'displayWidth' | 'displayHeight'>, scale: number, viewRotation: QuarterTurn) {
  const w = page.displayWidth * scale;
  const h = page.displayHeight * scale;
  return viewRotation === 90 || viewRotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** Build a normalized rect from two normalized corner points, clamped to the page. */
export function rectFromPoints(a: Point, b: Point, clamp = true): NormRect {
  const c = (n: number) => (clamp ? Math.min(1, Math.max(0, n)) : n);
  const x1 = c(Math.min(a.x, b.x));
  const y1 = c(Math.min(a.y, b.y));
  const x2 = c(Math.max(a.x, b.x));
  const y2 = c(Math.max(a.y, b.y));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** True if any part of the rect lies outside the page (with a small tolerance). */
export function isRectOutsidePage(r: NormRect, tolerance = 0.001): boolean {
  return r.x < -tolerance || r.y < -tolerance || r.x + r.w > 1 + tolerance || r.y + r.h > 1 + tolerance;
}

/** Keep a rect fully inside the page by moving it (size preserved where possible). */
export function clampRectToPage(r: NormRect): NormRect {
  const w = Math.min(1, Math.max(0, r.w));
  const h = Math.min(1, Math.max(0, r.h));
  return {
    x: Math.min(1 - w, Math.max(0, r.x)),
    y: Math.min(1 - h, Math.max(0, r.y)),
    w,
    h,
  };
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Resize a normalized rect by dragging a handle by (dx, dy) normalized units. */
export function resizeRect(r: NormRect, handle: ResizeHandle, dx: number, dy: number, minW: number, minH: number): NormRect {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.w;
  let bottom = r.y + r.h;
  if (handle.includes('w')) left = Math.min(left + dx, right - minW);
  if (handle.includes('e')) right = Math.max(right + dx, left + minW);
  if (handle.includes('n')) top = Math.min(top + dy, bottom - minH);
  if (handle.includes('s')) bottom = Math.max(bottom + dy, top + minH);
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(1, right);
  bottom = Math.min(1, bottom);
  return { x: left, y: top, w: Math.max(minW, right - left), h: Math.max(minH, bottom - top) };
}
