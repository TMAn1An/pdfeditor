import { describe, expect, it } from 'vitest';
import { PdfTextIndex } from '../src/lib/pdfium/textIndex';
import { suggestFieldLabel } from '../src/lib/pdfium/labels';
import { createReplaceField } from '../src/features/template-editor/fieldFactory';
import { planRow } from '../src/lib/render/plan';
import { generateFilledPdf } from '../src/lib/render/generate';
import { parseProjectJson, serializeProject } from '../src/lib/storage/projectFile';
import { FontLibrary } from '../src/lib/fonts/engine';
import { STANDARD_FONTS } from '../src/lib/fonts/standard';
import type { FontRef, ReplaceField, SheetRow, TemplateProject } from '../src/types/project';
import { bengaliFontBytes, projectFor } from './helpers/fixtures';
import { fixture, liberation, pageTexts, pdfium, pixelsChangedOutside, renderPage } from './helpers/pdfium';

const row = (values: Record<string, string>, n = 2): SheetRow => ({ sourceRow: n, values });

async function setup() {
  const P = await pdfium();
  const bytes = fixture('designed-certificate.pdf');
  const index = new PdfTextIndex(P, bytes);
  const pg = index.page(1);
  const project: TemplateProject = projectFor([{ rotation: 0, width: pg.info.box.x1 - pg.info.box.x0, height: pg.info.box.y1 - pg.info.box.y0 }]);
  project.pdf!.pages = [pg.info];
  const fontBytes: Record<string, Uint8Array> = { libBold: liberation(true), bn: bengaliFontBytes() };
  project.fonts = [
    {
      id: 'libBold',
      name: 'Liberation Sans Bold',
      fileName: 'LiberationSans-Bold.ttf',
      family: 'Liberation Sans',
      postscriptName: 'LiberationSans-Bold',
      glyphCount: 0,
      format: 'ttf',
    },
    {
      id: 'bn',
      name: 'Noto Sans Bengali',
      fileName: 'NotoSansBengali-Regular.ttf',
      family: 'Noto Sans Bengali',
      postscriptName: '',
      glyphCount: 0,
      format: 'ttf',
    },
  ];
  const fieldFor = (text: string, label: string, sel?: { start: number; end: number }) => {
    const o = pg.objects.find((x) => x.text === text)!;
    return createReplaceField(project, [o], sel ?? { start: 0, end: o.text.length }, label, pg.info, index.availableChars(1, o.index));
  };
  const fonts = new FontLibrary((id) => fontBytes[id]);
  await fonts.prepare([...STANDARD_FONTS.map((f) => `std:${f.id}` as FontRef), 'custom:libBold', 'custom:bn']);
  const ctx = () => ({ project, fonts, textIndex: index, images: { index: null, assets: new Map(), overrides: {}, samples: {} } });
  const generate = (plan: ReturnType<typeof planRow>) =>
    generateFilledPdf({ templateBytes: bytes, plan, formMode: 'flatten', formFieldFont: 'std:Helvetica', fontBytes: (id) => fontBytes[id] });
  return { P, bytes, index, project, fieldFor, ctx, generate };
}

