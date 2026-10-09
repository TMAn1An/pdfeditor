# PDF Template Studio

A local-first PDF template editor and bulk PDF generator that runs entirely in
your browser.

1. Open a PDF and draw **text** and **image** fields on it.
2. Load an **Excel (.xlsx) or CSV** file and match columns to fields.
3. Pick the **photo files** your spreadsheet refers to.
4. **Preview** each row, then download one PDF per row or everything as a **ZIP**.

**Privacy:** there is no server, no account, no analytics and no tracking. PDFs,
spreadsheets, photos and fonts are read with the browser's File API and never
uploaded. The production build ships a Content-Security-Policy that blocks
network requests to other origins.

---

## Quick start

Requirements: **Node.js 22.13 or newer** and npm.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173). Click **Try the
sample** on the start screen for a ready-made certificate template with
synthetic data.

### Other commands

| Command             | What it does                                               |
| ------------------- | ---------------------------------------------------------- |
| `npm run build`     | Type-check and build the static app into `dist/`           |
| `npm run preview`   | Serve the production build locally (http://localhost:4173) |
| `npm run lint`      | ESLint                                                     |
| `npm run typecheck` | TypeScript type check                                      |
| `npm test`          | Unit and integration tests (Vitest)                        |
| `npm run check`     | All of the above in sequence                               |
| `npm run samples`   | Regenerate the synthetic files in `public/samples/`        |

The `dist/` folder is a static site. Host it on any static file server, or
open it with `npm run preview`. (Opening `dist/index.html` straight from disk
with `file://` does not work because browsers block Web Workers there.)

---

## What works

### Template design

- Multi-page PDF viewer (PDF.js) with page thumbnails, page navigation, zoom
  in/out, fit-to-width, fit-to-page and view rotation. Pages are rendered
  lazily and re-rendered sharply after zooming.
- A transparent interaction layer above each page. Fields are stored in
  **normalized page coordinates (0–1)** and converted to PDF points only when
  exporting, so they stay in place at every zoom level, rotation and screen
  size, including pages with a `/Rotate` entry or an offset crop box.
- **Text fields:** draw, move, resize, duplicate, delete, rename; font (built-in
  or uploaded), fallback font, size, minimum size, colour, horizontal and
  vertical alignment, padding, line spacing, rotation (90° steps), background
  colour or transparent, required/optional, sample value. Fit modes:
  _shrink to fit_, _wrap and shrink_, _wrap_, _clip_, _overflow_.
- **Image fields:** draw, move, resize, duplicate, delete, rename; fit
  _contain_ (default, keeps aspect ratio), _cover/crop_, _stretch_; alignment;
  rotation; background colour; a test image.
- Undo/redo for creating, moving, resizing, deleting and changing fields.
  Keyboard shortcuts (when not typing in a box): `V` select, `T` text tool,
  `I` image tool, arrows nudge (Shift = 10 pt), `Delete`, `Ctrl+D` duplicate,
  `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) undo/redo, `Ctrl+S` save, `Esc`.
- Field outlines and labels are only shown in the editor, never in output.

### Existing PDF content

- **Existing AcroForm fields** (text, checkbox, radio, dropdown, list) are
  detected and listed separately. Fillable ones can be matched to data like
  any other field. Read-only, signature and button fields are shown but not
  filled.
- **PDF text inspection:** the “PDF text” tool shows the text PDF.js can read.
  Click a text run to create a field at its position (adjustable afterwards).
- **Scanned / image-only pages** are detected and labelled.
- The four kinds of objects are visually distinct: your fields (blue/green
  solid outline), existing form fields (purple dashed), extracted text
  (yellow), OCR text (teal) and suggestions (orange dashed).
- **Replace text (true text replacement).** Click existing PDF text with the
  “Replace text” tool (`R`) to see its font, embedded/subset state, size,
  colour, position, rotation and bounds. Select the whole text or only part of
  it (e.g. the name after “Name:”) and create a reusable data field. On export
  the original PDF text object itself is changed — nothing is painted over it:
  - **Original font reused** when it is embedded and has every glyph the new
    value needs: PDFium rewrites the text object in place, keeping its font,
    size, colour, matrix (rotation included) and drawing order.
  - **Replacement font** when the original cannot be reused (subset font
    missing characters, non-embedded non-standard font, Type 3 font, or a
    script that needs shaping such as Bangla): the original object is removed
    and the value is drawn at the same position, size, rotation and colour in a
    font you uploaded (or a standard PDF font, labelled as not embedded). The
    reason is always shown; fonts are never downloaded automatically.
  - Every change is verified by reading the text back; if PDFium could not
    encode a character the row fails with an error instead of exporting wrong
    text.
  - Values that are too wide are shrunk to fit (down to a minimum you choose)
    or a manual size is used; anything still too wide is reported as a
    warning. Alignment (left/centre/right along the baseline) is kept.
  - Double-click a replace field to type a sample value directly; “Show
    result” renders the real edited PDF in the editor.
  - **Unsupported (shown, never patched):** text inside Form XObjects,
    invisible text (OCR layers, render mode 3/7), encrypted PDFs, and scanned
    pages — those have no text objects to edit and would need OCR plus image
    reconstruction, which this app does not attempt.
- **Cover-up patch (not true replacement)**, the older tool, still exists for
  scanned pages: it covers a region with a patch in the sampled background
  colour and writes new text on top. It warns that the original text remains
  in the file and that patterned backgrounds will show the patch.

### Data and mapping

- `.xlsx` (worksheet choice) and `.csv` (UTF-8 with or without BOM, UTF-16,
  Windows-1252 fallback). Header row can be changed.
- Data checks: missing headers, duplicate headers, empty columns, blank values,
  malformed rows (unclosed quotes, wrong cell counts), skipped empty rows.
- Mapping suggestions using normalized names and synonyms (e.g. _Full Name_ ↔
  _Participant Name_, _Certificate ID_ ↔ _Serial Number_, _Photo_ ↔ _Image_).
  Suggestions are only applied when you click them; if several columns are
  plausible, the app lists them instead of choosing one.
- Value sources per field: a column (with optional date formatting), fixed
  text, text with `{Column}` placeholders, a date (today or from a column),
  or — for image fields — the same image for every row. Text transforms: trim,
  UPPER, lower, Title Case, Bangla digits.
- One column can fill several fields. Unmapped required fields and unused
  columns are flagged.

### Images

- Select multiple image files or a whole folder.
- Spreadsheet values like `photos/amina.jpg`, `C:\pics\amina.jpg` or just
  `amina` are matched by file name (case-insensitive, extension optional,
  folder names used to break ties). Values are **only lookup keys** among the
  files you selected: `..`, drive letters, URL schemes and absolute paths are
  stripped, and nothing outside your selection can ever be read.
- Shows matched, missing, ambiguous (duplicate names), unsupported and damaged
  files; manual matching per value; thumbnails per row.
- JPEG and PNG are embedded directly. WebP is converted to PNG in the browser.
  JPEG camera rotation (EXIF orientation) is applied.
- Warnings for images that will be enlarged (low resolution) and for aspect
  ratios that will be cropped, distorted or letterboxed.

### Preview and export

- The preview **is** the export: the real PDF for the selected row is
  generated and rendered. Previous/next row, jump to row.
- Validation per row: required value missing, text too long, image missing or
  ambiguous, aspect-ratio mismatch, low resolution, field outside the page,
  characters the font cannot draw, invalid form values.
- Export the current row, selected rows, or all ready rows. Safe, unique file
  names from a pattern such as `{Full Name} - certificate`. Progress,
  created/failed counts, per-row errors, open/download for each result, ZIP of
  all successful files (with a report when something failed). A failing row
  never stops the job, and the source PDF is never modified.
- Choose whether output form fields are **flattened** or **kept editable**.

### Fonts and international text

- Upload `.ttf` / `.otf` fonts; choose a font and a fallback font per field.
- Text in uploaded fonts is shaped with **HarfBuzz** (WebAssembly), so Bangla
  conjuncts, reordered vowel signs and mark positioning follow the font's
  OpenType rules. Tested with Noto Sans Bengali (see `tests/generate.test.ts`).
- Characters missing from both the font and its fallback are reported and the
  row is not exported — the app never silently draws empty boxes.
- The Fonts dialog shows which characters of a test text each font can draw.

### Saving

- Projects (field layout, mapping, settings, column names, fonts and — unless
  turned off — the template PDF) are saved automatically in this browser's
  IndexedDB, with a visible _Saved / Unsaved changes / Not saved_ status.
- The last project reopens after a page refresh. Storage-full errors are shown
  with a suggestion to export the project file.
- **Export/import project file** (`.pdftemplate`, a ZIP with `project.json`,
  the PDF and fonts). The format is versioned, migrated when older, and every
  value is validated on import. Project files and spreadsheets are treated as
  data only; nothing in them is executed.
- “Clear local project data” removes everything the app stored.

### Optional extras

- **Suggest fields:** finds fill-in lines (`_____`), placeholders (`[Name]`,
  `{{name}}`, `<<Name>>`), empty photo-shaped boxes and image objects. Each
  suggestion must be accepted or rejected.
- **OCR for scanned pages** with Tesseract.js, running locally in a worker.
  You select the language file yourself (e.g. `eng.traineddata`,
  `ben.traineddata` from
  [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)); the app does
  not download it. OCR results are suggestions for placing fields only.

## Supported files

| Type              | Supported                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Templates         | PDF (up to 300 MB). Password-protected PDFs can be viewed after entering the password, but cannot be filled (pdf-lib cannot write encrypted PDFs).      |
| Data              | `.xlsx`, `.xlsm` (values only), `.csv`, `.tsv`/`.txt` with comma, semicolon or tab separators (auto-detected). Not `.xls`. Up to 20,000 rows and 50 MB. |
| Images            | JPEG, PNG, WebP (converted to PNG). Not GIF, BMP, TIFF, HEIC, SVG. Up to 40 MB each.                                                                    |
| Fonts             | TrueType `.ttf`, OpenType `.otf`. Not WOFF/WOFF2 or `.ttc` collections.                                                                                 |
| OCR language data | Tesseract 4+ `.traineddata` (LSTM).                                                                                                                     |

## Privacy behaviour

- Nothing is uploaded. All processing (rendering, parsing, shaping, PDF
  generation, ZIP creation, OCR) happens in the browser tab.
- The production build sets `connect-src 'self' blob: data:` in its
  Content-Security-Policy, so the page cannot send data to another origin.
- PDF.js support files and the OCR engine are served from the app itself;
  no CDN is used. Fonts and OCR language data are never downloaded by the app.
- Stored in IndexedDB: template layouts, column names, fonts, and the template
  PDF (can be turned off per project in _Privacy and storage_).
- Never stored: spreadsheet rows, photos, generated PDFs. OCR language data is
  kept in memory, and placed in IndexedDB only while an OCR run is in progress
  (removed afterwards).

## Known limitations

- **Not a general PDF text editor.** “Replace text” edits one text object (or
  a few on the same line) per field; it does not reflow paragraphs, and in-place
  edits cannot shape complex scripts (those use the replacement-font path).
  Subset fonts usually contain only the characters of the original text, so
  most new values need an uploaded replacement font. Text in Form XObjects,
  invisible OCR text and scanned pages are not supported (the cover-up patch is
  the only, clearly labelled, option there).
- The PDFium engine (≈4.6 MB WebAssembly, ≈2.2 MB compressed) is loaded once
  when a PDF is opened. It needs WebAssembly (all current browsers).
- **Complex scripts:** shaping uses HarfBuzz, but line breaking is by spaces and
  graphemes only (no dictionary-based breaking). Right-to-left text uses a
  simplified bidi algorithm (strong RTL/LTR runs, digits as LTR); explicit bidi
  controls and some mixed-direction punctuation cases may be ordered
  imperfectly. Vertical writing is not supported.
- Glyphs are placed individually after shaping. Text in the output is
  extractable, but copy/paste of Bangla conjuncts from the output PDF may not
  return the exact original characters.
- Uploaded fonts are embedded in full (not subset), so large fonts make large
  PDFs.
- **Editable output** (“Keep editable”) uses form-field appearances that PDF
  viewers may regenerate with their own fonts; complex scripts may not shape
  correctly there. Rotated text fields are always flattened.
- Text layout on the editing canvas is an approximation using browser fonts;
  the Preview step shows the exact output.
- Encrypted PDFs cannot be filled. Some unusual PDFs may render in PDF.js but
  fail to load in pdf-lib; the app shows the error instead of producing a file.
- Field suggestions and OCR are hints: they will miss fields in many layouts
  and OCR text often contains mistakes.
- `fixed-image` choices refer to images loaded in the current tab; they must be
  added again after reopening a project.
- Generated PDFs are kept in memory until downloaded; very large batches (many
  thousands of image-heavy PDFs) may need to be split.

## Project structure

```
src/
  app/                 App shell, workspace state, undo history, top bar, welcome screen
  components/          Small accessible UI pieces (modal, controls)
  features/
    pdf-viewer/        PDF.js page rendering + interaction layer
    template-editor/   Field layer, properties, sidebar, text tools, OCR dialog
    data-import/       Spreadsheet import step
    field-mapping/     Mapping table and suggestions UI
    images/            Image selection and matching step
    preview/           Preview step and background row validation
    export/            Export dialog
    fonts/             Fonts dialog
  lib/
    pdf/               Coordinates, PDF.js helpers, detection
    pdfium/            PDFium (WASM) text-object index, true replacement, label suggestions
    render/            Row planning/validation and PDF generation (pdf-lib)
    text/              Text layout and bidi/font runs
    fonts/             Standard fonts, HarfBuzz engine, uploads
    spreadsheet/       CSV/XLSX parsing and data checks
    mapping/           Suggestions and value resolution
    images/            Detection, fitting, matching, loading
    export/            File names, batch runner, ZIP
    storage/           Project format, bundle, IndexedDB
    ocr/               Tesseract.js wrapper
  types/               Data model
  styles/              CSS
tests/                 Vitest tests and fixtures
scripts/               Vite asset plugin, sample generator
public/samples/        Synthetic sample template, data and placeholder photos
```

## Tests

`npm test` runs Vitest in Node. The tests cover, among other things:

- normalized ↔ view ↔ PDF coordinates for all view and page rotations, checked
  against PDF.js's own viewport maths;
- exported text landing inside its field on rotated pages, on the right page;
- text fitting, wrapping and overflow warnings;
- CSV/XLSX parsing, header problems, and mapping suggestions;
- image filename matching, duplicates, missing files and path traversal;
- batch export continuing after a failing row; safe, unique file names;
- project validation, version migration and bundle round-trips;
- Bangla shaping with an uploaded font plus fallback font, and missing-glyph
  detection;
- AcroForm filling (flattened and interactive) and field suggestions.

## License

No license has been chosen for this project yet (`package.json` says
`UNLICENSED`). Third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
