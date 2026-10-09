import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { collectBoxes, suggestFromBoxes, suggestFromText, type OpsLike } from '../src/lib/pdf/detect';
import { makePageInfo } from '../src/lib/pdf/coords';
import { openWithPdfjs, pdfjs } from './helpers/pdfjsNode';

async function analyze(bytes: Uint8Array) {
  const doc = await openWithPdfjs(bytes);
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const info = makePageInfo(1, { x0: 0, y0: 0, x1: 612, y1: 792 }, page.rotate);
  const content = await page.getTextContent();
  const runs = content.items.flatMap((item) => {
    if (!('str' in item) || !item.str.trim()) return [];
    const [x, y] = [item.transform[4] as number, item.transform[5] as number];
    const [ax, ay] = vp.convertToViewportPoint(x, y - item.height * 0.22) as [number, number];
    const [bx, by] = vp.convertToViewportPoint(x + item.width, y + item.height * 0.9) as [number, number];
    return [{ text: item.str, fontSize: item.height, rect: { x: Math.min(ax, bx) / vp.width, y: Math.min(ay, by) / vp.height, w: Math.abs(bx - ax) / vp.width, h: Math.abs(by - ay) / vp.height } }];
  });
  const ops = await page.getOperatorList();
  const boxes = collectBoxes(ops.fnArray, ops.argsArray, pdfjs.OPS as unknown as OpsLike);
  return [...suggestFromText(runs, info), ...suggestFromBoxes(boxes, info, runs)];
}

describe('field suggestions', () => {
  it('finds fill-in lines, placeholders and empty photo boxes', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([612, 792]);
    p.drawText('Name: ____________________', { x: 60, y: 700, size: 14, font });
    p.drawText('Dear {{ first_name }},', { x: 60, y: 650, size: 14, font });
    p.drawRectangle({ x: 400, y: 560, width: 110, height: 140, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    p.drawRectangle({ x: 60, y: 100, width: 490, height: 20, borderColor: rgb(0, 0, 0), borderWidth: 1 }); // too flat for a photo
    const s = await analyze(await doc.save());
    const line = s.find((x) => x.reason === 'fill-in line');
    expect(line?.label).toBe('Name');
    // Field sits over the underscores, to the right of the label.
    expect(line!.rect.x * 612).toBeGreaterThan(90);
    expect(s.find((x) => x.reason.startsWith('placeholder'))?.label).toBe('first_name');
    const photos = s.filter((x) => x.type === 'image');
    expect(photos).toHaveLength(1);
    expect(photos[0]!.rect.x * 612).toBeCloseTo(400, 0);
    expect(photos[0]!.rect.y * 792).toBeCloseTo(792 - 700, 0);
  });

  it('ignores boxes that contain text', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([612, 792]);
    p.drawRectangle({ x: 100, y: 500, width: 120, height: 120, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    p.drawText('Terms and conditions', { x: 110, y: 560, size: 10, font });
    expect((await analyze(await doc.save())).filter((x) => x.type === 'image')).toHaveLength(0);
  });
});
