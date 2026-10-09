// Generates the synthetic sample files in public/samples.
// Everything here is made up: names, numbers and "photos" (geometric placeholders).
// Run with: npm run samples
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = path.resolve('public/samples');
mkdirSync(path.join(OUT, 'photos'), { recursive: true });

const W = 842;
const H = 595;

// ---------------------------------------------------------------- template PDF
const doc = await PDFDocument.create();
doc.setTitle('Sample certificate template');
doc.setCreator('PDF Template Studio sample generator');
const page = doc.addPage([W, H]);
const times = await doc.embedFont(StandardFonts.TimesRomanBold);
const helv = await doc.embedFont(StandardFonts.Helvetica);
const navy = rgb(0.12, 0.2, 0.42);
const grey = rgb(0.45, 0.48, 0.55);
// display (top-left) → pdf (bottom-left)
const Y = (top, h = 0) => H - top - h;
const centerText = (text, font, size, top, cx = W / 2, color = navy) => {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - w / 2, y: Y(top), size, font, color });
};

page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderColor: navy, borderWidth: 3 });
page.drawRectangle({ x: 32, y: 32, width: W - 64, height: H - 64, borderColor: rgb(0.7, 0.62, 0.35), borderWidth: 1 });
centerText('Certificate of Completion', times, 34, 95);
centerText('This certifies that', helv, 14, 150, 375, grey);
page.drawLine({ start: { x: 150, y: Y(215) }, end: { x: 600, y: Y(215) }, thickness: 0.8, color: grey });
centerText('has successfully completed the course', helv, 14, 248, 375, grey);
page.drawLine({ start: { x: 150, y: Y(300) }, end: { x: 600, y: Y(300) }, thickness: 0.8, color: grey });
page.drawText('Completed on:', { x: 150, y: Y(360), size: 12, font: helv, color: grey });
page.drawText('Certificate No:', { x: 150, y: Y(395), size: 12, font: helv, color: grey });
// Photo box
page.drawRectangle({ x: 640, y: Y(150, 160), width: 130, height: 160, borderColor: grey, borderWidth: 1 });
centerText('Photo', helv, 10, 326, 705, grey);
// Signature
page.drawLine({ start: { x: 600, y: Y(470) }, end: { x: 770, y: Y(470) }, thickness: 0.8, color: grey });
centerText('Authorized signature', helv, 10, 488, 685, grey);
centerText('Synthetic sample template — PDF Template Studio', helv, 8, 548, W / 2, grey);
const pdfBytes = await doc.save();
writeFileSync(path.join(OUT, 'certificate-template.pdf'), pdfBytes);

// ---------------------------------------------------------------- data
const rows = [
  ['Full Name', 'Course', 'Certificate No', 'Completion Date', 'Photo'],
  ['Amina Rahman', 'Introduction to Data Analysis', 'C-2024-001', '2024-03-15', 'photos/amina.png'],
  ['Rafi Chowdhury', 'Web Accessibility Basics', 'C-2024-002', '2024-03-15', 'photos/rafi.png'],
  ['Maria López', 'Project Management Essentials', 'C-2024-003', '2024-04-02', 'Maria.PNG'],
  ['Kenji Sato', 'An Unusually Long Course Title That Will Need To Shrink To Fit The Line', 'C-2024-004', '2024-04-02', 'kenji'],
  ['তানভীর হাসান', 'Introduction to Data Analysis', 'C-2024-005', '2024-05-20', 'photos/tanvir.png'],
  ['Zara Ahmed', 'Web Accessibility Basics', 'C-2024-006', '2024-05-20', 'photos/zara.jpg'],
];
const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
writeFileSync(path.join(OUT, 'participants.csv'), csv);

// Minimal .xlsx with two worksheets (inline strings, no formulas).
async function xlsx(sheets) {
  const zip = new JSZip();
  const names = Object.keys(sheets);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i) => String.fromCharCode(65 + i);
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  );
  names.forEach((n, i) => {
    const data = sheets[n]
      .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`)
      .join('');
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`,
    );
  });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
writeFileSync(
  path.join(OUT, 'participants.xlsx'),
  await xlsx({
    Participants: rows,
    Notes: [['Note'], ['All names and numbers in this file are invented for testing.']],
  }),
);

// ---------------------------------------------------------------- placeholder "photos"
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const byte of td) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    const c = Buffer.alloc(4);
    c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const palette = { amina: [72, 120, 200], rafi: [40, 150, 110], maria: [200, 110, 60], kenji: [130, 90, 180], tanvir: [190, 70, 100] };
