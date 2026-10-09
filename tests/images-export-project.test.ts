import { describe, expect, it } from 'vitest';
import { ImageIndex, normalizeKey, safePathSegments } from '../src/lib/images/match';
import { readImageHeader, sniffImageKind } from '../src/lib/images/detect';
import { placeImage, aspectMismatch } from '../src/lib/images/fit';
import { FileNameAllocator, sanitizeFileBase, applyFileNamePattern } from '../src/lib/export/filenames';
import { runBatch, zipResults } from '../src/lib/export/batch';
import { createProject, parseProjectJson, ProjectFileError, serializeProject, validateProject } from '../src/lib/storage/projectFile';
import { packBundle, unpackBundle } from '../src/lib/storage/bundle';
import { PROJECT_FORMAT_VERSION, type ExportJob } from '../src/types/project';
import { makePng } from './helpers/fixtures';
import JSZip from 'jszip';

describe('image filename matching', () => {
  const files = [
    { id: '1', name: 'amina.jpg', relativePath: 'class/photos/amina.jpg' },
    { id: '2', name: 'John.PNG', relativePath: 'class/photos/John.PNG' },
    { id: '3', name: 'same.jpg', relativePath: 'class/a/same.jpg' },
    { id: '4', name: 'same.jpg', relativePath: 'class/b/same.jpg' },
    { id: '5', name: 'rahim.jpeg', relativePath: 'rahim.jpeg' },
  ];
  const index = new ImageIndex(files);

  it('matches by file name, case-insensitively, ignoring folders in the cell', () => {
    expect(index.match('photos/amina.jpg')).toMatchObject({ status: 'matched', fileId: '1' });
    expect(index.match('JOHN.png')).toMatchObject({ status: 'matched', fileId: '2' });
    expect(index.match('C:\\Users\\me\\photos\\amina.jpg')).toMatchObject({ status: 'matched', fileId: '1' });
  });

  it('matches by name without extension when unique', () => {
    expect(index.match('rahim')).toMatchObject({ status: 'matched', fileId: '5' });
  });

  it('treats path traversal as a plain lookup key', () => {
    expect(safePathSegments('../../etc/passwd')).toEqual(['etc', 'passwd']);
    expect(normalizeKey('file:///etc/../photos/./amina.jpg')).toBe('etc/photos/amina.jpg');
    expect(index.match('../../../amina.jpg')).toMatchObject({ status: 'matched', fileId: '1' });
    expect(index.match('/etc/passwd')).toMatchObject({ status: 'not-found' });
  });

  it('reports duplicates as ambiguous unless the folder disambiguates', () => {
    expect(index.match('same.jpg')).toMatchObject({ status: 'ambiguous', candidates: ['3', '4'] });
    expect(index.match('b/same.jpg')).toMatchObject({ status: 'matched', fileId: '4' });
    expect(index.duplicateNames()).toEqual([['class/a/same.jpg', 'class/b/same.jpg']]);
  });

  it('reports missing and empty values, and honours manual matches', () => {
    expect(index.match('nobody.jpg').status).toBe('not-found');
    expect(index.match('  ').status).toBe('empty');
    expect(index.match(null).status).toBe('empty');
    expect(index.match('same.jpg', { 'same.jpg': '3' })).toMatchObject({ status: 'manual', fileId: '3' });
  });
});

