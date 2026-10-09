import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Image as ImageIcon, Replace, Type } from 'lucide-react';
import type { ExistingFormField, ImageField, NormRect, TemplateField, TextField } from '../../types/project';
import { clampRectToPage, contentFrameSize, rectFromPoints, resizeRect, type Point, type ResizeHandle } from '../../lib/pdf/coords';
import type { PageOverlayContext } from '../pdf-viewer/PdfViewer';
import type { ExtractedTextRun } from '../../lib/pdf/pdfjs';
import { layoutText } from '../../lib/text/layout';
import { canvasMeasure, cssFontFor } from '../../lib/fonts/css';
import type { ImageAsset } from '../../lib/images/load';

export type Tool = 'select' | 'text' | 'image' | 'inspect' | 'replace';

export interface Suggestion {
  id: string;
  page: number;
  rect: NormRect;
  type: 'text' | 'image';
  label: string;
  reason: string;
}

interface FieldLayerProps {
  ctx: PageOverlayContext;
  fields: TemplateField[];
  formFields: ExistingFormField[];
  textRuns: ExtractedTextRun[] | null;
  suggestions: Suggestion[];
  selectedId: string | null;
  tool: Tool;
  displayValue: (field: TextField) => string;
  sampleImage: (field: ImageField) => ImageAsset | null;
  onSelect: (id: string | null) => void;
  onCommitRect: (id: string, rect: NormRect) => void;
  onCreate: (type: 'text' | 'image', page: number, rect: NormRect) => void;
  onTextRun: (run: ExtractedTextRun) => void;
  onSuggestion: (s: Suggestion) => void;
  /** Commit text typed directly into a field. */
  onEditSample: (id: string, value: string) => void;
}

type Drag =
  | { mode: 'move'; id: string; start: Point; orig: NormRect; rect: NormRect; moved: boolean }
  | { mode: 'resize'; id: string; handle: ResizeHandle; start: Point; orig: NormRect; rect: NormRect }
  | { mode: 'create'; type: 'text' | 'image'; start: Point; rect: NormRect };

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
// Replacement boxes only change the available width; the text stays on its baseline.
const REPLACE_HANDLES: ResizeHandle[] = ['e', 'w'];

