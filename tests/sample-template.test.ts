import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateFilledPdf } from '../src/lib/render/generate';
import { planRow } from '../src/lib/render/plan';
import { contextFor, projectFor, textField } from './helpers/fixtures';
import { textPositions } from './helpers/pdfjsNode';

describe('sample template', () => {
  it('places text inside the field on a landscape page made by the sample script', async () => {
    const template = new Uint8Array(readFileSync('public/samples/certificate-template.pdf'));
    const project = projectFor([{ rotation: 0, width: 842, height: 595 }]);
    const rect = { x: 150 / 842, y: 172 / 595, w: 450 / 842, h: 40 / 595 };
    project.fields = [textField('n', 1, rect, { align: 'left' })];
    (project.fields[0] as { sampleValue: string }).sampleValue = 'Probe';
    const ctx = await contextFor(project);
    const { bytes } = await generateFilledPdf({ templateBytes: template, plan: planRow(ctx, null, null), formMode: 'flatten', formFieldFont: 'std:Helvetica', fontBytes: () => undefined });
    const t = (await textPositions(bytes)).find((x) => x.str === 'Probe')!;
    expect(t.ny * 595).toBeGreaterThan(172);
    expect(t.ny * 595).toBeLessThan(212);
  });
});
