import { useEffect, useRef, useState } from 'react';
import { FileInput, Image as ImageIcon, Replace, ScanLine, Type } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useWorkspace } from '../../app/workspace';
import { formTarget } from '../../lib/render/plan';

interface LeftSidebarProps {
  currentPage: number;
  onGoToPage: (page: number) => void;
  pageNotes: Record<number, string>;
}

export function LeftSidebar({ currentPage, onGoToPage, pageNotes }: LeftSidebarProps) {
  const [tab, setTab] = useState<'pages' | 'fields'>('fields');
  return (
    <aside className="sidebar sidebar-left" aria-label="Pages and fields">
      <div className="tabs" role="tablist" aria-label="Sidebar">
        <button type="button" role="tab" aria-selected={tab === 'fields'} className={tab === 'fields' ? 'active' : ''} onClick={() => setTab('fields')}>
          Fields
        </button>
        <button type="button" role="tab" aria-selected={tab === 'pages'} className={tab === 'pages' ? 'active' : ''} onClick={() => setTab('pages')}>
          Pages
        </button>
      </div>
      <div className="sidebar-body" role="tabpanel">
        {tab === 'fields' ? <FieldList onGoToPage={onGoToPage} /> : <PageList currentPage={currentPage} onGoToPage={onGoToPage} pageNotes={pageNotes} />}
      </div>
    </aside>
  );
}

function FieldList({ onGoToPage }: { onGoToPage: (p: number) => void }) {
  const ws = useWorkspace();
  const project = ws.project!;
  const fields = [...project.fields].sort((a, b) => a.page - b.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return (
    <div className="field-list">
      <h2 className="panel-title">Your fields ({fields.length})</h2>
      {fields.length === 0 && <p className="muted small">No fields yet. Pick “Text” or “Image” in the toolbar and drag a box on the page.</p>}
      <ul>
        {fields.map((f) => {
          const mapped = project.mapping[f.id] && project.mapping[f.id]!.kind !== 'none';
          return (
            <li key={f.id}>
              <button
                type="button"
                className={`list-item${ws.selectedId === f.id ? ' selected' : ''}`}
                onClick={() => {
                  ws.setSelectedId(f.id);
                  onGoToPage(f.page);
                }}
              >
                {f.type === 'text' ? (
                  <Type size={15} aria-hidden />
                ) : f.type === 'image' ? (
                  <ImageIcon size={15} aria-hidden />
                ) : (
                  <Replace size={15} aria-hidden />
                )}
                <span className="list-label">
                  {f.label}
                  {f.required && (
                    <span className="req" aria-label="required">
                      {' '}
                      *
                    </span>
                  )}
                </span>
                <span className="list-meta">p.{f.page}</span>
                <span
                  className={`dot ${mapped ? 'dot-ok' : 'dot-none'}`}
                  title={mapped ? 'Matched to data' : 'Not matched to data yet'}
                  aria-label={mapped ? 'matched' : 'not matched'}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {project.formFields.length > 0 && (
        <>
          <h2 className="panel-title">
            <FileInput size={15} aria-hidden /> Existing PDF form fields ({project.formFields.length})
          </h2>
          <p className="muted small">These come from the PDF. They can be filled with data but not moved.</p>
          <ul>
            {project.formFields.map((ff) => {
              const id = formTarget(ff.name);
              const mapped = project.mapping[id] && project.mapping[id]!.kind !== 'none';
              return (
                <li key={ff.name}>
                  <button
                    type="button"
                    className={`list-item${ws.selectedId === id ? ' selected' : ''}`}
                    onClick={() => {
                      ws.setSelectedId(id);
                      if (ff.widgets[0]) onGoToPage(ff.widgets[0].page);
                    }}
                  >
                    <FileInput size={15} aria-hidden />
                    <span className="list-label">{ff.name}</span>
                    <span className="list-meta">{ff.fillable ? ff.kind : `${ff.kind} (not fillable)`}</span>
                    <span className={`dot ${mapped ? 'dot-ok' : 'dot-none'}`} aria-label={mapped ? 'matched' : 'not matched'} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function PageList({ currentPage, onGoToPage, pageNotes }: { currentPage: number; onGoToPage: (p: number) => void; pageNotes: Record<number, string> }) {
  const ws = useWorkspace();
  const pages = ws.project?.pdf?.pages ?? [];
  const doc = ws.pdf?.doc;
  return (
    <ol className="page-list">
      {pages.map((p) => {
        const count = ws.project!.fields.filter((f) => f.page === p.pageNumber).length;
        return (
          <li key={p.pageNumber}>
            <button
              type="button"
              className={`page-thumb${currentPage === p.pageNumber ? ' current' : ''}`}
              onClick={() => onGoToPage(p.pageNumber)}
              aria-current={currentPage === p.pageNumber ? 'page' : undefined}
            >
              {doc && <Thumbnail doc={doc} pageNumber={p.pageNumber} />}
              <span className="thumb-caption">
                Page {p.pageNumber}
                {count > 0 && (
                  <span className="pill">
                    {count} field{count === 1 ? '' : 's'}
                  </span>
                )}
                {pageNotes[p.pageNumber] && (
                  <span className="pill pill-warn" title={pageNotes[p.pageNumber]}>
                    <ScanLine size={12} aria-hidden /> scanned?
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Thumbnail({ doc, pageNumber }: { doc: PDFDocumentProxy; pageNumber: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled || !ref.current) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (140 / base.width) * (window.devicePixelRatio || 1) });
      ref.current.width = vp.width;
      ref.current.height = vp.height;
      task = page.render({ canvas: ref.current, viewport: vp });
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, pageNumber]);
  return <canvas ref={ref} className="thumb-canvas" aria-hidden="true" />;
}
