// Generates tests/fixtures/pdfs/form-xobject-certificate.pdf: a synthetic
// certificate whose structure deliberately matches the real-world Canva PDF
// that originally exposed the Form-XObject Replace Text limitation --
// without any real person's name or signature. ALL page content (including
// the "name" and "role" text) is drawn inside a single Form XObject that
// the page's own /Contents stream merely invokes via "/Fm0 Do", exactly
// like the real reported file. Run with: node scripts/gen-form-xobject-fixture.mjs
import { PDFDocument, PDFName } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontBytes = readFileSync(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf'));

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(fontBytes, { subset: true });
const ctx = doc.context;

const page = doc.addPage([842.25, 595.5]);

// Build the Form XObject's own content stream: background, "This certificate
// is proudly presented to", the fake name, and the fake role -- all of it,
// so the whole visible page lives inside this one form, just like the real
// file. pdf-lib's high-level drawText() only draws on the CURRENT page, so
// the form's content is hand-built with raw operators instead.
const fontKey = 'F1';
// This font is embedded as a CID (Identity-H, two bytes per glyph) font --
// `doc.embedFont(..., { subset: true })` always produces one for TrueType --
// so the Tj operand must be the font's own encoded glyph-index bytes
// (font.encodeText()), never a plain ASCII string literal, which earlier
// produced CJK-garbled output when re-extracted with PDF.js.
const show = (s) => `${font.encodeText(s).toString()} Tj`;
const formOps = `
q
1 1 1 rg
0 0 842.25 595.5 re f
0 0 0 rg
BT
/${fontKey} 16 Tf
1 0 0 1 260 380 Tm
${show('This certificate is proudly presented to')}
ET
BT
/${fontKey} 32 Tf
1 0 0 1 260 320 Tm
${show('JANE DOE')}
ET
BT
/${fontKey} 14 Tf
1 0 0 1 600 260 Tm
${show('Test Role')}
ET
Q
`.trim();

const formStream = ctx.stream(formOps, {
  Type: 'XObject',
  Subtype: 'Form',
  FormType: 1,
  BBox: [0, 0, 842.25, 595.5],
  Resources: ctx.obj({ Font: ctx.obj({ [fontKey]: font.ref }) }),
});
const formRef = ctx.register(formStream);

// The page's own content stream does nothing but invoke the form -- the
// same shape as the real reported PDF (a page /Contents that is just
// "/X51 Do", with everything else nested inside that one XObject).
const pageContentStream = ctx.stream('q /Fm0 Do Q', { Length: 11 });
const pageContentRef = ctx.register(pageContentStream);
page.node.set(PDFName.of('Contents'), pageContentRef);
page.node.set(
  PDFName.of('Resources'),
  ctx.obj({ XObject: ctx.obj({ Fm0: formRef }) }),
);

const bytes = await doc.save();
writeFileSync(new URL('../tests/fixtures/pdfs/form-xobject-certificate.pdf', import.meta.url), bytes);
console.log('wrote', bytes.length, 'bytes');