describe('replace fields end to end', () => {
  it('creates fields with detected properties and sensible labels', async () => {
    const { project, fieldFor, index } = await setup();
    const name = fieldFor('Amina Rahman', suggestFieldLabel('Amina Rahman', { start: 0, end: 12 }));
    expect(name.label).toBe('Name');
    expect(name.original.fontName).toBe('AAAAAA+LiberationSans-Bold');
    expect(name.original.color).toBe('#b8312f');
    expect(name.style.align).toBe('left');
    const cert = fieldFor('Certificate No: C-2024-001', suggestFieldLabel('Certificate No: C-2024-001', { start: 16, end: 26 }), { start: 16, end: 26 });
    expect(cert.label).toBe('Certificate No');
    expect(cert.sampleValue).toBe('C-2024-001');
    project.fields.push(name, cert);
    index.close();
  });

  it('exports rows with in-place edits and font replacement, leaving the rest of the design untouched', async () => {
    const { P, bytes, index, project, fieldFor, ctx, generate } = await setup();
    const name = fieldFor('Amina Rahman', 'Name');
    name.style.replacementFont = 'custom:libBold';
    const cert = fieldFor('Certificate No: C-2024-001', 'Certificate No', { start: 16, end: 26 });
    project.fields.push(name, cert);
    project.mapping[name.id] = { kind: 'column', column: 'Name', transform: 'none' };
    project.mapping[cert.id] = { kind: 'column', column: 'ID', transform: 'none' };

    // Row 1: every character exists in the original subset fonts → in-place for both.
    const plan1 = planRow(ctx(), row({ Name: 'Amin Rahman', ID: 'C-2024-002' }), 0);
    expect(plan1.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(plan1.replacements.map((r) => r.mode)).toEqual(['in-place', 'in-place']);
    const out1 = (await generate(plan1)).bytes;
    const t1 = pageTexts(P, out1);
    expect(t1.map((t) => t.text)).toEqual(expect.arrayContaining(['Amin Rahman', 'Certificate No: C-2024-002']));
    expect(t1.find((t) => t.text === 'Amin Rahman')!.font).toBe('AAAAAA+LiberationSans-Bold');

    // Row 2: the name needs letters the subset lacks → original removed, value drawn in the chosen font.
    const plan2 = planRow(ctx(), row({ Name: 'Rafi Chowdhury', ID: 'C-2024-004' }, 3), 1);
    expect(plan2.replacements.map((r) => r.mode)).toEqual(['font', 'in-place']);
    expect(plan2.issues.some((i) => i.code === 'replace-font' && i.severity === 'info')).toBe(true);
    const out2 = (await generate(plan2)).bytes;
    const texts2 = pageTexts(P, out2).map((t) => t.text);
    expect(texts2.join('|')).not.toContain('Amina');
    expect(texts2.join('|')).not.toContain('C-2024-001');
    expect(texts2.join('')).toContain('C-2024-004');
    // Everything except the two edited areas is pixel-identical to the source.
    const rects = [name.original.bounds as number[], cert.original.bounds as number[]].map(([l, b, r, t]) => [l! - 20, b! - 6, r! + 120, t! + 6]);
    expect(pixelsChangedOutside(renderPage(P, bytes), renderPage(P, out2), rects)).toBe(0);
    index.close();
  });

  it('refuses rows the original font cannot draw unless a replacement font is set', async () => {
    const { index, project, fieldFor, ctx } = await setup();
    const name = fieldFor('Amina Rahman', 'Name');
    name.style.fontMode = 'original';
    project.fields.push(name);
    project.mapping[name.id] = { kind: 'column', column: 'Name', transform: 'none' };
    const plan = planRow(ctx(), row({ Name: 'Zoë Smith' }), 0);
    const err = plan.issues.find((i) => i.severity === 'error')!;
    expect(err.message).toMatch(/has no glyphs for/);
    expect(err.message).toMatch(/AAAAAA\+LiberationSans-Bold/);
    name.style.fontMode = 'auto';
    expect(planRow(ctx(), row({ Name: 'Zoë Smith' }), 0).issues.find((i) => i.severity === 'error')!.message).toMatch(/Choose a replacement font/);
    index.close();
  });

  it('shapes Bangla values with an uploaded font instead of editing in place', async () => {
    const { P, index, project, fieldFor, ctx, generate } = await setup();
    const name = fieldFor('Amina Rahman', 'Name');
    name.style.replacementFont = 'custom:bn';
    project.fields.push(name);
    project.mapping[name.id] = { kind: 'column', column: 'Name', transform: 'none' };
    const plan = planRow(ctx(), row({ Name: 'আমিনা রহমান' }), 0);
    expect(plan.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(plan.replacements[0]!.mode).toBe('font');
    const out = (await generate(plan)).bytes;
    expect(
      pageTexts(P, out)
        .map((t) => t.text)
        .join('|'),
    ).not.toContain('Amina');
    index.close();
  });

  it('warns when a value does not fit and shrinks when asked', async () => {
    const { index, project, fieldFor, ctx } = await setup();
    const cert = fieldFor('Certificate No: C-2024-001', 'Certificate No', { start: 16, end: 26 });
    project.fields.push(cert);
    cert.sampleValue = 'C-2024-001-001-001-001-001-001-001';
    cert.style.fit = 'overflow';
    expect(planRow(ctx(), null, null).issues.some((i) => i.code === 'text-too-long' && i.severity === 'warning')).toBe(true);
    cert.style.fit = 'shrink';
    const plan = planRow(ctx(), null, null);
    expect(plan.replacements[0]!.scale).toBeLessThan(1);
    index.close();
  });

  it('round-trips replace fields through the project file', async () => {
    const { project, fieldFor, index } = await setup();
    project.fields.push(fieldFor('Amina Rahman', 'Name'));
    const back = parseProjectJson(serializeProject(project));
    const f = back.project.fields[0] as ReplaceField;
    expect(f.type).toBe('replace');
    expect(f.targets[0]!.text).toBe('Amina Rahman');
    expect(f.original.matrix).toHaveLength(6);
    expect(back.project.version).toBe(2);
    index.close();
  });
});

describe('field label suggestions', () => {
  it('uses inline labels, neighbours and value patterns', () => {
    expect(suggestFieldLabel('Total due: 125.00', { start: 11, end: 17 })).toBe('Total due');
    expect(suggestFieldLabel('2024-03-15', { start: 0, end: 10 })).toBe('Date');
    expect(suggestFieldLabel('Amina Rahman', { start: 0, end: 12 })).toBe('Name');
    expect(suggestFieldLabel('C-2024-001', { start: 0, end: 10 })).toBe('ID');
    expect(suggestFieldLabel('125.00', { start: 0, end: 6 })).toBe('Amount');
    expect(suggestFieldLabel('Rahman', { start: 0, end: 6 }, [{ text: 'Surname:', dx: -60, dy: 0 }])).toBe('Surname');
  });
});
