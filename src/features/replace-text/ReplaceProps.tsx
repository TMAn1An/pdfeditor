import { useMemo } from 'react';
import { AlertTriangle, AlignCenter, AlignLeft, AlignRight, Replace } from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import type { FontRef, ReplaceField, TemplateField } from '../../types/project';
import { IssueList, Labeled, NumberInput, Segmented } from '../../components/ui';
import { STANDARD_FONTS } from '../../lib/fonts/standard';
import { planRow } from '../../lib/render/plan';
import { OriginalProperties } from './OriginalProperties';

/** Settings for a true-replacement field. */
export function ReplaceProps({ field, set }: { field: ReplaceField; set: (f: TemplateField, key: string) => void }) {
  const ws = useWorkspace();
  const project = ws.project!;
  const s = field.style;
  const style = (patch: Partial<ReplaceField['style']>, key: string) => set({ ...field, style: { ...s, ...patch } }, key);
  const joined = field.targets.map((t) => t.text).join('');
  const before = joined.slice(0, field.selection.start);
  const after = joined.slice(field.selection.end);

  // Live check of the sample value (or the current data row) with the real engine.
  const checks = useMemo(() => {
    if (!ws.fontsReady) return [];
    const row = ws.sheet?.rows[ws.currentRow] ?? null;
    const plan = planRow({ project, fonts: ws.fonts, images: ws.imageResolver, textIndex: ws.textIndex }, row, row ? ws.currentRow : null);
    const mine = plan.issues.filter((i) => i.fieldId === field.id);
    const r = plan.replacements.find((x) => x.field.id === field.id);
    if (r && !r.blocked && mine.every((i) => i.severity !== 'error')) {
      mine.unshift({
        code: 'replace-font',
        severity: 'info',
        message:
          r.mode === 'in-place'
            ? `Uses the original font (${field.original.fontName}); the text object is edited in place.`
            : `The original text object is removed and the value is drawn in the replacement font.`,
      });
    }
    return mine;
  }, [project, ws.fonts, ws.fontsReady, ws.imageResolver, ws.textIndex, ws.sheet, ws.currentRow, field.id, field.original.fontName]);

  const fontOptions = (
    <>
      <optgroup label="Your fonts (you are responsible for the font licence)">
        {project.fonts.map((f) => (
          <option key={f.id} value={`custom:${f.id}`} disabled={!ws.fontBytes.has(f.id)}>
            {f.name}
            {ws.fontBytes.has(f.id) ? '' : ' (not loaded)'}
          </option>
        ))}
      </optgroup>
      <optgroup label="Standard PDF fonts — not embedded, provided by PDF viewers (Latin only)">
        {STANDARD_FONTS.map((f) => (
          <option key={f.id} value={`std:${f.id}`}>
            {f.label}
          </option>
        ))}
      </optgroup>
    </>
  );

  return (
    <>
      <p className="badge badge-replace">
        <Replace size={12} aria-hidden /> True text replacement
      </p>
      <p className="hint">The original PDF text object is changed or removed — nothing is painted over it.</p>
      <p className="small">
        Original: <span className="muted">{before}</span>
        <mark>{joined.slice(field.selection.start, field.selection.end)}</mark>
        <span className="muted">{after}</span>
      </p>
      <Labeled label="Text shown in the editor and preview" hint="Double-click the field on the page to type directly. Data rows replace it on export.">
        {(id) => <textarea id={id} rows={2} value={field.sampleValue} onChange={(e) => set({ ...field, sampleValue: e.target.value }, 'sample')} />}
      </Labeled>
      <IssueList issues={checks} />

      <fieldset className="group">
        <legend>Font</legend>
        {field.original.reuseBlocker && (
          <p className="callout callout-warning">
            <AlertTriangle size={16} aria-hidden /> Original font “{field.original.fontName}” cannot be reused: {field.original.reuseBlocker}
          </p>
        )}
        <Labeled label="Which font to use">
          {(id) => (
            <select id={id} value={s.fontMode} onChange={(e) => style({ fontMode: e.target.value as ReplaceField['style']['fontMode'] }, 'mode')}>
              <option value="auto" disabled={!!field.original.reuseBlocker}>
                Original font when possible, otherwise the replacement font
              </option>
              <option value="original" disabled={!!field.original.reuseBlocker}>
                Original font only (rows it cannot draw fail)
              </option>
              <option value="replacement">Always the replacement font</option>
            </select>
          )}
        </Labeled>
        {s.fontMode !== 'original' && (
          <>
            <Labeled label="Replacement font" hint="Upload a font you are licensed to embed, or use a standard PDF font.">
              {(id) => (
                <select
                  id={id}
                  value={s.replacementFont ?? ''}
                  onChange={(e) => style({ replacementFont: (e.target.value || null) as FontRef | null }, 'rfont')}
                >
                  <option value="">— Choose a font —</option>
                  {fontOptions}
                </select>
              )}
            </Labeled>
            <Labeled label="Fallback font" hint="For characters the replacement font lacks.">
              {(id) => (
                <select id={id} value={s.fallbackFont ?? ''} onChange={(e) => style({ fallbackFont: (e.target.value || null) as FontRef | null }, 'ffont')}>
                  <option value="">None</option>
                  {fontOptions}
                </select>
              )}
            </Labeled>
            <button type="button" className="link-btn" onClick={() => ws.setDialog('fonts')}>
              Add a font (.ttf / .otf)…
            </button>
          </>
        )}
      </fieldset>

      <fieldset className="group">
        <legend>Fit and alignment</legend>
        <div className="labeled">
          <span className="label">Alignment (relative to the original text)</span>
          <Segmented
            label="Alignment"
            value={s.align}
            onChange={(v) => style({ align: v }, 'align')}
            options={[
              { value: 'left', label: <AlignLeft size={16} />, title: 'Keep the start of the text' },
              { value: 'center', label: <AlignCenter size={16} />, title: 'Keep the centre of the text' },
              { value: 'right', label: <AlignRight size={16} />, title: 'Keep the end of the text' },
            ]}
          />
        </div>
        <Labeled label="If the new text is longer than the box">
          {(id) => (
            <select id={id} value={s.fit} onChange={(e) => style({ fit: e.target.value as ReplaceField['style']['fit'] }, 'fit')}>
              <option value="shrink">Shrink to fit</option>
              <option value="overflow">Keep the size (warn when it does not fit)</option>
            </select>
          )}
        </Labeled>
        {s.fit === 'shrink' && (
          <Labeled label="Smallest size (% of original)">
            {(id) => <NumberInput id={id} value={Math.round(s.minScale * 100)} min={30} max={100} onChange={(n) => style({ minScale: n / 100 }, 'min')} />}
          </Labeled>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={s.fontSizeOverride !== null}
            onChange={(e) => style({ fontSizeOverride: e.target.checked ? Math.round(field.original.effectiveSize * 10) / 10 : null }, 'size-on')}
          />
          Set the size manually
        </label>
        {s.fontSizeOverride !== null && (
          <Labeled label="Size (pt)">
            {(id) => (
              <NumberInput id={id} value={s.fontSizeOverride ?? 0} min={1} max={400} step={0.5} onChange={(n) => style({ fontSizeOverride: n }, 'size')} />
            )}
          </Labeled>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={s.colorOverride !== null}
            onChange={(e) => style({ colorOverride: e.target.checked ? field.original.color : null }, 'color-on')}
          />
          Change the colour
        </label>
        {s.colorOverride !== null && (
          <input type="color" aria-label="Text colour" value={s.colorOverride} onChange={(e) => style({ colorOverride: e.target.value }, 'color')} />
        )}
        <p className="hint">
          The dashed box on the page is the width the new text may use. Drag its side handles to change it. The text stays on the original baseline.
        </p>
      </fieldset>

      <details className="group-details">
        <summary>Detected properties of the original text</summary>
        <OriginalProperties info={field.original} />
      </details>
    </>
  );
}
