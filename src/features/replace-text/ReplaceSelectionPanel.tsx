import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Replace, X } from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import type { TextObjectInfo } from '../../lib/pdfium/textIndex';
import { suggestFieldLabel, type NeighbourText } from '../../lib/pdfium/labels';
import { createReplaceField } from '../template-editor/fieldFactory';
import { Labeled } from '../../components/ui';
import { OriginalProperties } from './OriginalProperties';

interface Props {
  page: number;
  indices: number[];
  onClear: () => void;
  onCreated: (fieldId: string) => void;
}

export function ReplaceSelectionPanel({ page, indices, onClear, onCreated }: Props) {
  const ws = useWorkspace();
  const project = ws.project!;
  const index = ws.textIndex!;
  const pageObjs = index.page(page);
  const objects = useMemo(() => {
    const list = indices.map((i) => pageObjs.objects.find((o) => o.index === i)).filter((o): o is TextObjectInfo => !!o);
    // Reading order along the first object's baseline.
    const m = list[0]?.matrix;
    if (!m) return list;
    const len = Math.hypot(m[0], m[1]) || 1;
    return [...list].sort(
      (a, b) => ((a.matrix[4] - m[4]) * m[0] + (a.matrix[5] - m[5]) * m[1]) / len - ((b.matrix[4] - m[4]) * m[0] + (b.matrix[5] - m[5]) * m[1]) / len,
    );
  }, [indices, pageObjs]);
  const joined = objects.map((o) => o.text).join('');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const sel = selection && selection.end <= joined.length ? selection : { start: 0, end: joined.length };
  const input = useRef<HTMLInputElement>(null);
  const first = objects[0];

  const neighbours: NeighbourText[] = useMemo(() => {
    if (!first) return [];
    const m = first.matrix;
    return pageObjs.objects
      .filter((o) => !indices.includes(o.index))
      .map((o) => {
        const dx = (o.matrix[4] - m[4]) * Math.cos((first.rotation * Math.PI) / 180) + (o.matrix[5] - m[5]) * Math.sin((first.rotation * Math.PI) / 180);
        const dy = o.matrix[5] - m[5];
        return { text: o.text, dx, dy };
      });
  }, [first, pageObjs, indices]);
  const suggested = suggestFieldLabel(joined, sel, neighbours);
  const [label, setLabel] = useState<string | null>(null);

  if (!first) return null;
  const unsupported = objects.find((o) => o.unsupported);
  const usedBy = project.fields.find((f) => f.type === 'replace' && f.targets.some((t) => t.page === page && indices.includes(t.objectIndex)));
  const sameFont = objects.every((o) => o.fontName === first.fontName);
  const available = index.availableChars(page, first.index);

  const create = () => {
    const field = createReplaceField(project, objects, sel, label ?? suggested, pageObjs.info, available);
    ws.update((p) => ({ ...p, fields: [...p.fields, field] }));
    onCreated(field.id);
  };

  return (
    <div className="props">
      <div className="props-head">
        <h2 className="panel-title">Selected PDF text</h2>
        <button type="button" className="icon-btn" aria-label="Clear selection" onClick={onClear}>
          <X size={16} />
        </button>
      </div>
      <p className="run-text">“{joined}”</p>
      {objects.length > 1 && <p className="hint">{objects.length} text objects selected; they will be replaced as one piece of text.</p>}

      {unsupported ? (
        <p className="callout callout-error" role="alert">
          <AlertTriangle size={16} aria-hidden /> This text cannot be replaced. {unsupported.unsupported}
        </p>
      ) : usedBy ? (
        <p className="callout callout-warning">This text is already used by the field “{usedBy.label}”.</p>
      ) : first.reuseBlocker ? (
        <p className="callout callout-warning">
          <AlertTriangle size={16} aria-hidden /> The original font cannot be reused: {first.reuseBlocker} You will choose a replacement font for this field.
          The original text will still be removed, not covered.
        </p>
      ) : first.subset ? (
        <p className="callout callout-info">
          <Info size={16} aria-hidden /> The original font is embedded as a <strong>subset</strong>: it only contains the characters used in this PDF. Values
          using only those characters keep the original font; for other values you can choose a replacement font.
        </p>
      ) : (
        <p className="callout callout-info">
          <CheckCircle2 size={16} aria-hidden /> The original font can be reused.
        </p>
      )}
      {!sameFont && (
        <p className="callout callout-warning">The selected parts use different fonts; the first part's font ({first.fontName}) is used for the whole text.</p>
      )}

      <OriginalProperties
        info={{
          fontName: first.fontName,
          embedded: first.embedded,
          subset: first.subset,
          standardFont: first.standardFont,
          effectiveSize: first.effectiveSize,
          color: first.color,
          rotation: first.rotation,
          matrix: first.matrix,
          bounds: first.bounds,
          availableChars: available,
          renderMode: first.renderMode,
        }}
      />

      {!unsupported && !usedBy && (
        <>
          <Labeled label="Part to replace" hint="Select part of the text and press “Use selected part”, or keep the whole text.">
            {(id) => <input id={id} ref={input} type="text" readOnly value={joined} />}
          </Labeled>
          <div className="row-gap wrap">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                const el = input.current;
                if (!el) return;
                const start = el.selectionStart ?? 0;
                const end = el.selectionEnd ?? joined.length;
                if (end > start) setSelection({ start, end });
              }}
            >
              Use selected part
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setSelection(null)}>
              Whole text
            </button>
          </div>
          <p className="small">
            Replacing: <mark>{joined.slice(sel.start, sel.end)}</mark>
            {(sel.start > 0 || sel.end < joined.length) && (
              <span className="muted">
                {' '}
                (kept: “{joined.slice(0, sel.start)}” … “{joined.slice(sel.end)}”)
              </span>
            )}
          </p>
          <Labeled label="Data field name" hint="Becomes the suggested spreadsheet column header.">
            {(id) => <input id={id} type="text" value={label ?? suggested} maxLength={200} onChange={(e) => setLabel(e.target.value)} />}
          </Labeled>
          <button type="button" className="btn btn-primary" onClick={create}>
            <Replace size={16} /> Create replacement field
          </button>
        </>
      )}
    </div>
  );
}
