import { describe, expect, it } from 'vitest';
import { parseCsvText, readXlsxWorkbook, sheetFromWorkbook, decodeCsvBytes } from '../src/lib/spreadsheet/parse';
import { suggestColumns, normalizeName, scoreNames } from '../src/lib/mapping/suggest';
import { applyTransform, formatDate, resolveText, cellToDate } from '../src/lib/mapping/values';
import JSZip from 'jszip';

describe('CSV parsing', () => {
  it('reads headers and rows, including quoted commas and Unicode', () => {
    const sheet = parseCsvText('Full Name,City,Photo\n"Rahman, Amina",ঢাকা,photos/amina.jpg\nJohn Doe,Leeds,john.png\n', 'people.csv');
    expect(sheet.columns.map((c) => c.key)).toEqual(['Full Name', 'City', 'Photo']);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]!.values['Full Name']).toBe('Rahman, Amina');
    expect(sheet.rows[0]!.values.City).toBe('ঢাকা');
    expect(sheet.rows[0]!.sourceRow).toBe(2);
  });

  it('detects missing, duplicate and empty headers/columns', () => {
    const sheet = parseCsvText('Name,,Name,Notes\nA,1,B,\nC,2,D,\n', 'x.csv');
    expect(sheet.columns.map((c) => c.key)).toEqual(['Name', 'Column B', 'Name (2)', 'Notes']);
    const kinds = sheet.issues.map((i) => i.kind);
    expect(kinds).toContain('missing-header');
    expect(kinds).toContain('duplicate-header');
    expect(kinds).toContain('empty-column');
  });

  it('reports blank values and malformed rows', () => {
    const sheet = parseCsvText('Name,ID\nA,1\nB\n,3\nC,4,extra\n', 'x.csv');
    const kinds = sheet.issues.map((i) => i.kind);
    expect(kinds).toContain('malformed-row');
    expect(kinds).toContain('blank-values');
    expect(sheet.rows).toHaveLength(4);
  });

  it('reports an unclosed quote', () => {
    const sheet = parseCsvText('Name,ID\n"A,1\nB,2\n', 'x.csv');
    expect(sheet.issues.some((i) => i.kind === 'malformed-row')).toBe(true);
  });

  it('supports a header row other than the first', () => {
    const sheet = parseCsvText('Certificate list 2024\n\nName,ID\nA,1\n', 'x.csv', 3);
    expect(sheet.columns.map((c) => c.key)).toEqual(['Name', 'ID']);
    expect(sheet.rows[0]!.sourceRow).toBe(4);
  });

  it('skips empty rows and reports when there is no data', () => {
    expect(parseCsvText('Name\n', 'x.csv').issues.some((i) => i.kind === 'no-rows')).toBe(true);
    const s = parseCsvText('Name\nA\n\n\nB\n', 'x.csv');
    expect(s.rows).toHaveLength(2);
    expect(s.issues.some((i) => i.kind === 'empty-rows-skipped')).toBe(true);
  });

  it('decodes UTF-8 with BOM and falls back to Windows-1252', () => {
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toContain('A');
    expect(decodeCsvBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
  });
});

describe('XLSX parsing', () => {
  it('reads worksheets and lets the caller choose one', async () => {
    const xlsx = await makeXlsx({
      People: [
        ['Name', 'Score'],
        ['Amina', '95'],
      ],
      Other: [['Code'], ['X1']],
    });
    const wb = await readXlsxWorkbook(xlsx.buffer as ArrayBuffer);
    expect(wb.sheets.map((s) => s.name)).toEqual(['People', 'Other']);
    const people = sheetFromWorkbook(wb, 'f.xlsx', 'People');
    expect(people.availableSheets).toEqual(['People', 'Other']);
    expect(people.rows[0]!.values.Name).toBe('Amina');
    const other = sheetFromWorkbook(wb, 'f.xlsx', 'Other');
    expect(other.columns.map((c) => c.key)).toEqual(['Code']);
  });

  it('rejects files that are not workbooks with a clear message', async () => {
    await expect(readXlsxWorkbook(new Uint8Array([1, 2, 3]).buffer)).rejects.toThrow(/could not be read/);
  });
});

