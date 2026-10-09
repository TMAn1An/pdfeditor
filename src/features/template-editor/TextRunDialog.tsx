import { useRef, useState } from 'react';
import { AlertTriangle, Eye, Replace, Type } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Labeled, NumberInput } from '../../components/ui';
import { useWorkspace } from '../../app/workspace';
import type { ExtractedTextRun } from '../../lib/pdf/pdfjs';
import { closePdf, openPdf } from '../../lib/pdf/pdfjs';
import { guessStandardFont, STANDARD_FONTS } from '../../lib/fonts/standard';
import type { FontRef, NormRect, QuarterTurn, TextField } from '../../types/project';
import { createTextField } from './fieldFactory';
import { normPointToView } from '../../lib/pdf/coords';
import { planRow } from '../../lib/render/plan';
import { generateFilledPdf } from '../../lib/render/generate';

interface Props {
  run: ExtractedTextRun;
  getCanvas: () => HTMLCanvasElement | null;
  viewRotation: QuarterTurn;
  imageOnlyPage: boolean;
  onClose: () => void;
  onCreated: (fieldId: string) => void;
}

function padRect(r: NormRect, px: number, py: number): NormRect {
  return { x: Math.max(0, r.x - px), y: Math.max(0, r.y - py), w: Math.min(1, r.w + 2 * px), h: Math.min(1, r.h + 2 * py) };
}