describe('image detection and fitting', () => {
  it('detects type and size from bytes, not the extension', () => {
    const png = makePng(30, 12);
    expect(sniffImageKind(png)).toBe('png');
    expect(readImageHeader(png)).toMatchObject({ width: 30, height: 12 });
    expect(sniffImageKind(new TextEncoder().encode('<svg></svg>'))).toBe('unknown');
  });

  it('reads JPEG size and EXIF orientation', () => {
    // SOI, APP1(Exif, orientation 6), SOF0 (h=10, w=20)
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    const app1 = [0xff, 0xe1, 0, exif.length + 2, ...exif];
    const sof = [0xff, 0xc0, 0, 11, 8, 0, 10, 0, 20, 1, 1, 0x11, 0];
    const jpg = Uint8Array.from([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
    expect(readImageHeader(jpg)).toEqual({ kind: 'jpeg', width: 20, height: 10, orientation: 6 });
  });

  it('computes contain / cover / stretch placement', () => {
    expect(placeImage(200, 100, 100, 100, 'contain')).toMatchObject({ width: 100, height: 50, x: 0, y: 25, clip: false });
    expect(placeImage(200, 100, 100, 100, 'cover')).toMatchObject({ width: 200, height: 100, x: -50, y: 0, clip: true });
    expect(placeImage(200, 100, 100, 100, 'stretch')).toMatchObject({ width: 100, height: 100, clip: false });
    expect(placeImage(200, 100, 100, 100, 'contain', 'left', 'top')).toMatchObject({ x: 0, y: 50 });
    expect(aspectMismatch(100, 100, 50, 50)).toBe(0);
  });
});

describe('output file names', () => {
  it('sanitizes unsafe characters and reserved names', () => {
    expect(sanitizeFileBase('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFileBase('a<b>:c"d|e?f*g')).toBe('a-b-c-d-e-f-g');
    expect(sanitizeFileBase('CON')).toBe('_CON');
    expect(sanitizeFileBase('  ...hidden  ')).toBe('hidden');
    expect(sanitizeFileBase('আমিনা রহমান')).toBe('আমিনা রহমান');
  });

  it('makes names unique case-insensitively', () => {
    const a = new FileNameAllocator();
    expect(a.allocate('Amina', 'x')).toBe('Amina.pdf');
    expect(a.allocate('amina', 'x')).toBe('amina (2).pdf');
    expect(a.allocate('', 'Template - row 3')).toBe('Template - row 3.pdf');
  });

  it('fills patterns from row values', () => {
    const row = { sourceRow: 7, values: { Name: 'Amina', ID: 12 } };
    expect(applyFileNamePattern('{Name} - {id} ({row})', row, 7, 'Cert')).toBe('Amina - 12 (7)');
    expect(applyFileNamePattern('{template}', null, 1, 'Cert')).toBe('Cert');
  });
});

describe('batch export', () => {
  const job: ExportJob = { id: 'j', rowIndexes: [0, 1, 2], options: { scope: 'valid', fileNamePattern: '{Name}', formMode: 'flatten', zip: true }, startedAt: 0 };
  const rows = ['A', 'B', 'C'].map((Name, i) => ({ rowIndex: i, row: { sourceRow: i + 2, values: { Name } } }));

  it('continues after a row fails and keeps successful outputs', async () => {
    const progress: number[] = [];
    const summary = await runBatch(
      { job, rows, templateName: 'T' },
      {
        generate: async ({ rowIndex }) => {
          if (rowIndex === 1) throw new Error('boom');
          return { bytes: new Uint8Array([rowIndex]), warnings: [] };
        },
        onProgress: (done) => progress.push(done),
      },
    );
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(summary.results[1]).toMatchObject({ status: 'failed', error: 'boom', fileName: 'B.pdf' });
    expect(progress).toEqual([1, 2, 3]);

    const zipBytes = await zipResults(summary.results);
    const zip = await JSZip.loadAsync(zipBytes);
    expect(Object.keys(zip.files).sort()).toEqual(['A.pdf', 'C.pdf', 'export-report.txt']);
  });

  it('blocks rows with validation errors without stopping the job', async () => {
    const summary = await runBatch(
      { job, rows, templateName: 'T' },
      {
        blockingIssues: ({ rowIndex }) => (rowIndex === 0 ? [{ code: 'required-missing', severity: 'error', message: 'Name missing' }] : []),
        generate: async () => ({ bytes: new Uint8Array([1]), warnings: [] }),
      },
    );
    expect(summary.results[0]).toMatchObject({ status: 'failed', error: 'Name missing' });
    expect(summary.completed).toBe(2);
  });

  it('can be cancelled between rows', async () => {
    let n = 0;
    const summary = await runBatch({ job, rows, templateName: 'T' }, { generate: async () => ({ bytes: new Uint8Array(), warnings: [] }), isCancelled: () => n++ >= 1 });
    expect(summary.cancelled).toBe(true);
    expect(summary.results).toHaveLength(1);
  });
});

describe('project files', () => {
  it('round-trips a project', () => {
    const p = createProject('Certificates');
    p.fields.push({
      id: 'fld_1',
      type: 'text',
      label: 'Name',
      page: 1,
      rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
      required: true,
      sampleValue: 'Amina',
      style: { font: 'std:Times-Bold', fallbackFont: null, fontSize: 20, minFontSize: 8, lineHeight: 1.2, color: '#112233', align: 'center', verticalAlign: 'middle', padding: 2, fit: 'shrink', rotation: 0, background: null },
    });
    p.mapping.fld_1 = { kind: 'column', column: 'Full Name', transform: 'title' };
    const back = parseProjectJson(serializeProject(p));
    expect(back.project).toEqual(p);
    expect(back.warnings).toEqual([]);
  });

  it('rejects newer versions, foreign files and invalid JSON', () => {
    expect(() => validateProject({ format: 'pdf-template-studio/project', version: PROJECT_FORMAT_VERSION + 1 })).toThrow(/newer version/);
    expect(() => validateProject({ format: 'something-else', version: 1 })).toThrow(ProjectFileError);
    expect(() => parseProjectJson('{oops')).toThrow(/invalid JSON/);
    expect(() => validateProject([])).toThrow(ProjectFileError);
  });

  it('migrates format version 0', () => {
    const r = validateProject({ version: 0, name: 'Old', template: { fields: [{ id: 'a', type: 'image', label: 'Photo', page: 1, rect: { x: 0, y: 0, w: 0.2, h: 0.2 } }] } });
    expect(r.migratedFrom).toBe(0);
    expect(r.project.version).toBe(PROJECT_FORMAT_VERSION);
    expect(r.project.fields[0]).toMatchObject({ type: 'image', label: 'Photo', style: { fit: 'contain' } });
  });

  it('drops invalid values instead of trusting them', () => {
    const r = validateProject({
      format: 'pdf-template-studio/project',
      version: 1,
      fields: [
        { id: 'ok', type: 'text', label: 'A', page: 1, rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, style: { color: 'javascript:alert(1)', font: 'custom:unknown', fit: 'explode' } },
        { id: 'bad', type: 'script', rect: { x: 0, y: 0, w: 1, h: 1 } },
        { id: 'nan', type: 'text', rect: { x: 'a', y: 0, w: 1, h: 1 } },
      ],
      mapping: { ok: { kind: 'eval', code: 'alert(1)' } },
      __proto__: { polluted: true },
    });
    expect(r.project.fields).toHaveLength(1);
    const f = r.project.fields[0]!;
    expect(f.type === 'text' && f.style.color).toBe('#000000');
    expect(f.type === 'text' && f.style.font).toBe('std:Helvetica');
    expect(f.type === 'text' && f.style.fit).toBe('shrink');
    expect(r.project.mapping).toEqual({});
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('packs and unpacks a bundle with the PDF and fonts', async () => {
    const p = createProject('Bundle');
    p.fonts = [{ id: 'f1', name: 'My Font', fileName: 'f.ttf', family: 'F', postscriptName: 'F', glyphCount: 1, format: 'ttf' }];
    const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF');
    const bytes = await packBundle({ project: p, pdfBytes: pdf, fonts: new Map([['f1', new Uint8Array([1, 2, 3])]]) });
    const back = await unpackBundle(bytes);
    expect(back.project.name).toBe('Bundle');
    expect(back.pdfBytes).toEqual(pdf);
    expect(back.fonts.get('f1')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses archives without a project manifest', async () => {
    const zip = new JSZip();
    zip.file('evil.js', 'alert(1)');
    await expect(unpackBundle(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/project.json/);
  });
});
