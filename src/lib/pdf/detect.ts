import type { NormRect, PageInfo } from '../../types/project';
import { applyMatrix, multiplyMatrix, userRectToNorm, type Matrix } from './coords';

/**
 * Simple, explainable field suggestions. These are *hints only*: the user
 * accepts, edits or rejects each one. They will miss many layouts and that is
 * expected — manual placement is always available.
 *
 * - Text: runs of underscores/dots (fill-in lines) and placeholders such as
 *   [Name], {{name}}, <<Name>>.
 * - Image: empty rectangles drawn on the page with a photo-like shape, and
 *   image objects of moderate size (often a placeholder photo).
 */

export interface TextRunLike {
  text: string;
  rect: NormRect;
  fontSize: number;
}

export interface DetectedSuggestion {
  type: 'text' | 'image';
  rect: NormRect;
  label: string;
  reason: string;
}

const PLACEHOLDER = /\[([^\]]{1,40})\]|\{\{\s*([^}]{1,40}?)\s*\}\}|<<\s*([^>]{1,40}?)\s*>>|«([^»]{1,40})»/;
const FILL_LINE = /_{4,}|\.{8,}|…{3,}/;

function cleanLabel(s: string): string {
  return s
    .trim()
    .replace(/[\s:：_.…]+$/g, '')
    .replace(/^[\s:]+/, '')
    .trim()
    .slice(0, 40);
}

export function suggestFromText(runs: TextRunLike[], page: PageInfo): DetectedSuggestion[] {
  const out: DetectedSuggestion[] = [];
  for (const run of runs) {
    const ph = PLACEHOLDER.exec(run.text);
    if (ph) {
      const name = (ph[1] ?? ph[2] ?? ph[3] ?? ph[4] ?? '').trim();
      out.push({ type: 'text', rect: padRect(run.rect, page, 2), label: name || 'Field', reason: `placeholder “${ph[0]}”` });
      continue;
    }
    if (FILL_LINE.test(run.text)) {
      const before = run.text.split(FILL_LINE)[0] ?? '';
      const leftLabel = cleanLabel(before) || cleanLabel(nearestLabelLeftOf(run, runs) ?? '') || 'Field';
      const runW = run.rect.w * page.displayWidth;
      const runH = run.rect.h * page.displayHeight;
      if (runH > runW) {
        // Vertical text (rotated content): offer the whole run; the user adjusts it.
        out.push({ type: 'text', rect: padRect(run.rect, page, 2), label: leftLabel, reason: 'fill-in line (rotated text)' });
        continue;
      }
      // The fill-in line sits on the baseline: the field goes just above it.
      // Only the underscore part of the run, approximated by its share of characters.
      const total = Math.max(1, run.text.length);
      const start = before.length / total;
      const lineChars = (FILL_LINE.exec(run.text)?.[0].length ?? total) / total;
      const x = run.rect.x + run.rect.w * start;
      const w = run.rect.w * lineChars;
      const h = Math.max(run.rect.h * 1.4, 14 / page.displayHeight);
      out.push({ type: 'text', rect: { x, y: run.rect.y + run.rect.h * 0.75 - h, w, h }, label: leftLabel, reason: 'fill-in line' });
    }
  }
  return out;
}

function nearestLabelLeftOf(run: TextRunLike, runs: TextRunLike[]): string | null {
  const cy = run.rect.y + run.rect.h / 2;
  let best: TextRunLike | null = null;
  for (const r of runs) {
    if (r === run || FILL_LINE.test(r.text)) continue;
    const rcy = r.rect.y + r.rect.h / 2;
    if (Math.abs(rcy - cy) > run.rect.h * 0.6) continue;
    const right = r.rect.x + r.rect.w;
    if (right > run.rect.x + 0.002) continue;
    if (!best || right > best.rect.x + best.rect.w) best = r;
  }
  return best && run.rect.x - (best.rect.x + best.rect.w) < 0.15 ? best.text : null;
}

function padRect(r: NormRect, page: PageInfo, pts: number): NormRect {
  const px = pts / page.displayWidth;
  const py = pts / page.displayHeight;
  return { x: r.x - px, y: r.y - py, w: r.w + 2 * px, h: r.h + 2 * py };
}

