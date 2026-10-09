import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { generateFilledPdf } from '../src/lib/render/generate';
import { formTarget, isRowValid, planRow } from '../src/lib/render/plan';
import type { ImageAsset } from '../src/lib/images/load';
import type { SheetRow, TextField } from '../src/types/project';
import { bengaliFontBytes, contextFor, imageField, makePng, makeTemplatePdf, projectFor, textField } from './helpers/fixtures';
import { openWithPdfjs, textPositions } from './helpers/pdfjsNode';

const row = (values: Record<string, string>): SheetRow => ({ sourceRow: 2, values });

describe('export places fields at the right PDF coordinates', () => {
  for (const rotation of [0, 90, 180, 270]) {
    it(`page /Rotate ${rotation}: text lands inside its field as displayed`, async () => {
      const template = await makeTemplatePdf([rotation]);
      const project = projectFor([{ rotation, width: 612, height: 792 }]);
      const rect = { x: 0.2, y: 0.3, w: 0.4, h: 0.06 };
      project.fields = [textField('name', 1, rect, { align: 'left', verticalAlign: 'middle' })];
      project.mapping = { name: { kind: 'column', column: 'Name', transform: 'none' } };
      const ctx = await contextFor(project);
      const plan = planRow(ctx, row({ Name: 'Amina Rahman' }), 0);
      const { bytes } = await generateFilledPdf({
        templateBytes: template,
        plan,
        formMode: 'flatten',
        formFieldFont: 'std:Helvetica',
        fontBytes: () => undefined,
      });
      const texts = await textPositions(bytes);
      const t = texts.find((x) => x.str.includes('Amina'));
      expect(t, 'text should be extractable').toBeDefined();
      // Text origin = left edge + padding, baseline inside the box.
      expect(t!.nx).toBeGreaterThanOrEqual(rect.x - 0.001);
      expect(t!.nx).toBeLessThan(rect.x + 0.02);
      expect(t!.ny).toBeGreaterThan(rect.y);
      expect(t!.ny).toBeLessThan(rect.y + rect.h);
    });
  }

  it('puts each field on its own page', async () => {
    const template = await makeTemplatePdf([0, 0, 0]);
    const project = projectFor([0, 0, 0].map((r) => ({ rotation: r, width: 612, height: 792 })));
    project.fields = [textField('a', 3, { x: 0.1, y: 0.1, w: 0.5, h: 0.05 })];
    (project.fields[0] as TextField).sampleValue = 'Third page';
    const ctx = await contextFor(project);
    const plan = planRow(ctx, null, null);
    const { bytes } = await generateFilledPdf({
      templateBytes: template,
      plan,
      formMode: 'flatten',
      formFieldFont: 'std:Helvetica',
      fontBytes: () => undefined,
    });
    expect((await textPositions(bytes, 1)).length).toBe(0);
    expect((await textPositions(bytes, 3)).map((t) => t.str).join('')).toContain('Third page');
  });

  it('never modifies the template bytes', async () => {
    const template = await makeTemplatePdf([0]);
    const copy = template.slice();
    const project = projectFor([{ rotation: 0, width: 612, height: 792 }]);
    project.fields = [textField('a', 1, { x: 0.1, y: 0.1, w: 0.5, h: 0.05 })];
    (project.fields[0] as TextField).sampleValue = 'Hello';
    const ctx = await contextFor(project);
    await generateFilledPdf({
      templateBytes: template,
      plan: planRow(ctx, null, null),
      formMode: 'flatten',
      formFieldFont: 'std:Helvetica',
      fontBytes: () => undefined,
    });
    expect(template).toEqual(copy);
  });
});