for (const [name, [r, g, b]] of Object.entries(palette)) {
  // 300×375 portrait: coloured background, lighter "head" circle and shoulders.
  const w = 300;
  const h = 375;
  const img = png(w, h, (x, y) => {
    const head = (x - 150) ** 2 + (y - 150) ** 2 < 70 ** 2;
    const body = (x - 150) ** 2 / 130 ** 2 + (y - 375) ** 2 / 140 ** 2 < 1;
    if (head || body) return [Math.min(255, r + 110), Math.min(255, g + 110), Math.min(255, b + 110)];
    return [r, g, b];
  });
  writeFileSync(path.join(OUT, 'photos', `${name}.png`), img);
}

// ---------------------------------------------------------------- project file
const nr = (x, top, w, h) => ({ x: x / W, y: top / H, w: w / W, h: h / H });
const text = (id, label, rect, style, sampleValue, required = false) => ({
  id,
  type: 'text',
  label,
  page: 1,
  rect,
  required,
  sampleValue,
  style: {
    font: 'std:Helvetica',
    fallbackFont: null,
    fontSize: 14,
    minFontSize: 6,
    lineHeight: 1.2,
    color: '#1f3369',
    align: 'center',
    verticalAlign: 'bottom',
    padding: 2,
    fit: 'shrink',
    rotation: 0,
    background: null,
    ...style,
  },
});
const project = {
  format: 'pdf-template-studio/project',
  version: 1,
  id: 'prj_samplecertificate',
  name: 'Sample certificate',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  pdf: {
    fileName: 'certificate-template.pdf',
    byteLength: pdfBytes.length,
    pageCount: 1,
    sha256: createHash('sha256').update(pdfBytes).digest('hex'),
    title: 'Sample certificate template',
    pages: [{ pageNumber: 1, box: { x0: 0, y0: 0, x1: W, y1: H }, rotation: 0, displayWidth: W, displayHeight: H }],
    hasAcroForm: false,
  },
  fields: [
    text('fld_sample_name', 'Full Name', nr(150, 172, 450, 40), { font: 'std:Times-Bold', fontSize: 28 }, 'Amina Rahman', true),
    text('fld_sample_course', 'Course', nr(150, 262, 450, 36), { fontSize: 16 }, 'Introduction to Data Analysis'),
    text(
      'fld_sample_date',
      'Completion Date',
      nr(240, 344, 200, 22),
      { fontSize: 12, align: 'left', verticalAlign: 'middle', color: '#000000' },
      '15 March 2024',
    ),
    text(
      'fld_sample_id',
      'Certificate No',
      nr(240, 379, 200, 22),
      { font: 'std:Courier', fontSize: 12, align: 'left', verticalAlign: 'middle', color: '#000000' },
      'C-2024-001',
    ),
    {
      id: 'fld_sample_photo',
      type: 'image',
      label: 'Photo',
      page: 1,
      rect: nr(642, 152, 126, 156),
      required: false,
      style: { fit: 'cover', background: null, horizontalAlign: 'center', verticalAlign: 'middle', rotation: 0 },
    },
  ],
  formFields: [],
  mapping: {
    fld_sample_name: { kind: 'column', column: 'Full Name', transform: 'trim' },
    fld_sample_course: { kind: 'column', column: 'Course', transform: 'none' },
    fld_sample_date: { kind: 'date', from: { column: 'Completion Date' }, format: 'D MMMM YYYY', transform: 'none' },
    fld_sample_id: { kind: 'column', column: 'Certificate No', transform: 'none' },
    fld_sample_photo: { kind: 'column', column: 'Photo', transform: 'none' },
  },
  knownColumns: rows[0],
  fonts: [],
  settings: {
    storePdfInBrowser: true,
    formFieldFont: 'std:Helvetica',
    imageColumn: 'Photo',
    exportDefaults: { fileNamePattern: '{Full Name} - certificate', formMode: 'flatten', zip: true },
  },
};
const bundle = new JSZip();
bundle.file('project.json', JSON.stringify(project, null, 2));
writeFileSync(path.join(OUT, 'certificate.pdftemplate'), await bundle.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
writeFileSync(
  path.join(OUT, 'README.txt'),
  'Synthetic sample files for PDF Template Studio. All names, numbers and pictures are invented.\n' +
    'Row 5 uses Bangla text: it is flagged until you add a Bangla font (e.g. Noto Sans Bengali) and set it as the font or fallback font of the "Full Name" field.\n' +
    'Row 6 refers to photos/zara.jpg, which is intentionally missing, to show the missing-image warning.\n',
);
console.log(`Sample files written to ${OUT}`);
