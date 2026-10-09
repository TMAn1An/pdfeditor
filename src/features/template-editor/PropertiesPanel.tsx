import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Copy, FoldVertical, ImagePlus, Link2, Trash2, X } from 'lucide-react';
import type { ImageField, PageInfo, TemplateField, TextField } from '../../types/project';
import { describeSource } from '../../lib/mapping/describe';
import { ReplaceProps } from '../replace-text/ReplaceProps';
import { useWorkspace } from '../../app/workspace';
import { Labeled, NumberInput, Segmented } from '../../components/ui';
import { STANDARD_FONTS } from '../../lib/fonts/standard';
import { loadImageFile } from '../../lib/images/load';
import { duplicateField, removeField, replaceField } from './fieldFactory';
import { FORM_PREFIX, formTarget } from '../../lib/render/plan';

export function PropertiesPanel() {
  const ws = useWorkspace();
  const { project, selectedId } = ws;
  if (!project) return null;

  if (selectedId?.startsWith(FORM_PREFIX)) {
    const name = selectedId.slice(FORM_PREFIX.length);
    const ff = project.formFields.find((f) => f.name === name);
    if (!ff) return null;
    return (
      <div className="props">
        <h2 className="panel-title">Existing form field</h2>
        <p className="badge badge-form">Part of the original PDF</p>
        <dl className="kv">
          <dt>Name</dt>
          <dd>{ff.name}</dd>
          <dt>Type</dt>
          <dd>{ff.kind}</dd>
          <dt>Pages</dt>
          <dd>{[...new Set(ff.widgets.map((w) => w.page))].join(', ')}</dd>
          {ff.options.length > 0 && (
            <>
              <dt>Options</dt>
              <dd>{ff.options.join(', ')}</dd>
            </>
          )}
          <dt>Filled from</dt>
          <dd>{describeSource(project.mapping[formTarget(ff.name)])}</dd>
        </dl>
        {ff.fillable ? (
          <p className="hint">
            This field belongs to the PDF itself. Match it to a column on the Data step to fill it. Its position and style come from the PDF and cannot be
            changed here.
          </p>
        ) : (
          <p className="hint">
            This app cannot fill this kind of field ({ff.readOnly ? 'read-only' : ff.kind}). You can draw a new text field on top of it instead.
          </p>
        )}
        <button type="button" className="btn" onClick={() => ws.setStep('data')}>
          <Link2 size={16} /> Match to data
        </button>
      </div>
    );
  }

  const field = project.fields.find((f) => f.id === selectedId);
  if (!field) {
    return (
      <div className="props props-empty">
        <h2 className="panel-title">Properties</h2>
        <p className="muted">Select a field to change its settings.</p>
        <ul className="help-list">
          <li>
            Choose <strong>Text</strong> or <strong>Image</strong> in the toolbar, then drag a box on the page.
          </li>
          <li>Drag a field to move it; drag its corner handles to resize.</li>
          <li>
            Keyboard: arrows move the selected field (Shift = bigger steps), <kbd>Delete</kbd> removes it, <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates,{' '}
            <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo/redo.
          </li>
        </ul>
      </div>
    );
  }

  const page = project.pdf?.pages[field.page - 1];
  const set = (next: TemplateField, key: string) => ws.update((p) => replaceField(p, next), `${field.id}:${key}`);

  return (
    <div className="props">
      <div className="props-head">
        <h2 className="panel-title">{field.type === 'text' ? 'Text field' : field.type === 'image' ? 'Image field' : 'Text replacement'}</h2>
        <div className="row-gap">
          {field.type !== 'replace' && (
            <button
              type="button"
              className="icon-btn"
              title="Duplicate (Ctrl+D)"
              aria-label="Duplicate field"
              onClick={() => {
                const copy = duplicateField(project, field);
                ws.update((p) => ({ ...p, fields: [...p.fields, copy] }));
                ws.setSelectedId(copy.id);
              }}
            >
              <Copy size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn danger"
            title="Delete (Delete key)"
            aria-label="Delete field"
            onClick={() => ws.update((p) => removeField(p, field.id))}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      {field.replacement && (
        <p className="callout callout-warning">
          Best-effort text replacement for “{field.replacement.originalText}”. The original text is covered, not removed: it can still be selected, copied or
          found by search in the output PDF.
        </p>
      )}

      <Labeled label="Field name">
        {(id) => <input id={id} type="text" value={field.label} maxLength={200} onChange={(e) => set({ ...field, label: e.target.value }, 'label')} />}
      </Labeled>
      <label className="check">
        <input type="checkbox" checked={field.required} onChange={(e) => set({ ...field, required: e.target.checked }, 'required')} />
        Required (rows without a value are not exported)
      </label>
      <p className="mapping-summary">
        Filled from: <strong>{describeSource(project.mapping[field.id])}</strong>{' '}
        <button type="button" className="link-btn" onClick={() => ws.setStep('data')}>
          Change
        </button>
      </p>

      {field.type === 'text' ? (
        <TextProps field={field} set={set} />
      ) : field.type === 'image' ? (
        <ImageProps field={field} set={set} />
      ) : (
        <ReplaceProps field={field} set={set} />
      )}

      {page && field.type !== 'replace' && <PositionProps field={field} page={page} pageCount={project.pdf?.pageCount ?? 1} set={set} />}
    </div>
  );
}

function TextProps({ field, set }: { field: TextField; set: (f: TemplateField, key: string) => void }) {
  const ws = useWorkspace();
  const s = field.style;
  const style = (patch: Partial<TextField['style']>, key: string) => set({ ...field, style: { ...s, ...patch } }, key);
  const customFonts = ws.project?.fonts ?? [];
  const fontOptions = (
    <>
      <optgroup label="Built-in PDF fonts (Latin only)">
        {STANDARD_FONTS.map((f) => (
          <option key={f.id} value={`std:${f.id}`}>
            {f.label}
          </option>
        ))}
      </optgroup>
      {customFonts.length > 0 && (
        <optgroup label="Your fonts">
          {customFonts.map((f) => (
            <option key={f.id} value={`custom:${f.id}`} disabled={!ws.fontBytes.has(f.id)}>
              {f.name}
              {ws.fontBytes.has(f.id) ? '' : ' (not loaded)'}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
  return (
    <>
      <Labeled label="Sample value" hint="Used on screen and in Preview when no data file is loaded.">
        {(id) => (
          <textarea id={id} rows={2} value={field.sampleValue} maxLength={5000} onChange={(e) => set({ ...field, sampleValue: e.target.value }, 'sample')} />
        )}
      </Labeled>
      <fieldset className="group">
        <legend>Font</legend>
        <Labeled label="Font">
          {(id) => (
            <select id={id} value={s.font} onChange={(e) => style({ font: e.target.value as TextField['style']['font'] }, 'font')}>
              {fontOptions}
            </select>
          )}
        </Labeled>
        <Labeled label="Fallback font" hint="Used for characters the main font does not have (e.g. Latin letters in a Bangla font).">
          {(id) => (
            <select
              id={id}
              value={s.fallbackFont ?? ''}
              onChange={(e) => style({ fallbackFont: (e.target.value || null) as TextField['style']['fallbackFont'] }, 'fallback')}
            >
              <option value="">None</option>
              {fontOptions}
            </select>
          )}
        </Labeled>
        <button type="button" className="link-btn" onClick={() => ws.setDialog('fonts')}>
          Add a font (.ttf / .otf)…
        </button>
        <div className="grid-2">
          <Labeled label="Size (pt)">
            {(id) => (
              <NumberInput
                id={id}
                value={s.fontSize}
                min={1}
                max={400}
                step={0.5}
                onChange={(n) => style({ fontSize: n, minFontSize: Math.min(s.minFontSize, n) }, 'size')}
              />
            )}
          </Labeled>
          <Labeled label="Color">{(id) => <input id={id} type="color" value={s.color} onChange={(e) => style({ color: e.target.value }, 'color')} />}</Labeled>
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>Layout</legend>
        <Labeled label="If the text is too long">
          {(id) => (
            <select id={id} value={s.fit} onChange={(e) => style({ fit: e.target.value as TextField['style']['fit'] }, 'fit')}>
              <option value="shrink">Shrink to fit (one line)</option>
              <option value="wrap-shrink">Wrap lines, shrink if needed</option>
              <option value="wrap">Wrap lines (cut off extra lines)</option>
              <option value="clip">Cut off at the edge (one line)</option>
              <option value="overflow">Let it run past the edge (one line)</option>
            </select>
          )}
        </Labeled>
        {(s.fit === 'shrink' || s.fit === 'wrap-shrink') && (
          <Labeled label="Smallest size (pt)">
            {(id) => <NumberInput id={id} value={s.minFontSize} min={1} max={s.fontSize} step={0.5} onChange={(n) => style({ minFontSize: n }, 'minsize')} />}
          </Labeled>
        )}
        {(s.fit === 'wrap' || s.fit === 'wrap-shrink') && (
          <Labeled label="Line spacing">
            {(id) => <NumberInput id={id} value={s.lineHeight} min={0.5} max={4} step={0.05} onChange={(n) => style({ lineHeight: n }, 'lh')} />}
          </Labeled>
        )}
        <div className="labeled">
          <span className="label">Horizontal alignment</span>
          <Segmented
            label="Horizontal alignment"
            value={s.align}
            onChange={(v) => style({ align: v }, 'align')}
            options={[
              { value: 'left', label: <AlignLeft size={16} />, title: 'Left' },
              { value: 'center', label: <AlignCenter size={16} />, title: 'Center' },
              { value: 'right', label: <AlignRight size={16} />, title: 'Right' },
            ]}
          />
        </div>
        <div className="labeled">
          <span className="label">Vertical alignment</span>
          <Segmented
            label="Vertical alignment"
            value={s.verticalAlign}
            onChange={(v) => style({ verticalAlign: v }, 'valign')}
            options={[
              { value: 'top', label: <ArrowUpToLine size={16} />, title: 'Top' },
              { value: 'middle', label: <FoldVertical size={16} />, title: 'Middle' },
              { value: 'bottom', label: <ArrowDownToLine size={16} />, title: 'Bottom' },
            ]}
          />
        </div>
        <div className="grid-2">
          <Labeled label="Padding (pt)">
            {(id) => <NumberInput id={id} value={s.padding} min={0} max={200} step={0.5} onChange={(n) => style({ padding: n }, 'pad')} />}
          </Labeled>
          <Labeled label="Rotation">
            {(id) => (
              <select id={id} value={s.rotation} onChange={(e) => style({ rotation: Number(e.target.value) as TextField['style']['rotation'] }, 'rot')}>
                <option value={0}>None</option>
                <option value={90}>90° clockwise</option>
                <option value={180}>180°</option>
                <option value={270}>90° counter-clockwise</option>
              </select>
            )}
          </Labeled>
        </div>
        <BackgroundControl value={s.background} onChange={(v) => style({ background: v }, 'bg')} />
      </fieldset>
    </>
  );
}

function ImageProps({ field, set }: { field: ImageField; set: (f: TemplateField, key: string) => void }) {
  const ws = useWorkspace();
  const s = field.style;
  const style = (patch: Partial<ImageField['style']>, key: string) => set({ ...field, style: { ...s, ...patch } }, key);
  const sample = ws.sampleImages[field.id];
  return (
    <>
      <div className="labeled">
        <span className="label">Test image</span>
        <div className="row-gap">
          <label className="btn btn-small">
            <ImagePlus size={16} /> Choose image…
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="visually-hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const asset = await loadImageFile(file);
                if (asset.error) ws.toast(`${file.name}: ${asset.error}`, 'error');
                else ws.setSampleImage(field.id, asset);
              }}
            />
          </label>
          {sample && (
            <button type="button" className="icon-btn" aria-label="Remove test image" onClick={() => ws.setSampleImage(field.id, null)}>
              <X size={16} />
            </button>
          )}
        </div>
        <p className="hint">
          {sample
            ? `${sample.name} — ${sample.width}×${sample.height}px. Not saved with the project.`
            : 'Try how a photo fits. It stays in this browser tab only.'}
        </p>
      </div>
      <fieldset className="group">
        <legend>Fit</legend>
        <Labeled label="How the image fills the box">
          {(id) => (
            <select id={id} value={s.fit} onChange={(e) => style({ fit: e.target.value as ImageField['style']['fit'] }, 'fit')}>
              <option value="contain">Fit inside, keep shape (recommended)</option>
              <option value="cover">Fill the box, crop edges</option>
              <option value="stretch">Stretch to fill (may distort)</option>
            </select>
          )}
        </Labeled>
        <div className="grid-2">
          <Labeled label="Horizontal">
            {(id) => (
              <select
                id={id}
                value={s.horizontalAlign}
                onChange={(e) => style({ horizontalAlign: e.target.value as ImageField['style']['horizontalAlign'] }, 'ha')}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            )}
          </Labeled>
          <Labeled label="Vertical">
            {(id) => (
              <select id={id} value={s.verticalAlign} onChange={(e) => style({ verticalAlign: e.target.value as ImageField['style']['verticalAlign'] }, 'va')}>
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </select>
            )}
          </Labeled>
        </div>
        <Labeled label="Rotation">
          {(id) => (
            <select id={id} value={s.rotation} onChange={(e) => style({ rotation: Number(e.target.value) as ImageField['style']['rotation'] }, 'rot')}>
              <option value={0}>None</option>
              <option value={90}>90° clockwise</option>
              <option value={180}>180°</option>
              <option value={270}>90° counter-clockwise</option>
            </select>
          )}
        </Labeled>
        <BackgroundControl value={s.background} onChange={(v) => style({ background: v }, 'bg')} />
      </fieldset>
    </>
  );
}

function BackgroundControl({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="labeled">
      <label className="check">
        <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? '#ffffff' : null)} />
        Background colour
      </label>
      {value !== null ? (
        <input type="color" value={value} aria-label="Background colour" onChange={(e) => onChange(e.target.value)} />
      ) : (
        <p className="hint">Transparent: the page shows through.</p>
      )}
    </div>
  );
}

function PositionProps({
  field,
  page,
  pageCount,
  set,
}: {
  field: TemplateField;
  page: PageInfo;
  pageCount: number;
  set: (f: TemplateField, key: string) => void;
}) {
  const W = page.displayWidth;
  const H = page.displayHeight;
  const r = field.rect;
  const setRect = (patch: Partial<{ x: number; y: number; w: number; h: number }>, key: string) =>
    set({ ...field, rect: { x: (patch.x ?? r.x * W) / W, y: (patch.y ?? r.y * H) / H, w: (patch.w ?? r.w * W) / W, h: (patch.h ?? r.h * H) / H } }, key);
  return (
    <fieldset className="group">
      <legend>Position (points from top-left)</legend>
      <div className="grid-2">
        <Labeled label="Left">{(id) => <NumberInput id={id} value={r.x * W} min={0} max={W} step={0.5} onChange={(n) => setRect({ x: n }, 'x')} />}</Labeled>
        <Labeled label="Top">{(id) => <NumberInput id={id} value={r.y * H} min={0} max={H} step={0.5} onChange={(n) => setRect({ y: n }, 'y')} />}</Labeled>
        <Labeled label="Width">{(id) => <NumberInput id={id} value={r.w * W} min={1} max={W} step={0.5} onChange={(n) => setRect({ w: n }, 'w')} />}</Labeled>
        <Labeled label="Height">{(id) => <NumberInput id={id} value={r.h * H} min={1} max={H} step={0.5} onChange={(n) => setRect({ h: n }, 'h')} />}</Labeled>
      </div>
      {pageCount > 1 && (
        <Labeled label="Page">
          {(id) => (
            <select id={id} value={field.page} onChange={(e) => set({ ...field, page: Number(e.target.value) }, 'page')}>
              {Array.from({ length: pageCount }, (_, i) => (
                <option key={i} value={i + 1}>
                  Page {i + 1}
                </option>
              ))}
            </select>
          )}
        </Labeled>
      )}
    </fieldset>
  );
}