describe('fonts and international text', () => {
  it('flags characters the standard font cannot draw instead of drawing boxes', async () => {
    const project = projectFor([{ rotation: 0, width: 612, height: 792 }]);
    project.fields = [textField('name', 1, { x: 0.1, y: 0.1, w: 0.5, h: 0.05 })];
    project.mapping = { name: { kind: 'column', column: 'Name', transform: 'none' } };
    const ctx = await contextFor(project);
    const plan = planRow(ctx, row({ Name: 'আমিনা রহমান' }), 0);
    expect(plan.issues.some((i) => i.code === 'unsupported-character' && i.severity === 'error')).toBe(true);
    expect(isRowValid(plan)).toBe(false);
  });

  it('shapes Bengali with an uploaded font and uses the fallback font for Latin', async () => {
    const template = await makeTemplatePdf([0]);
    const project = projectFor([{ rotation: 0, width: 612, height: 792 }]);
    project.fonts = [
      {
        id: 'bn',
        name: 'Noto Sans Bengali',
        fileName: 'NotoSansBengali-Regular.ttf',
        family: 'Noto Sans Bengali',
        postscriptName: 'NotoSansBengali-Regular',
        glyphCount: 0,
        format: 'ttf',
      },
    ];
    project.fields = [textField('name', 1, { x: 0.1, y: 0.1, w: 0.8, h: 0.08 }, { font: 'custom:bn', fallbackFont: 'std:Helvetica', fontSize: 18 })];
    project.mapping = { name: { kind: 'column', column: 'Name', transform: 'none' } };
    const fontBytes = bengaliFontBytes();
    const ctx = await contextFor(project, { bn: fontBytes });
    const value = 'শিক্ষার্থী: আমিনা (ID 2024-০১)';
    const plan = planRow(ctx, row({ Name: value }), 0);
    expect(plan.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const line = plan.texts[0]!.stack.prepare(value);
    const kinds = line.runs.map((r) => r.kind);
    expect(kinds).toContain('custom');
    expect(kinds).toContain('standard');
    // "ক্ষ" is a conjunct: HarfBuzz must produce fewer glyphs than code points.
    const conj = ctx.fonts.stack('custom:bn', null).prepare('ক্ষ');
    const glyphs = conj.runs.flatMap((r) => (r.kind === 'custom' ? r.glyphs : []));
    expect(glyphs.length).toBeLessThan(Array.from('ক্ষ').length);
    expect(glyphs.every((g) => g.gid !== 0)).toBe(true);

    const { bytes } = await generateFilledPdf({
      templateBytes: template,
      plan,
      formMode: 'flatten',
      formFieldFont: 'std:Helvetica',
      fontBytes: (id) => (id === 'bn' ? fontBytes : undefined),
    });
    const pdf = await openWithPdfjs(bytes);
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('');
    expect(text).toContain('ID 2024');
    expect(bytes.length).toBeGreaterThan(50_000); // the font is embedded
  });

  it('reports glyphs missing from both the font and the fallback', async () => {
    const project = projectFor([{ rotation: 0, width: 612, height: 792 }]);
    project.fonts = [{ id: 'bn', name: 'Bengali', fileName: 'b.ttf', family: '', postscriptName: '', glyphCount: 0, format: 'ttf' }];
    project.fields = [textField('n', 1, { x: 0.1, y: 0.1, w: 0.8, h: 0.08 }, { font: 'custom:bn', fallbackFont: null })];
    (project.fields[0] as TextField).sampleValue = 'Amina';
    const ctx = await contextFor(project, { bn: bengaliFontBytes() });
    const plan = planRow(ctx, null, null);
    const issue = plan.issues.find((i) => i.code === 'unsupported-character');
    expect(issue?.message).toContain('"A"');
  });
});

describe('images and existing form fields', () => {
  it('embeds an image clipped to its field', async () => {
    const template = await makeTemplatePdf([0]);
    const project = projectFor([{ rotation: 0, width: 612, height: 792 }]);
    project.fields = [imageField('photo', 1, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { fit: 'cover' })];
    const ctx = await contextFor(project);
    const png = makePng(40, 20);
    const asset: ImageAsset = {
      id: 'i1',
      name: 'a.png',
      relativePath: 'a.png',
      byteLength: png.length,
      kind: 'png',
      width: 40,
      height: 20,
      pdfBytes: png,
      pdfKind: 'png',
      previewUrl: null,
      error: null,
      note: null,
    };
    ctx.images.samples.photo = asset;
    const plan = planRow(ctx, null, null);
    expect(plan.issues.some((i) => i.code === 'image-aspect')).toBe(true);
    expect(plan.issues.some((i) => i.code === 'image-low-resolution')).toBe(true);
    const { bytes } = await generateFilledPdf({
      templateBytes: template,
      plan,
      formMode: 'flatten',
      formFieldFont: 'std:Helvetica',
      fontBytes: () => undefined,
    });
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(1);
    expect(new TextDecoder('latin1').decode(bytes)).toMatch(/\/Subtype\s*\/Image/);
  });

  it('fills an existing AcroForm text field and flattens or keeps it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const tf = doc.getForm().createTextField('applicant.name');
    tf.addToPage(page, { x: 100, y: 600, width: 200, height: 24 });
    const template = await doc.save();
    const project = projectFor([{ rotation: 0, width: 612, height: 792 }]);
    project.formFields = [
      { name: 'applicant.name', kind: 'text', readOnly: false, required: false, multiline: false, options: [], widgets: [], fillable: true },
    ];
    project.mapping = { [formTarget('applicant.name')]: { kind: 'column', column: 'Name', transform: 'upper' } };
    const ctx = await contextFor(project);
    const plan = planRow(ctx, row({ Name: 'Amina' }), 0);

    const kept = await generateFilledPdf({
      templateBytes: template,
      plan,
      formMode: 'interactive',
      formFieldFont: 'std:Helvetica',
      fontBytes: () => undefined,
    });
    const keptDoc = await PDFDocument.load(kept.bytes);
    expect(keptDoc.getForm().getTextField('applicant.name').getText()).toBe('AMINA');

    const flat = await generateFilledPdf({ templateBytes: template, plan, formMode: 'flatten', formFieldFont: 'std:Helvetica', fontBytes: () => undefined });
    const flatDoc = await PDFDocument.load(flat.bytes);
    expect(flatDoc.getForm().getFields()).toHaveLength(0);
  });
});