describe('mapping suggestions', () => {
  const columns = ['Participant Name', 'Serial Number', 'Photo File', 'Course', 'Email'];

  it('matches synonyms', () => {
    expect(suggestColumns('f1', 'Full Name', columns).candidates[0]?.column).toBe('Participant Name');
    expect(suggestColumns('f2', 'Certificate ID', columns).candidates[0]?.column).toBe('Serial Number');
    expect(suggestColumns('f3', 'Photo', columns).candidates[0]?.column).toBe('Photo File');
  });

  it('prefers exact matches and is confident about them', () => {
    const s = suggestColumns('f', 'course', columns);
    expect(s.candidates[0]).toMatchObject({ column: 'Course', reason: 'exact' });
    expect(s.confident).toBe(true);
  });

  it('is not confident when several columns are equally plausible', () => {
    const s = suggestColumns('f', 'Name', ['Student Name', 'Participant Name', 'Score']);
    expect(s.candidates.length).toBeGreaterThanOrEqual(2);
    expect(s.confident).toBe(false);
  });

  it('suggests nothing for unrelated names', () => {
    expect(suggestColumns('f', 'Signature', ['Amount', 'Zip']).candidates).toEqual([]);
  });

  it('normalizes case, punctuation and camelCase', () => {
    expect(normalizeName('certificate_ID')).toBe('certificate id');
    expect(normalizeName('fullName')).toBe('full name');
    expect(scoreNames('Full-Name', 'full name').score).toBe(1);
  });
});

describe('field values', () => {
  const row = { sourceRow: 2, values: { 'First Name': 'amina', 'Last Name': 'rahman', Joined: '2024-03-05', Serial: 42 } };

  it('fills templates with column placeholders', () => {
    const r = resolveText({ kind: 'template', template: 'Dr. {First Name} {Last Name}', transform: 'title' }, row);
    expect(r.value).toBe('Dr. Amina Rahman');
    expect(r.problems).toEqual([]);
  });

  it('reports unknown placeholders', () => {
    const r = resolveText({ kind: 'template', template: '{Nope}', transform: 'none' }, row);
    expect(r.problems[0]).toMatch(/Nope/);
  });

  it('formats dates from columns and today', () => {
    expect(resolveText({ kind: 'date', from: { column: 'Joined' }, format: 'Do MMMM YYYY', transform: 'none' }, row).value).toBe('5th March 2024');
    expect(resolveText({ kind: 'date', from: 'today', format: 'YYYY-MM-DD', transform: 'none' }, null, new Date(2025, 0, 9)).value).toBe('2025-01-09');
    expect(formatDate(new Date(Date.UTC(2024, 10, 22)), '[Issued] D MMM YY')).toBe('Issued 22 Nov 24');
    expect(cellToDate(45000)?.toISOString().slice(0, 10)).toBe('2023-03-15');
  });

  it('applies transforms including Bengali digits', () => {
    expect(applyTransform('ID 2024', 'bengali-digits')).toBe('ID ২০২৪');
    expect(applyTransform('  a   b ', 'trim')).toBe('a b');
    expect(resolveText({ kind: 'column', column: 'Serial', transform: 'none' }, row).value).toBe('42');
  });
});

async function makeXlsx(sheets: Record<string, string[][]>): Promise<Uint8Array> {
  const zip = new JSZip();
  const names = Object.keys(sheets);
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
      .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}</Relationships>`,
  );
  names.forEach((n, i) => {
    const rows = sheets[n]!.map(
      (r, ri) =>
        `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${String.fromCharCode(65 + ci)}${ri + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`,
    ).join('');
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: 'uint8array' });
}