export const FieldLayer = memo(function FieldLayer(props: FieldLayerProps) {
  const { ctx, fields, formFields, textRuns, suggestions, selectedId, tool, onSelect, onCommitRect, onCreate } = props;
  const layer = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const { info } = ctx;
  const minW = 6 / info.displayWidth;
  const minH = 6 / info.displayHeight;

  const begin = (e: ReactPointerEvent, d: Drag) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Move keyboard focus off any text box so shortcuts (Delete, arrows) apply to the canvas.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active.closest('input, textarea, select')) active.blur();
    layer.current?.setPointerCapture(e.pointerId);
    setDrag(d);
  };

  const onLayerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (tool === 'text' || tool === 'image') {
      const p = ctx.toNorm(e.clientX, e.clientY);
      begin(e, { mode: 'create', type: tool, start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 } });
    } else if (e.target === layer.current) {
      onSelect(null);
    }
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = ctx.toNorm(e.clientX, e.clientY);
    if (drag.mode === 'create') {
      setDrag({ ...drag, rect: rectFromPoints(drag.start, p) });
    } else if (drag.mode === 'move') {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const moved = drag.moved || Math.abs(dx) * info.displayWidth > 2 || Math.abs(dy) * info.displayHeight > 2;
      setDrag({ ...drag, moved, rect: clampRectToPage({ ...drag.orig, x: drag.orig.x + dx, y: drag.orig.y + dy }) });
    } else {
      setDrag({ ...drag, rect: resizeRect(drag.orig, drag.handle, p.x - drag.start.x, p.y - drag.start.y, minW, minH) });
    }
  };

  const onUp = (e: ReactPointerEvent) => {
    if (!drag) return;
    layer.current?.releasePointerCapture(e.pointerId);
    const d = drag;
    setDrag(null);
    if (d.mode === 'create') {
      let rect = d.rect;
      const tiny = rect.w * info.displayWidth < 8 || rect.h * info.displayHeight < 8;
      if (tiny) {
        // A click without dragging: create a default-sized field at that spot.
        const w = (d.type === 'text' ? 180 : 90) / info.displayWidth;
        const h = (d.type === 'text' ? 24 : 110) / info.displayHeight;
        rect = clampRectToPage({ x: d.start.x, y: d.start.y - h / 2, w, h });
      }
      onCreate(d.type, ctx.pageNumber, rect);
    } else if (d.mode === 'move') {
      if (d.moved) onCommitRect(d.id, d.rect);
    } else {
      onCommitRect(d.id, d.rect);
    }
  };

  const liveRect = (f: TemplateField) => (drag && drag.mode !== 'create' && drag.id === f.id ? drag.rect : f.rect);
  const pageForms = useMemo(
    () => formFields.flatMap((ff) => ff.widgets.filter((w) => w.page === ctx.pageNumber).map((w, i) => ({ ff, w, key: `${ff.name}#${i}` }))),
    [formFields, ctx.pageNumber],
  );

  return (
    <div
      ref={layer}
      className={`field-layer tool-${tool}${ctx.scale < 0.7 ? ' compact' : ''}`}
      onPointerDown={onLayerDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDrag(null)}
    >
      {pageForms.map(({ ff, w, key }) => (
        <button
          key={key}
          type="button"
          className={`form-widget${selectedId === `form:${ff.name}` ? ' selected' : ''}${ff.fillable ? '' : ' not-fillable'}`}
          style={rectStyle(w.rect)}
          title={`Existing PDF form field: ${ff.name} (${ff.kind})`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onSelect(`form:${ff.name}`)}
          tabIndex={tool === 'select' ? 0 : -1}
        >
          <span className="widget-tag">Form: {ff.name}</span>
        </button>
      ))}

      {textRuns?.map((run) => (
        <button
          key={run.id}
          type="button"
          className={`text-run${run.source === 'ocr' ? ' text-run-ocr' : ''}`}
          style={rectStyle(run.rect)}
          title={
            run.source === 'ocr'
              ? `OCR text (${Math.round(run.confidence ?? 0)}% confidence): “${run.text}”. Click for options.`
              : `Extracted text: “${run.text}” (${run.fontSize}pt). Click for options.`
          }
          aria-label={`${run.source === 'ocr' ? 'OCR' : 'Extracted'} text ${run.text}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => props.onTextRun(run)}
        />
      ))}

      {suggestions.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`suggestion suggestion-${s.type}`}
          style={rectStyle(s.rect)}
          title={`Suggested ${s.type} field: ${s.reason}. Click to review.`}
          aria-label={`Suggested ${s.type} field ${s.label}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => props.onSuggestion(s)}
        >
          <span className="widget-tag">Suggestion</span>
        </button>
      ))}

      {fields.map((f) => {
        const rect = liveRect(f);
        const selected = selectedId === f.id;
        return (
          <div
            key={f.id}
            className={`field field-${f.type}${selected ? ' selected' : ''}${f.replacement ? ' field-replacement' : ''}${tool === 'replace' ? ' passive' : ''}`}
            style={rectStyle(rect)}
            onDoubleClick={() => {
              if (f.type !== 'image') setEditing({ id: f.id, value: f.sampleValue });
            }}
            onPointerDown={(e) => {
              if (editing?.id === f.id) return;
              if (tool !== 'select' && tool !== 'inspect') return;
              onSelect(f.id);
              if (f.type === 'replace') {
                e.stopPropagation(); // the original text cannot move; only the box width can change
                return;
              }
              begin(e, { mode: 'move', id: f.id, start: ctx.toNorm(e.clientX, e.clientY), orig: f.rect, rect: f.rect, moved: false });
            }}
          >
            <button
              type="button"
              className="field-tag"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onSelect(f.id)}
              aria-pressed={selected}
              aria-label={`${f.type === 'text' ? 'Text' : f.type === 'image' ? 'Image' : 'Replacement'} field ${f.label}${f.required ? ', required' : ''}`}
              onDoubleClick={() => {
                if (f.type !== 'image') setEditing({ id: f.id, value: f.sampleValue });
              }}
            >
              {f.type === 'text' ? (
                <Type size={11} aria-hidden />
              ) : f.type === 'image' ? (
                <ImageIcon size={11} aria-hidden />
              ) : (
                <Replace size={11} aria-hidden />
              )}
              {f.label}
              {f.required && <span aria-hidden> *</span>}
            </button>
            {f.type === 'text' ? (
              <TextSample field={f} value={props.displayValue(f)} scale={ctx.scale} pageW={info.displayWidth} pageH={info.displayHeight} rect={rect} />
            ) : f.type === 'image' ? (
              <ImageSample field={f} asset={props.sampleImage(f)} scale={ctx.scale} boxW={rect.w * info.displayWidth} boxH={rect.h * info.displayHeight} />
            ) : null}
            {editing?.id === f.id && (
              <textarea
                className="inline-edit"
                autoFocus
                aria-label={`Type the text for ${f.label}`}
                value={editing.value}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setEditing({ id: f.id, value: e.target.value })}
                onBlur={() => {
                  props.onEditSample(f.id, editing.value);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditing(null);
                  } else if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    (e.target as HTMLTextAreaElement).blur();
                  }
                }}
              />
            )}
            {selected &&
              (f.type === 'replace' ? REPLACE_HANDLES : HANDLES).map((h) => (
                <span
                  key={h}
                  className={`handle handle-${h}`}
                  aria-hidden="true"
                  onPointerDown={(e) => begin(e, { mode: 'resize', id: f.id, handle: h, start: ctx.toNorm(e.clientX, e.clientY), orig: f.rect, rect: f.rect })}
                />
              ))}
          </div>
        );
      })}

      {drag?.mode === 'create' && <div className={`draft draft-${drag.type}`} style={rectStyle(drag.rect)} />}
    </div>
  );
});

