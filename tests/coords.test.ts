import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  displayPointToUser,
  makePageInfo,
  normPointToView,
  normRectToUserRect,
  resizeRect,
  userPointToDisplay,
  userRectToNorm,
  viewPointToNorm,
  viewSize,
} from '../src/lib/pdf/coords';
import type { QuarterTurn } from '../src/types/project';
import { openWithPdfjs } from './helpers/pdfjsNode';

const ROTATIONS: QuarterTurn[] = [0, 90, 180, 270];

describe('view ↔ normalized coordinates', () => {
  it('round-trips through every view rotation and zoom', () => {
    const page = { displayWidth: 612, displayHeight: 792 };
    for (const rot of ROTATIONS) {
      for (const scale of [0.25, 1, 1.5, 4]) {
        const size = viewSize(page, scale, rot);
        for (const p of [
          { x: 0.1, y: 0.2 },
          { x: 0.9, y: 0.05 },
          { x: 0.5, y: 0.5 },
        ]) {
          const v = normPointToView(p.x, p.y, size.width, size.height, rot);
          const back = viewPointToNorm(v.x, v.y, size.width, size.height, rot);
          expect(back.x).toBeCloseTo(p.x, 10);
          expect(back.y).toBeCloseTo(p.y, 10);
        }
      }
    }
  });

  it('normalized coordinates do not depend on zoom', () => {
    const page = { displayWidth: 595, displayHeight: 842 };
    const a = viewSize(page, 1, 0);
    const b = viewSize(page, 2.5, 0);
    const pa = viewPointToNorm(a.width * 0.3, a.height * 0.7, a.width, a.height, 0);
    const pb = viewPointToNorm(b.width * 0.3, b.height * 0.7, b.width, b.height, 0);
    expect(pa).toEqual(pb);
  });

  it('a 90° view puts the page top-left corner at the top-right of the screen', () => {
    const v = normPointToView(0, 0, 792, 612, 90);
    expect(v).toEqual({ x: 792, y: 0 });
  });

  it('swaps the container size for 90/270 view rotation', () => {
    expect(viewSize({ displayWidth: 100, displayHeight: 200 }, 2, 90)).toEqual({ width: 400, height: 200 });
  });
});

describe('display ↔ PDF user space', () => {
  it('round-trips for every page rotation and an offset crop box', () => {
    for (const rot of ROTATIONS) {
      const info = makePageInfo(1, { x0: 10, y0: 20, x1: 310, y1: 520 }, rot);
      for (const p of [
        { x: 0, y: 0 },
        { x: 12.5, y: 40 },
        { x: info.displayWidth, y: info.displayHeight },
      ]) {
        const u = displayPointToUser(info, p);
        const back = userPointToDisplay(info, u);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    }
  });

  it('matches PDF.js viewport conversion for rotated, offset pages', async () => {
    const doc = await PDFDocument.create();
    const specs = ROTATIONS.map((rot) => ({ rot, box: { x: 15, y: 30, width: 400, height: 600 } }));
    for (const s of specs) {
      const page = doc.addPage([500, 700]);
      page.setCropBox(s.box.x, s.box.y, s.box.width, s.box.height);
      page.setRotation(degrees(s.rot));
    }
    const bytes = await doc.save();
    const pdf = await openWithPdfjs(bytes);
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i]!;
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const info = makePageInfo(i + 1, { x0: s.box.x, y0: s.box.y, x1: s.box.x + s.box.width, y1: s.box.y + s.box.height }, s.rot);
      expect(info.displayWidth).toBeCloseTo(vp.width, 6);
      expect(info.displayHeight).toBeCloseTo(vp.height, 6);
      for (const user of [
        { x: 40, y: 50 },
        { x: 300, y: 400 },
        { x: 15, y: 630 },
      ]) {
        const [vx, vy] = vp.convertToViewportPoint(user.x, user.y) as [number, number];
        const mine = userPointToDisplay(info, user);
        expect(mine.x).toBeCloseTo(vx, 6);
        expect(mine.y).toBeCloseTo(vy, 6);
      }
    }
  });

  it('converts normalized rects to user rects and back', () => {
    for (const rot of ROTATIONS) {
      const info = makePageInfo(1, { x0: 0, y0: 0, x1: 612, y1: 792 }, rot);
      const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
      const u = normRectToUserRect(info, r);
      const back = userRectToNorm(info, u.x, u.y, u.x + u.width, u.y + u.height);
      expect(back.x).toBeCloseTo(r.x, 9);
      expect(back.y).toBeCloseTo(r.y, 9);
      expect(back.w).toBeCloseTo(r.w, 9);
      expect(back.h).toBeCloseTo(r.h, 9);
    }
  });
});

describe('resizeRect', () => {
  it('keeps a minimum size and stays on the page', () => {
    const r = resizeRect({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, 'se', 1, 1, 0.01, 0.01);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
    const tiny = resizeRect({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, 'nw', 0.5, 0.5, 0.02, 0.02);
    expect(tiny.w).toBeCloseTo(0.02);
    expect(tiny.h).toBeCloseTo(0.02);
  });
});
