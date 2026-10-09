import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileDown } from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import { IssueList, SeverityIcon, Spinner } from '../../components/ui';
import { PdfViewer } from '../pdf-viewer/PdfViewer';
import { closePdf, openPdf, readPageInfos, type PDFDocumentProxy } from '../../lib/pdf/pdfjs';
import { planRow, templateIssues } from '../../lib/render/plan';
import { generateFilledPdf } from '../../lib/render/generate';
import { useRenderContext, useRowStatuses } from './useRowStatus';
import type { PageInfo, ValidationIssue } from '../../types/project';
import { downloadBytes, openPdfInNewTab } from '../../lib/download';
import { applyFileNamePattern, sanitizeFileBase } from '../../lib/export/filenames';
import { cellToString } from '../../lib/spreadsheet/parse';
import { ExportDialog } from '../export/ExportDialog';

interface PreviewDoc {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  pages: PageInfo[];
}

export function PreviewStep() {
  const ws = useWorkspace();
  const project = ws.project!;
  const ctx = useRenderContext();
  const sheet = ws.sheet;
  const rowCount = sheet?.rows.length ?? 0;
  const rowIndex = Math.min(ws.currentRow, Math.max(0, rowCount - 1));
  const row = sheet?.rows[rowIndex] ?? null;
  const { statuses, done, total } = useRowStatuses();
  const [preview, setPreview] = useState<PreviewDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const [container, setContainer] = useState({ width: 700, height: 600 });
  const previewRef = useRef<PreviewDoc | null>(null);

  // Generate the real PDF for the current row: preview == export.
  useEffect(() => {
    if (!ctx || !ws.pdf) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const plan = planRow(ctx, row, row ? rowIndex : null);
        setIssues(plan.issues);
        if (ws.pdf!.exportBlocked) throw new Error(ws.pdf!.exportBlocked);
        const { bytes, issues: genIssues } = await generateFilledPdf({
          templateBytes: ws.pdf!.bytes,
          plan,
          formMode: project.settings.exportDefaults.formMode,
          formFieldFont: project.settings.formFieldFont,
          fontBytes: (id) => ws.fontBytes.get(id),
          title: project.name,
        });
        const doc = await openPdf(bytes);
        const pages = await readPageInfos(doc);
        if (cancelled) {
          void closePdf(doc);
          return;
        }
        if (genIssues.length) setIssues([...plan.issues, ...genIssues]);
        const old = previewRef.current;
        previewRef.current = { bytes, doc, pages };
        setPreview(previewRef.current);
        if (old) setTimeout(() => void closePdf(old.doc), 500);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [ctx, row, rowIndex, ws.pdf, ws.fontBytes, project.settings.exportDefaults.formMode, project.settings.formFieldFont, project.name]);

  useEffect(() => () => void closePdf(previewRef.current?.doc), []);

  const tIssues = useMemo(() => templateIssues(project, sheet ? sheet.columns.map((c) => c.key) : null), [project, sheet]);
  const labelColumn = useMemo(() => {
    for (const f of project.fields) {
      const s = project.mapping[f.id];
      if (f.type === 'text' && s?.kind === 'column') return s.column;
    }
    return sheet?.columns[0]?.key ?? null;
  }, [project, sheet]);

  const rowsShown = useMemo(() => {
    if (!sheet) return [];
    const idx = sheet.rows.map((_, i) => i);
    return filter === 'problems' ? idx.filter((i) => (statuses[i]?.errors ?? 0) + (statuses[i]?.warnings ?? 0) > 0) : idx;
  }, [sheet, filter, statuses]);

  const validCount = statuses.filter((s) => s && s.errors === 0).length;
  const errorCount = statuses.filter((s) => s && s.errors > 0).length;
  const go = (n: number) => ws.setCurrentRow(Math.max(0, Math.min(rowCount - 1, n)));
  const onResize = useCallback((w: number, h: number) => setContainer({ width: w, height: h }), []);
  const firstPage = preview?.pages[0];
  const scale = firstPage ? Math.max(0.2, Math.min(3, (container.width - 48) / firstPage.displayWidth)) : 1;

  const fileName = `${sanitizeFileBase(applyFileNamePattern(project.settings.exportDefaults.fileNamePattern, row, row?.sourceRow ?? 1, project.name)) || project.name}.pdf`;

  return (
    <div className="preview-layout">
      <aside className="sidebar sidebar-left" aria-label="Rows">
        <div className="sidebar-body">
          <h2 className="panel-title">Rows</h2>
          {!sheet ? (
            <p className="muted small">
              No data file loaded. The preview uses each field's sample value.{' '}
              <button type="button" className="link-btn" onClick={() => ws.setStep('data')}>
                Load data
              </button>
            </p>
          ) : (
            <>
              <p className="small">
                {done < total ? (
                  <>
                    <Spinner label="Checking rows" /> Checking rows… {done}/{total}
                  </>
                ) : (
                  <>
                    <SeverityIcon severity="ok" size={14} /> {validCount} ready · <SeverityIcon severity="error" size={14} /> {errorCount} with errors
                  </>
                )}
              </p>
              <div className="row-gap wrap small">
                <select aria-label="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'problems')}>
                  <option value="all">All rows</option>
                  <option value="problems">Rows with problems</option>
                </select>
                <button type="button" className="link-btn" onClick={() => ws.setSelectedRows(new Set(sheet.rows.map((_, i) => i)))}>
                  Select all
                </button>
                <button type="button" className="link-btn" onClick={() => ws.setSelectedRows(new Set(sheet.rows.map((_, i) => i).filter((i) => statuses[i] && statuses[i]!.errors === 0)))}>
                  Select ready
                </button>
                <button type="button" className="link-btn" onClick={() => ws.setSelectedRows(new Set())}>
                  None
                </button>
              </div>
              <ul className="row-list" aria-label="Data rows">
                {rowsShown.slice(0, 500).map((i) => {
                  const r = sheet.rows[i]!;
                  const st = statuses[i];
                  const label = labelColumn ? cellToString(r.values[labelColumn] ?? null) : '';
                  return (
                    <li key={i} className={i === rowIndex ? 'current' : ''}>
                      <input
                        type="checkbox"
                        aria-label={`Select row ${r.sourceRow} for export`}
                        checked={ws.selectedRows.has(i)}
                        onChange={(e) => {
                          const next = new Set(ws.selectedRows);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          ws.setSelectedRows(next);
                        }}
                      />
                      <button type="button" onClick={() => go(i)} aria-current={i === rowIndex ? 'true' : undefined} title={st?.firstError ?? undefined}>
                        <span className="row-num">{r.sourceRow}</span>
                        <span className="row-label">{label || <span className="muted">(blank)</span>}</span>
                        {st && <SeverityIcon severity={st.errors ? 'error' : st.warnings ? 'warning' : 'ok'} size={14} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {rowsShown.length > 500 && <p className="muted small">Showing 500 of {rowsShown.length}. Use the row number box to jump.</p>}
            </>
          )}
        </div>
      </aside>

      <section className="canvas-area" aria-label="Preview">
        <div className="toolbar">
          {sheet ? (
            <div className="tool-group">
              <button type="button" className="icon-btn" onClick={() => go(rowIndex - 1)} disabled={rowIndex <= 0} aria-label="Previous row">
                <ChevronLeft size={18} />
              </button>
              <label className="row-jump">
                Row
                <input type="number" min={1} max={rowCount} value={rowIndex + 1} onChange={(e) => go(Number(e.target.value) - 1)} aria-label="Row number (position in the list)" />
                of {rowCount}
              </label>
              <button type="button" className="icon-btn" onClick={() => go(rowIndex + 1)} disabled={rowIndex >= rowCount - 1} aria-label="Next row">
                <ChevronRight size={18} />
              </button>
              {row && <span className="muted small">source row {row.sourceRow}</span>}
            </div>
          ) : (
            <span className="muted">Preview with sample values</span>
          )}
          <div className="tool-group tool-group-right">
            {busy && <Spinner label="Generating preview" />}
            <button type="button" className="btn" disabled={!preview} onClick={() => preview && openPdfInNewTab(preview.bytes)}>
              <ExternalLink size={16} /> Open
            </button>
            <button type="button" className="btn" disabled={!preview} onClick={() => preview && downloadBytes(preview.bytes, fileName, 'application/pdf')}>
              <Download size={16} /> Download this PDF
            </button>
            <button type="button" className="btn btn-primary" onClick={() => ws.setDialog('export')} disabled={!!ws.pdf?.exportBlocked}>
              <FileDown size={16} /> Export…
            </button>
          </div>
        </div>
        {error && (
          <p className="callout callout-error" role="alert">
            {error}
          </p>
        )}
        {preview ? (
          <PdfViewer doc={preview.doc} pages={preview.pages} scale={scale} viewRotation={0} onContainerResize={onResize} ariaLabel="Generated PDF preview" className={busy ? 'stale' : ''} />
        ) : (
          <div className="center-fill">{busy ? <Spinner label="Generating preview" /> : <p className="muted">The preview appears here.</p>}</div>
        )}
      </section>

      <aside className="sidebar sidebar-right" aria-label="Checks">
        <div className="sidebar-body">
          <h2 className="panel-title">{row ? `Checks for row ${row.sourceRow}` : 'Checks'}</h2>
          <IssueList issues={issues} empty="No problems found for this row." />
          <h2 className="panel-title">Template</h2>
          <IssueList issues={tIssues} empty="No template problems found." />
          <p className="hint">Rows with errors (red) are skipped by “Export all ready rows”. Warnings do not block export.</p>
        </div>
      </aside>

      {ws.dialog === 'export' && <ExportDialog onClose={() => ws.setDialog(null)} statuses={statuses} />}
    </div>
  );
}