function rectStyle(r: NormRect) {
  return { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` };
}

/** Approximate on-screen rendering of a text field (exact output: Preview step). */
function TextSample({
  field,
  value,
  scale,
  pageW,
  pageH,
  rect,
}: {
  field: TextField;
  value: string;
  scale: number;
  pageW: number;
  pageH: number;
  rect: NormRect;
}) {
  const s = field.style;
  const boxW = rect.w * pageW;
  const boxH = rect.h * pageH;
  const content = contentFrameSize(s.rotation, boxW, boxH);
  const font = cssFontFor(s.font, s.fallbackFont);
  const layout = useMemo(() => {
    if (!value) return null;
    const measure = canvasMeasure(font);
    return layoutText(
      value,
      {
        width: Math.max(0, content.width - 2 * s.padding),
        height: Math.max(0, content.height - 2 * s.padding),
        fontSize: s.fontSize,
        minFontSize: s.minFontSize,
        lineHeight: s.lineHeight,
        fit: s.fit,
        align: s.align,
        verticalAlign: s.verticalAlign,
      },
      measure,
    );
  }, [value, font, content.width, content.height, s.padding, s.fontSize, s.minFontSize, s.lineHeight, s.fit, s.align, s.verticalAlign]);
  const cw = content.width * scale;
  const ch = content.height * scale;
  return (
    <div className="field-bg" style={{ background: s.background ?? undefined }}>
      <div
        className="text-sample"
        style={{
          width: cw,
          height: ch,
          left: (boxW * scale - cw) / 2,
          top: (boxH * scale - ch) / 2,
          transform: s.rotation ? `rotate(${s.rotation}deg)` : undefined,
          overflow: layout?.clip === false ? 'visible' : 'hidden',
          color: s.color,
          fontFamily: font.family,
          fontWeight: font.weight,
          fontStyle: font.style,
        }}
      >
        {layout?.lines.map((line, i) => (
          <span
            key={i}
            style={{
              left: (s.padding + line.x) * scale,
              top: (content.height - s.padding - line.baseline - layout.fontSize * 0.8) * scale,
              fontSize: layout.fontSize * scale,
            }}
          >
            {line.text}
          </span>
        ))}
        {!value && <span className="placeholder-text">{field.label}</span>}
      </div>
    </div>
  );
}

function ImageSample({ field, asset, scale, boxW, boxH }: { field: ImageField; asset: ImageAsset | null; scale: number; boxW: number; boxH: number }) {
  const s = field.style;
  const objectPosition = `${s.horizontalAlign === 'left' ? '0%' : s.horizontalAlign === 'right' ? '100%' : '50%'} ${s.verticalAlign === 'top' ? '0%' : s.verticalAlign === 'bottom' ? '100%' : '50%'}`;
  const content = contentFrameSize(s.rotation, boxW, boxH);
  const cw = content.width * scale;
  const ch = content.height * scale;
  return (
    <div className="field-bg image-sample" style={{ background: s.background ?? undefined }}>
      {asset?.previewUrl ? (
        <img
          src={asset.previewUrl}
          alt=""
          draggable={false}
          style={{
            width: cw,
            height: ch,
            left: (boxW * scale - cw) / 2,
            top: (boxH * scale - ch) / 2,
            objectFit: s.fit === 'cover' ? 'cover' : s.fit === 'stretch' ? 'fill' : 'contain',
            objectPosition,
            transform: s.rotation ? `rotate(${s.rotation}deg)` : undefined,
          }}
        />
      ) : (
        <ImageIcon className="image-placeholder" aria-hidden />
      )}
    </div>
  );
}
