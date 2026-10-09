import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  MousePointer2,
  RotateCw,
  ScanSearch,
  Sparkles,
  TextSelect,
  Type,
  ZoomIn,
  ZoomOut,
  Maximize,
  MoveHorizontal,
  AlertTriangle,
} from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import type { ImageField, NormRect, QuarterTurn, TextField } from '../../types/project';
import { PdfViewer, type PageOverlayContext, type PdfViewerHandle } from '../pdf-viewer/PdfViewer';
import { FieldLayer, type Suggestion, type Tool } from './FieldLayer';
import { LeftSidebar } from './LeftSidebar';
import { PropertiesPanel } from './PropertiesPanel';
import { createImageField, createTextField, duplicateField, removeField, replaceField } from './fieldFactory';
import { extractPageText, pdfjs, type ExtractedTextRun, type PageTextInfo } from '../../lib/pdf/pdfjs';
import { clampRectToPage, viewSize } from '../../lib/pdf/coords';
import { resolveText } from '../../lib/mapping/values';
import { collectBoxes, overlap, suggestFromBoxes, suggestFromText, type OpsLike } from '../../lib/pdf/detect';
import { TextRunDialog } from './TextRunDialog';
import { Modal } from '../../components/Modal';
import { isEditableTarget } from '../../app/keyboard';
import { newId } from '../../lib/id';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

