import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import { PdfTextIndex } from '../src/lib/pdfium/textIndex';
import { applyReplacements, type ReplaceOp } from '../src/lib/pdfium/replace';
import { fixture, liberation, pageTexts, pdfium, pixelsChangedOutside, renderPage } from './helpers/pdfium';
import { textPositions } from './helpers/pdfjsNode';

function op(index: PdfTextIndex, page: number, text: string, value: string, extra: Partial<ReplaceOp> = {}): ReplaceOp {
  const o = index.page(page).objects.find((x) => x.text === text)!;
  expect(o, `text object “${text}”`).toBeDefined();
  return {
    id: text,
    targets: [{ page, objectIndex: o.index, text: o.text }],
    selection: { start: 0, end: o.text.length },
    value,
    mode: 'in-place',
    align: 'left',
    fit: 'overflow',
    minScale: 0.5,
    sizeScale: 1,
    maxWidth: 1e6,
    originalWidth: o.width,
    ...extra,
  };
}

async function subsetInvoice() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await doc.embedFont(liberation(), { subset: true });
  const p = doc.addPage([612, 792]);
  p.drawRectangle({ x: 40, y: 600, width: 532, height: 150, color: rgb(0.9, 0.95, 1) });
  p.drawText('Invoice for Amina Rahman', { x: 60, y: 700, size: 22, font: f, color: rgb(0.1, 0.2, 0.5) });
  p.drawText('Total due: 125.00', { x: 60, y: 650, size: 14, font: f, color: rgb(0.6, 0.1, 0.1) });
  p.drawText('Thank you', { x: 400, y: 300, size: 18, font: f, rotate: degrees(30) });
  return doc.save();
}

describe('PDFium text index', () => {
  it('reports font, size, colour, rotation and bounds of existing text', async () => {
    const P = await pdfium();
    const index = new PdfTextIndex(P, fixture('designed-certificate.pdf'));
    const objs = index.page(1).objects;
    const name = objs.find((o) => o.text === 'Amina Rahman')!;
    expect(name.fontName).toBe('AAAAAA+LiberationSans-Bold');
    expect(name.embedded).toBe(1);
    expect(name.subset).toBe(true);
    expect(name.effectiveSize).toBeCloseTo(25.5, 1);
    expect(name.color).toBe('#b8312f');
    expect(name.unsupported).toBeNull();
    const stamp = objs.find((o) => o.text === 'VERIFIED')!;
    expect(stamp.rotation).toBeCloseTo(20, 0);
    expect(index.missingChars(1, name.index, 'Rafi Chowdhury').sort().join('')).toBe('Cdforuwy');
    expect(index.missingChars(1, name.index, 'Amin Rahman')).toEqual([]);
    expect(index.availableChars(1, name.index)).toContain('R');
    index.close();
  });

  it('detects subset fonts without a name prefix and standard fonts', async () => {
    const P = await pdfium();
    const index = new PdfTextIndex(P, await subsetInvoice());
    const inv = index.page(1).objects.find((o) => o.text === 'Invoice for Amina Rahman')!;
    expect(inv.subset).toBe(true);
    expect(index.missingChars(1, inv.index, 'Mira')).toEqual(['M']);
    index.close();
    const doc = await PDFDocument.create();
    doc.addPage().drawText('Hello', { font: await doc.embedFont(StandardFonts.Helvetica), x: 50, y: 50 });
    const std = new PdfTextIndex(P, await doc.save());
    const hello = std.page(1).objects[0]!;
    expect(hello.standardFont).toBe(true);
    expect(hello.reuseBlocker).toBeNull();
    expect(std.missingChars(1, hello.index, 'Ünïcode é')).toEqual([]);
    std.close();
  });

  it('marks invisible OCR text and Form XObject text as unsupported', async () => {
    const P = await pdfium();
    const inner = await PDFDocument.create();
    inner.addPage([300, 200]).drawText('Inside a form', { x: 20, y: 100, size: 14, font: await inner.embedFont(StandardFonts.Helvetica) });
    const outer = await PDFDocument.create();
    const [embedded] = await outer.embedPdf(await inner.save());
    const page = outer.addPage([612, 792]);
    page.drawPage(embedded!, { x: 50, y: 400 });
    const index = new PdfTextIndex(P, await outer.save());
    const pg = index.page(1);
    expect(pg.objects).toHaveLength(0);
    expect(pg.blocked).toHaveLength(1);
    expect(pg.blocked[0]!.reason).toMatch(/Form XObject/);
    index.close();
  });
});