/** Median colour of a thin ring just outside the rectangle on the rendered page. */
function sampleBackground(canvas: HTMLCanvasElement | null, rect: NormRect, rot: QuarterTurn): string {
  if (!canvas || canvas.width === 0) return '#ffffff';
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#ffffff';
  const W = canvas.width;
  const H = canvas.height;
  const samples: [number, number, number][] = [];
  const ring = 0.004;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push([rect.x + rect.w * t, rect.y - ring], [rect.x + rect.w * t, rect.y + rect.h + ring]);
    pts.push([rect.x - ring, rect.y + rect.h * t], [rect.x + rect.w + ring, rect.y + rect.h * t]);
  }
  for (const [nx, ny] of pts) {
    if (nx < 0 || ny < 0 || nx > 1 || ny > 1) continue;
    const v = normPointToView(nx, ny, W, H, rot);
    const d = ctx.getImageData(Math.min(W - 1, Math.max(0, Math.round(v.x))), Math.min(H - 1, Math.max(0, Math.round(v.y))), 1, 1).data;
    samples.push([d[0]!, d[1]!, d[2]!]);
  }
  if (samples.length === 0) return '#ffffff';
  const med = (i: 0 | 1 | 2) => {
    const s = samples.map((c) => c[i]).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  return `#${[med(0), med(1), med(2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** How uniform the surrounding colour is (0 = perfectly flat). */
function backgroundVariation(canvas: HTMLCanvasElement | null, rect: NormRect, rot: QuarterTurn): number {
  if (!canvas || canvas.width === 0) return 0;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  const vals: number[] = [];
  for (let i = 0; i <= 12; i++) {
    for (const ny of [rect.y - 0.004, rect.y + rect.h + 0.004]) {
      const nx = rect.x + (rect.w * i) / 12;
      if (nx < 0 || ny < 0 || nx > 1 || ny > 1) continue;
      const v = normPointToView(nx, ny, canvas.width, canvas.height, rot);
      const d = ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, Math.round(v.x))), Math.max(0, Math.min(canvas.height - 1, Math.round(v.y))), 1, 1).data;
      vals.push((d[0]! + d[1]! + d[2]!) / 3);
    }
  }
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
}

export function TextRunDialog({ run, getCanvas, viewRotation, imageOnlyPage, onClose, onCreated }: Props) {
  const ws = useWorkspace();
  const project = ws.project!;
  const [mode, setMode] = useState<'choose' | 'replace'>('choose');
  const [replacement, setReplacement] = useState(run.text);
  const guessed: FontRef = `std:${guessStandardFont(run.fontName, run.fontFamily)}`;
  const [font, setFont] = useState<FontRef>(guessed);
  const [size, setSize] = useState(Math.max(4, Math.round(run.fontSize * 2) / 2));
  const coverRect = padRect(run.rect, 0.002, 0.002);
  const [background, setBackground] = useState(() => sampleBackground(getCanvas(), coverRect, viewRotation));
  const variation = backgroundVariation(getCanvas(), coverRect, viewRotation);
  const [previewState, setPreview] = useState<{ key: string; status: 'busy' | 'done' | string } | null>(null);
  const previewCanvas = useRef<HTMLCanvasElement>(null);
  const inputsKey = JSON.stringify([replacement, font, size, background]);
  // A preview is only valid for the inputs it was made with.
  const preview: 'idle' | 'busy' | 'done' | string = previewState && previewState.key === inputsKey ? previewState.status : 'idle';

  const buildField = (): TextField =>
    createTextField(project, run.page, coverRect, `Replace “${run.text.slice(0, 20)}”`, {
      font,
      fontSize: size,
      minFontSize: Math.min(6, size),
      fit: 'shrink',
      padding: 0.5,
      verticalAlign: 'middle',
      background,
      color: '#000000',
    });

  const createPlainField = () => {
    const field = createTextField(project, run.page, padRect(run.rect, 0.004, 0.003), run.text.trim().slice(0, 30) || 'Text field', {
      font: guessed,
      fontSize: Math.max(4, Math.round(run.fontSize * 2) / 2),
    });
    field.sampleValue = run.text;
    ws.update((p) => ({ ...p, fields: [...p.fields, field] }));
    onCreated(field.id);
  };

  const addReplacement = () => {
    const field = { ...buildField(), sampleValue: replacement, replacement: { originalText: run.text } };
    ws.update((p) => ({ ...p, fields: [...p.fields, field], mapping: { ...p.mapping, [field.id]: { kind: 'fixed', value: replacement } } }));
    onCreated(field.id);
  };

  const runPreview = async () => {
    if (!ws.pdf || ws.pdf.exportBlocked) {
      setPreview({ key: inputsKey, status: ws.pdf?.exportBlocked ?? 'No PDF loaded.' });
      return;
    }
    const key = inputsKey;
    setPreview({ key, status: 'busy' });
    try {
      const field = { ...buildField(), sampleValue: replacement };
      const temp = { ...project, fields: [field], formFields: [], mapping: { [field.id]: { kind: 'fixed' as const, value: replacement } } };
      const plan = planRow({ project: temp, fonts: ws.fonts, images: ws.imageResolver }, null, null);
      const { bytes } = await generateFilledPdf({ templateBytes: ws.pdf.bytes, plan, formMode: 'interactive', formFieldFont: project.settings.formFieldFont, fontBytes: (id) => ws.fontBytes.get(id) });
      const doc = await openPdf(bytes);
      const page = await doc.getPage(run.page);
      const vp = page.getViewport({ scale: 3 });
      const full = document.createElement('canvas');
      full.width = vp.width;
      full.height = vp.height;
      await page.render({ canvas: full, viewport: vp }).promise;
      const area = padRect(run.rect, 0.05, 0.02);
      const sx = area.x * vp.width;
      const sy = area.y * vp.height;
      const sw = area.w * vp.width;
      const sh = area.h * vp.height;
      const c = previewCanvas.current!;
      c.width = sw;
      c.height = sh;
      c.getContext('2d')!.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
      full.width = 0;
      await closePdf(doc);
      const issues = plan.issues.filter((i) => i.severity !== 'info');
      setPreview({ key, status: issues.length ? issues.map((i) => i.message).join(' ') : 'done' });
    } catch (err) {
      setPreview({ key, status: `Preview failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <Modal
      open
      wide={mode === 'replace'}
      title={mode === 'choose' ? 'Text found in the PDF' : 'Best-effort text replacement'}
      onClose={onClose}
      footer={
        mode === 'choose' ? (
          <>
            <button type="button" className="btn" onClick={() => setMode('replace')}>
              <Replace size={16} /> Best-effort replace…
            </button>
            <button type="button" className="btn btn-primary" onClick={createPlainField}>
              <Type size={16} /> Create text field here
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setMode('choose')}>
              Back
            </button>
            <button type="button" className="btn" onClick={runPreview} disabled={preview === 'busy'}>
              <Eye size={16} /> {preview === 'busy' ? 'Rendering…' : 'Preview'}
            </button>
            <button type="button" className="btn btn-primary" onClick={addReplacement} disabled={preview === 'idle' || preview === 'busy'} title={preview === 'idle' ? 'Preview the result first' : undefined}>
              Add replacement
            </button>
          </>
        )
      }
    >
      <dl className="kv">
        <dt>Text</dt>
        <dd className="run-text">“{run.text}”</dd>
        <dt>Size</dt>
        <dd>about {run.fontSize} pt</dd>
        {run.source === 'ocr' ? (
          <>
            <dt>Source</dt>
            <dd>OCR, {Math.round(run.confidence ?? 0)}% confidence — the text may be wrong</dd>
          </>
        ) : (
          <>
            <dt>PDF font</dt>
            <dd>{run.fontFamily || run.fontName}</dd>
          </>
        )}
      </dl>
      {mode === 'choose' ? (
        <p className="hint">
          “Create text field here” places a new field on top of this text that you can fill from your data. The field box is only a starting point; adjust it afterwards.
        </p>
      ) : (
        <>
          <div className="callout callout-warning" role="note">
            <AlertTriangle size={16} aria-hidden />
            <div>
              <p>
                <strong>This is not real PDF text editing.</strong> The app paints a patch in the background colour over the old text and writes the new text on top.
              </p>
              <ul>
                <li>The original text stays inside the PDF: it can still be selected, copied, read by screen readers, or found by search.</li>
                <li>Patterned, photo or gradient backgrounds will show the patch.</li>
                <li>The PDF's embedded font cannot be reused; the closest standard font or one of your fonts is used instead.</li>
                <li>On scanned pages the “text” is part of an image, so only a cover-up patch is possible.</li>
              </ul>
            </div>
          </div>
          {imageOnlyPage && <p className="callout callout-error">This page looks scanned. Replacement will be a visible patch.</p>}
          {variation > 18 && <p className="callout callout-error">The area around this text is not a flat colour. The patch will probably be visible.</p>}
          <Labeled label="New text">{(id) => <input id={id} type="text" value={replacement} onChange={(e) => setReplacement(e.target.value)} />}</Labeled>
          <div className="grid-3">
            <Labeled label="Font">
              {(id) => (
                <select id={id} value={font} onChange={(e) => setFont(e.target.value as FontRef)}>
                  {STANDARD_FONTS.map((f) => (
                    <option key={f.id} value={`std:${f.id}`}>
                      {f.label}
                    </option>
                  ))}
                  {project.fonts
                    .filter((f) => ws.fontBytes.has(f.id))
                    .map((f) => (
                      <option key={f.id} value={`custom:${f.id}`}>
                        {f.name}
                      </option>
                    ))}
                </select>
              )}
            </Labeled>
            <Labeled label="Size (pt)">{(id) => <NumberInput id={id} value={size} min={2} max={200} step={0.5} onChange={setSize} />}</Labeled>
            <Labeled label="Patch colour" hint="Sampled from the page">
              {(id) => <input id={id} type="color" value={background} onChange={(e) => setBackground(e.target.value)} />}
            </Labeled>
          </div>
          <div className="replace-preview">
            <canvas ref={previewCanvas} aria-label="Preview of the replacement" hidden={preview === 'idle' || preview === 'busy'} />
            {preview === 'idle' && <p className="muted">Press Preview to see the result before adding it.</p>}
            {preview !== 'idle' && preview !== 'busy' && preview !== 'done' && <p className="callout callout-warning">{preview}</p>}
          </div>
        </>
      )}
    </Modal>
  );
}