export function DesignStep() {
  const ws = useWorkspace();
  const project = ws.project!;
  const pdf = ws.pdf;
  const pages = useMemo(() => project.pdf?.pages ?? [], [project.pdf]);
  const viewer = useRef<PdfViewerHandle>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [customScale, setCustomScale] = useState(1);
  const [viewRotation, setViewRotation] = useState<QuarterTurn>(0);
  const [container, setContainer] = useState({ width: 800, height: 600 });
  const [currentPage, setCurrentPage] = useState(1);
  const [pageText, setPageText] = useState<Map<number, PageTextInfo>>(new Map());
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeRun, setActiveRun] = useState<{ run: ExtractedTextRun; getCanvas: () => HTMLCanvasElement | null } | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState<Suggestion | null>(null);
  const [detecting, setDetecting] = useState(false);

  const refPage = pages[currentPage - 1] ?? pages[0];
  const scale = useMemo(() => {
    if (!refPage) return 1;
    if (zoomMode === 'custom') return customScale;
    const unit = viewSize(refPage, 1, viewRotation);
    const availW = Math.max(200, container.width - 48);
    const availH = Math.max(200, container.height - 64);
    const s = zoomMode === 'fit-width' ? availW / unit.width : Math.min(availW / unit.width, availH / unit.height);
    return Math.max(0.1, Math.min(6, s));
  }, [refPage, zoomMode, customScale, viewRotation, container]);

  const zoomBy = (dir: 1 | -1) => {
    const cur = scale;
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.01);
    setCustomScale(next ?? cur);
    setZoomMode('custom');
  };

  const goToPage = useCallback((n: number) => {
    viewer.current?.scrollToPage(n);
  }, []);

  const onContainerResize = useCallback((w: number, h: number) => setContainer({ width: w, height: h }), []);

  // Text extraction for every page (cheap) — used for inspection, scanned-page hints and suggestions.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    (async () => {
      const map = new Map<number, PageTextInfo>();
      const limit = Math.min(pdf.doc.numPages, 300);
      for (let i = 1; i <= limit; i++) {
        try {
          const page = await pdf.doc.getPage(i);
          map.set(i, await extractPageText(page));
        } catch {
          /* skip page */
        }
        if (cancelled) return;
        if (i % 10 === 0 || i === limit) setPageText(new Map(map));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const pageNotes = useMemo(() => {
    const notes: Record<number, string> = {};
    for (const [n, info] of pageText) if (info.imageOnly) notes[n] = 'This page has no selectable text, only images. It is probably scanned.';
    return notes;
  }, [pageText]);

  // --- Field actions -----------------------------------------------------------
  const selected = project.fields.find((f) => f.id === ws.selectedId) ?? null;

  const createField = useCallback(
    (type: 'text' | 'image', page: number, rect: NormRect) => {
      const field = type === 'text' ? createTextField(project, page, rect) : createImageField(project, page, rect);
      ws.update((p) => ({ ...p, fields: [...p.fields, field] }));
      ws.setSelectedId(field.id);
      setTool('select');
    },
    [project, ws],
  );

  const commitRect = useCallback(
    (id: string, rect: NormRect) => {
      ws.update((p) => ({ ...p, fields: p.fields.map((f) => (f.id === id ? { ...f, rect } : f)) }));
    },
    [ws],
  );

  // Keyboard shortcuts (only when focus is not in a text input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod && !e.altKey) {
        if (e.key === 'v' || e.key === 'V') return setTool('select');
        if (e.key === 't' || e.key === 'T') return setTool('text');
        if (e.key === 'i' || e.key === 'I') return setTool('image');
        if (e.key === 'Escape') {
          setTool('select');
          ws.setSelectedId(null);
          return;
        }
        if (e.key === '+' || e.key === '=') return zoomBy(1);
        if (e.key === '-') return zoomBy(-1);
      }
      if (!selected) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        ws.update((p) => removeField(p, selected.id));
        return;
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        const copy = duplicateField(project, selected);
        ws.update((p) => ({ ...p, fields: [...p.fields, copy] }));
        ws.setSelectedId(copy.id);
        return;
      }
      const page = pages[selected.page - 1];
      if (page && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !mod) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0) / page.displayWidth;
        const dy = (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) / page.displayHeight;
        const rect = clampRectToPage({ ...selected.rect, x: selected.rect.x + dx, y: selected.rect.y + dy });
        ws.update((p) => replaceField(p, { ...selected, rect }), `nudge:${selected.id}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- Display helpers ---------------------------------------------------------------
  const currentRow = ws.sheet?.rows[ws.currentRow] ?? null;
  const displayValue = useCallback(
    (field: TextField) => {
      const source = project.mapping[field.id];
      if (source && source.kind !== 'none' && (currentRow || source.kind === 'fixed' || source.kind === 'date')) {
        const v = resolveText(source, currentRow).value;
        if (v) return v;
      }
      return field.sampleValue;
    },
    [project.mapping, currentRow],
  );
  const sampleImage = useCallback(
    (field: ImageField) => {
      const s = project.mapping[field.id];
      if (s?.kind === 'fixed-image') return ws.imageResolver.assets.get(s.imageId) ?? null;
      if (s?.kind === 'column' && currentRow && ws.imageResolver.index) {
        const m = ws.imageResolver.index.match(currentRow.values[s.column], ws.imageOverrides);
        if (m.fileId) return ws.imageResolver.assets.get(m.fileId) ?? null;
      }
      return ws.sampleImages[field.id] ?? null;
    },
    [project.mapping, currentRow, ws.imageResolver, ws.imageOverrides, ws.sampleImages],
  );

  // --- Suggestions (smart detection) ------------------------------------------------
  const findSuggestions = async () => {
    if (!pdf) return;
    setDetecting(true);
    try {
      const out: Suggestion[] = [];
      for (const info of pages) {
        const text = pageText.get(info.pageNumber);
        const runs = text?.runs ?? [];
        const found = suggestFromText(runs, info);
        try {
          const page = await pdf.doc.getPage(info.pageNumber);
          const ops = await page.getOperatorList();
          found.push(...suggestFromBoxes(collectBoxes(ops.fnArray, ops.argsArray, pdfjs.OPS as unknown as OpsLike), info, runs));
        } catch {
          /* drawing analysis is optional */
        }
        for (const s of found) {
          const rect = clampRectToPage(s.rect);
          const taken = project.fields.some((f) => f.page === info.pageNumber && overlap(f.rect, rect) > 0.5);
          if (!taken) out.push({ id: newId('sug'), page: info.pageNumber, rect, type: s.type, label: s.label, reason: s.reason });
        }
      }
      setSuggestions(out);
      ws.toast(out.length ? `Found ${out.length} possible field${out.length === 1 ? '' : 's'}. Click a dashed box to review it.` : 'No likely field positions were found. Place fields manually.', 'info');
    } finally {
      setDetecting(false);
    }
  };

  const acceptSuggestion = (s: Suggestion) => {
    const field = s.type === 'text' ? createTextField(project, s.page, s.rect, s.label) : createImageField(project, s.page, s.rect, s.label);
    ws.update((p) => ({ ...p, fields: [...p.fields, field] }));
    ws.setSelectedId(field.id);
    setSuggestions((list) => list.filter((x) => x.id !== s.id));
    setActiveSuggestion(null);
  };

  if (!pdf || !project.pdf) return null;
  const textOn = tool === 'inspect';
  const currentNote = pageNotes[currentPage];

  return (
    <div className="design">
      <LeftSidebar currentPage={currentPage} onGoToPage={goToPage} pageNotes={pageNotes} />
      <section className="canvas-area" aria-label="Template editor">
        <div className="toolbar" role="toolbar" aria-label="Editing tools">
          <div className="tool-group" role="radiogroup" aria-label="Tool">
            <ToolButton active={tool === 'select'} onClick={() => setTool('select')} label="Select and move (V)" icon={<MousePointer2 size={17} />} text="Select" />
            <ToolButton active={tool === 'text'} onClick={() => setTool('text')} label="Draw a text field (T)" icon={<Type size={17} />} text="Text" />
            <ToolButton active={tool === 'image'} onClick={() => setTool('image')} label="Draw an image field (I)" icon={<ImageIcon size={17} />} text="Image" />
            <ToolButton active={textOn} onClick={() => setTool(textOn ? 'select' : 'inspect')} label="Show text found in the PDF" icon={<TextSelect size={17} />} text="PDF text" />
          </div>
          <div className="tool-group">
            <button type="button" className="btn btn-ghost" onClick={findSuggestions} disabled={detecting} title="Look for fill-in lines, placeholders and empty photo boxes">
              <Sparkles size={17} /> {detecting ? 'Looking…' : 'Suggest fields'}
            </button>
            {suggestions.length > 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => setSuggestions([])}>
                Hide {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
          <div className="tool-group tool-group-right">
            <button type="button" className="icon-btn" onClick={() => goToPage(Math.max(1, currentPage - 1))} aria-label="Previous page" disabled={currentPage <= 1}>
              <ChevronLeft size={18} />
            </button>
            <span className="page-indicator" aria-live="polite">
              {currentPage} / {pages.length}
            </span>
            <button type="button" className="icon-btn" onClick={() => goToPage(Math.min(pages.length, currentPage + 1))} aria-label="Next page" disabled={currentPage >= pages.length}>
              <ChevronRight size={18} />
            </button>
            <span className="sep" />
            <button type="button" className="icon-btn" onClick={() => zoomBy(-1)} aria-label="Zoom out">
              <ZoomOut size={18} />
            </button>
            <span className="zoom-label">{Math.round(scale * 100)}%</span>
            <button type="button" className="icon-btn" onClick={() => zoomBy(1)} aria-label="Zoom in">
              <ZoomIn size={18} />
            </button>
            <button type="button" className={`icon-btn${zoomMode === 'fit-width' ? ' active' : ''}`} onClick={() => setZoomMode('fit-width')} aria-label="Fit to width" title="Fit to width">
              <MoveHorizontal size={18} />
            </button>
            <button type="button" className={`icon-btn${zoomMode === 'fit-page' ? ' active' : ''}`} onClick={() => setZoomMode('fit-page')} aria-label="Fit whole page" title="Fit whole page">
              <Maximize size={18} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setViewRotation((r) => ((r + 90) % 360) as QuarterTurn)}
              aria-label={`Rotate view (currently ${viewRotation}°)`}
              title="Rotate the view (does not change the PDF)"
            >
              <RotateCw size={18} />
            </button>
          </div>
        </div>
        {pdf.exportBlocked && (
          <p className="callout callout-error" role="alert">
            <AlertTriangle size={16} aria-hidden /> {pdf.exportBlocked}
          </p>
        )}
        <div className="viewer-wrap">
          <div className="floating-hints" aria-live="polite">
            {(tool === 'text' || tool === 'image') && <p className="tool-hint">Drag on the page to draw a {tool} field, or click once for a default size. Press Esc to cancel.</p>}
            {textOn && (
          <p className="tool-hint">
            <ScanSearch size={15} aria-hidden /> Yellow boxes show text PDF.js can read from the page. Click one to create a field there or to try a best-effort replacement.
          </p>
        )}
            {currentNote && textOn && <p className="callout callout-warning">Page {currentPage}: {currentNote} Text cannot be inspected; place fields manually.</p>}
          </div>
        <PdfViewer
          doc={pdf.doc}
          pages={pages}
          scale={scale}
          viewRotation={viewRotation}
          handleRef={viewer}
          onCurrentPageChange={setCurrentPage}
          onContainerResize={onContainerResize}
          pageBanner={(n) =>
            pageNotes[n] ? (
              <div className="page-banner" title={pageNotes[n]}>
                Scanned/image-only page: no selectable text
              </div>
            ) : null
          }
          overlay={(ctx: PageOverlayContext) => {
            return (
              <FieldLayer
                ctx={ctx}
                fields={project.fields.filter((f) => f.page === ctx.pageNumber)}
                formFields={project.formFields}
                textRuns={textOn ? (pageText.get(ctx.pageNumber)?.runs ?? []) : null}
                suggestions={suggestions.filter((s) => s.page === ctx.pageNumber)}
                selectedId={ws.selectedId}
                tool={tool}
                displayValue={displayValue}
                sampleImage={sampleImage}
                onSelect={ws.setSelectedId}
                onCommitRect={commitRect}
                onCreate={createField}
                onTextRun={(run) => setActiveRun({ run, getCanvas: ctx.getCanvas })}
                onSuggestion={setActiveSuggestion}
              />
            );
          }}
        />
        </div>
      </section>
      <aside className="sidebar sidebar-right" aria-label="Field properties">
        <PropertiesPanel />
      </aside>

      {activeRun && (
        <TextRunDialog
          run={activeRun.run}
          getCanvas={activeRun.getCanvas}
          viewRotation={viewRotation}
          imageOnlyPage={!!pageNotes[activeRun.run.page]}
          onClose={() => setActiveRun(null)}
          onCreated={(id) => {
            ws.setSelectedId(id);
            setActiveRun(null);
            setTool('select');
          }}
        />
      )}
      <Modal
        open={!!activeSuggestion}
        title={activeSuggestion ? `Suggested ${activeSuggestion.type} field` : ''}
        onClose={() => setActiveSuggestion(null)}
        footer={
          activeSuggestion && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSuggestions((l) => l.filter((x) => x.id !== activeSuggestion.id));
                  setActiveSuggestion(null);
                }}
              >
                Reject
              </button>
              <button type="button" className="btn btn-primary" onClick={() => acceptSuggestion(activeSuggestion)}>
                Create field
              </button>
            </>
          )
        }
      >
        {activeSuggestion && (
          <>
            <p>
              Reason: <strong>{activeSuggestion.reason}</strong>. Proposed name: <strong>{activeSuggestion.label}</strong>.
            </p>
            <p className="hint">This is only a guess based on the page drawing. After creating the field you can move, resize and rename it. Detection will miss many layouts; manual placement always works.</p>
          </>
        )}
      </Modal>
    </div>
  );
}

function ToolButton({ active, onClick, label, icon, text }: { active: boolean; onClick: () => void; label: string; icon: React.ReactNode; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={active} className={`tool-btn${active ? ' active' : ''}`} onClick={onClick} title={label} aria-label={label}>
      {icon}
      <span>{text}</span>
    </button>
  );
}