describe('true text replacement', () => {
  it('changes text in place, keeps everything else pixel-identical, and never touches the source', async () => {
    const P = await pdfium();
    const src = fixture('designed-certificate.pdf');
    const copy = src.slice();
    const index = new PdfTextIndex(P, src);
    const ops = [op(index, 1, 'Certificate No: C-2024-001', 'Certificate No: C-2024-002'), op(index, 1, 'VERIFIED', 'DIVE')];
    const before = index
      .page(1)
      .objects.filter((o) => ops.some((x) => x.id === o.text))
      .map((o) => o.bounds as number[]);
    const { bytes, outcomes } = applyReplacements(P, src, ops);
    expect(outcomes.map((o) => o.mode)).toEqual(['in-place', 'in-place']);
    expect(src).toEqual(copy);
    const texts = pageTexts(P, bytes).map((t) => t.text);
    expect(texts).toContain('Certificate No: C-2024-002');
    expect(texts).not.toContain('Certificate No: C-2024-001');
    expect(texts).not.toContain('VERIFIED');
    const after = new PdfTextIndex(P, bytes);
    const changed = after.page(1).objects.filter((o) => ['Certificate No: C-2024-002', 'DIVE'].includes(o.text));
    expect(changed.find((o) => o.text === 'DIVE')!.rotation).toBeCloseTo(20, 0);
    expect(changed.find((o) => o.text === 'DIVE')!.color).toBe('#c0392b');
    const rects = [...before, ...changed.map((o) => o.bounds as number[])];
    after.close();
    index.close();
    expect(pixelsChangedOutside(renderPage(P, copy), renderPage(P, bytes), rects)).toBe(0);
    // Also confirmed by PDF.js, which apps like Firefox use.
    const pdfjsText = (await textPositions(bytes)).map((t) => t.str).join(' ');
    expect(pdfjsText).toContain('C-2024-002');
    expect(pdfjsText).not.toContain('C-2024-001');
  });

  it('replaces only the selected part of a text object', async () => {
    const P = await pdfium();
    const index = new PdfTextIndex(P, fixture('designed-certificate.pdf'));
    const base = op(index, 1, 'Certificate No: C-2024-001', '42');
    const { bytes } = applyReplacements(P, fixture('designed-certificate.pdf'), [{ ...base, selection: { start: 24, end: 26 } }]);
    expect(pageTexts(P, bytes).map((t) => t.text)).toContain('Certificate No: C-2024-042');
    // '9' is not in the subset font: PDFium would silently drop it, so the engine refuses.
    expect(() => applyReplacements(P, fixture('designed-certificate.pdf'), [{ ...base, value: '9', selection: { start: 25, end: 26 } }])).toThrow(
      /cannot encode/,
    );
    index.close();
  });

  it('removes the original object for redrawing in another font', async () => {
    const P = await pdfium();
    const index = new PdfTextIndex(P, fixture('designed-certificate.pdf'));
    const o = op(index, 1, 'Amina Rahman', 'Rafi Chowdhury', { mode: 'remove' });
    index.close();
    const { bytes, outcomes } = applyReplacements(P, fixture('designed-certificate.pdf'), [o]);
    expect(outcomes[0]!.geometry.effectiveSize).toBeCloseTo(25.5, 1);
    expect(outcomes[0]!.geometry.color).toEqual([184, 49, 47]);
    expect(pageTexts(P, bytes).map((t) => t.text)).not.toContain('Amina Rahman');
  });

  it('shrinks to fit and centres relative to the original text', async () => {
    const P = await pdfium();
    const src = await subsetInvoice();
    const index = new PdfTextIndex(P, src);
    const o = op(index, 1, 'Total due: 125.00', 'Total due: 125000000.00', { fit: 'shrink', maxWidth: 0, align: 'center' });
    const orig = index.page(1).objects.find((x) => x.text === 'Total due: 125.00')!;
    o.maxWidth = orig.width;
    index.close();
    const { bytes, outcomes } = applyReplacements(P, src, [o]);
    expect(outcomes[0]!.scale).toBeLessThan(1);
    expect(outcomes[0]!.overflow).toBe(false);
    const after = new PdfTextIndex(P, bytes);
    const changed = after.page(1).objects.find((x) => x.text === 'Total due: 125000000.00')!;
    expect(changed.width).toBeLessThanOrEqual(orig.width + 0.5);
    expect((changed.bounds[0] + changed.bounds[2]) / 2).toBeCloseTo((orig.bounds[0] + orig.bounds[2]) / 2, 0);
    after.close();
  });

  it('refuses to apply when the PDF no longer matches the template', async () => {
    const P = await pdfium();
    const bad: ReplaceOp = {
      id: 'x',
      targets: [{ page: 1, objectIndex: 3, text: 'Something else' }],
      selection: { start: 0, end: 14 },
      value: 'v',
      mode: 'in-place',
      align: 'left',
      fit: 'overflow',
      minScale: 0.5,
      sizeScale: 1,
      maxWidth: 100,
      originalWidth: 50,
    };
    expect(() => applyReplacements(P, fixture('designed-certificate.pdf'), [bad])).toThrow(/no longer at its recorded position/);
  });
});