export interface OpsLike {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  closeFillStroke: number;
}

export interface UserBox {
  kind: 'stroked-rect' | 'image';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Walk a PDF.js operator list tracking the transform and collect boxes in user space. */
export function collectBoxes(fnArray: number[], argsArray: unknown[], OPS: OpsLike): UserBox[] {
  const boxes: UserBox[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const bbox = (m: Matrix, x1: number, y1: number, x2: number, y2: number) => {
    const pts = [applyMatrix(m, { x: x1, y: y1 }), applyMatrix(m, { x: x2, y: y1 }), applyMatrix(m, { x: x1, y: y2 }), applyMatrix(m, { x: x2, y: y2 })];
    return {
      x1: Math.min(...pts.map((p) => p.x)),
      y1: Math.min(...pts.map((p) => p.y)),
      x2: Math.max(...pts.map((p) => p.x)),
      y2: Math.max(...pts.map((p) => p.y)),
    };
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        if (args && args.length >= 6) ctm = multiplyMatrix(ctm, args.slice(0, 6) as Matrix);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const m = args?.[0];
        if (Array.isArray(m) || ArrayBuffer.isView(m)) ctm = multiplyMatrix(ctm, Array.from(m as ArrayLike<number>).slice(0, 6) as Matrix);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        boxes.push({ kind: 'image', ...bbox(ctm, 0, 0, 1, 1) });
        break;
      case OPS.constructPath: {
        if (!args) break;
        const paintOp = args[0];
        const minMax = args[2] as ArrayLike<number> | null | undefined;
        const stroked = paintOp === OPS.stroke || paintOp === OPS.closeStroke || paintOp === OPS.fillStroke || paintOp === OPS.closeFillStroke;
        if (stroked && minMax && minMax.length >= 4 && Number.isFinite(minMax[0])) {
          boxes.push({ kind: 'stroked-rect', ...bbox(ctm, minMax[0]!, minMax[1]!, minMax[2]!, minMax[3]!) });
        }
        break;
      }
    }
  }
  return boxes;
}

export function suggestFromBoxes(boxes: UserBox[], page: PageInfo, runs: TextRunLike[]): DetectedSuggestion[] {
  const out: DetectedSuggestion[] = [];
  for (const b of boxes) {
    const r = userRectToNorm(page, b.x1, b.y1, b.x2, b.y2);
    const area = r.w * r.h;
    const wPt = r.w * page.displayWidth;
    const hPt = r.h * page.displayHeight;
    const aspect = wPt / Math.max(1, hPt);
    if (b.kind === 'stroked-rect') {
      if (wPt < 40 || hPt < 40 || area > 0.25) continue;
      if (aspect < 0.55 || aspect > 1.4) continue;
      const hasText = runs.some((t) => contains(r, t.rect));
      const photoWord = runs.some((t) => /photo|picture|ছবি|image/i.test(t.text) && (contains(r, t.rect) || near(r, t.rect)));
      if (hasText && !photoWord) continue;
      out.push({ type: 'image', rect: r, label: 'Photo', reason: photoWord ? 'box marked as a photo area' : 'empty box with a photo-like shape' });
    } else {
      if (area < 0.005 || area > 0.25) continue;
      out.push({ type: 'image', rect: r, label: 'Photo', reason: 'image in the PDF (maybe a placeholder)' });
    }
  }
  return dedupe(out);
}

function contains(outer: NormRect, inner: NormRect): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx > outer.x && cx < outer.x + outer.w && cy > outer.y && cy < outer.y + outer.h;
}

function near(a: NormRect, b: NormRect): boolean {
  return b.y >= a.y + a.h && b.y - (a.y + a.h) < 0.03 && b.x < a.x + a.w && b.x + b.w > a.x;
}

function dedupe(list: DetectedSuggestion[]): DetectedSuggestion[] {
  const out: DetectedSuggestion[] = [];
  for (const s of list) {
    if (out.some((o) => overlap(o.rect, s.rect) > 0.8)) continue;
    out.push(s);
  }
  return out;
}

export function overlap(a: NormRect, b: NormRect): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  const min = Math.min(a.w * a.h, b.w * b.h);
  return min > 0 ? inter / min : 0;
}
