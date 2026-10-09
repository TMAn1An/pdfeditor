import { useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, FileArchive, Square } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { IssueList, Labeled, ProgressBar, SeverityIcon } from '../../components/ui';
import { useWorkspace } from '../../app/workspace';
import { useRenderContext, type RowStatus } from '../preview/useRowStatus';
import type { ExportOptions, ExportResult, ExportScope, ExportSummary, FormOutputMode } from '../../types/project';
import { runBatch, zipResults } from '../../lib/export/batch';
import { applyFileNamePattern, FileNameAllocator } from '../../lib/export/filenames';
import { planRow } from '../../lib/render/plan';
import { generateFilledPdf } from '../../lib/render/generate';
import { downloadBytes, formatBytes, openPdfInNewTab } from '../../lib/download';
import { newId } from '../../lib/id';
import { sanitizeFileBase } from '../../lib/export/filenames';

interface Props {
  onClose: () => void;
  statuses: (RowStatus | undefined)[];
}

export function ExportDialog({ onClose, statuses }: Props) {
  const ws = useWorkspace();
  const project = ws.project!;
  const ctx = useRenderContext();
  const sheet = ws.sheet;
  const defaults = project.settings.exportDefaults;
  const [scope, setScope] = useState<ExportScope>(sheet ? (ws.selectedRows.size > 0 ? 'selected' : 'valid') : 'current');
  const [pattern, setPattern] = useState(defaults.fileNamePattern);
  const [formMode, setFormMode] = useState<FormOutputMode>(defaults.formMode);
  const [zip, setZip] = useState(defaults.zip);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [liveResults, setLiveResults] = useState<ExportResult[]>([]);
  const cancelRef = useRef(false);

  const rowIndexes = useMemo(() => {
    if (!sheet) return [-1];
    if (scope === 'current') return [Math.min(ws.currentRow, sheet.rows.length - 1)];
    if (scope === 'selected') return [...ws.selectedRows].sort((a, b) => a - b);
    return sheet.rows.map((_, i) => i).filter((i) => !statuses[i] || statuses[i]!.errors === 0);
  }, [sheet, scope, ws.currentRow, ws.selectedRows, statuses]);

  const checking = sheet ? statuses.filter(Boolean).length < sheet.rows.length : false;
  const validCount = sheet ? sheet.rows.filter((_, i) => statuses[i] && statuses[i]!.errors === 0).length : 1;

  const namePreview = useMemo(() => {
    const alloc = new FileNameAllocator();
    return rowIndexes.slice(0, 3).map((i) => {
      const row = i >= 0 ? (sheet?.rows[i] ?? null) : null;
      return alloc.allocate(applyFileNamePattern(pattern, row, row?.sourceRow ?? 1, project.name), `${project.name} - row ${row?.sourceRow ?? 1}`);
    });
  }, [rowIndexes, pattern, sheet, project.name]);

  const start = async () => {
    if (!ctx || !ws.pdf) return;
    const options: ExportOptions = { scope, fileNamePattern: pattern, formMode, zip };
    ws.update((p) => ({ ...p, settings: { ...p.settings, exportDefaults: { fileNamePattern: pattern, formMode, zip } } }), 'export-defaults');
    cancelRef.current = false;
    setRunning(true);
    setSummary(null);
    setLiveResults([]);
    setProgress({ done: 0, total: rowIndexes.length, failed: 0 });
    const pdfBytes = ws.pdf.bytes;
    let failed = 0;
    const result = await runBatch(
      {
        job: makeJob(rowIndexes, options),
        rows: rowIndexes.map((i) => ({ rowIndex: i, row: i >= 0 ? (sheet?.rows[i] ?? null) : null })),
        templateName: project.name,
      },
      {
        blockingIssues: ({ row, rowIndex }) => planRow(ctx, row, rowIndex >= 0 ? rowIndex : null).issues.filter((x) => x.severity === 'error'),
        generate: async ({ row, rowIndex }) => {
          const plan = planRow(ctx, row, rowIndex >= 0 ? rowIndex : null);
          const out = await generateFilledPdf({
            templateBytes: pdfBytes,
            plan,
            formMode,
            formFieldFont: project.settings.formFieldFont,
            fontBytes: (id) => ws.fontBytes.get(id),
            title: project.name,
          });
          return { bytes: out.bytes, warnings: [...plan.issues.filter((x) => x.severity === 'warning'), ...out.issues] };
        },
        onProgress: (done, total, last) => {
          if (last.status === 'failed') failed++;
          setProgress({ done, total, failed });
          setLiveResults((r) => [...r, last]);
        },
        isCancelled: () => cancelRef.current,
        yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
      },
    );
    setSummary(result);
    setRunning(false);
    const ok = result.results.filter((r): r is Extract<ExportResult, { status: 'ok' }> => r.status === 'ok');
    if (ok.length === 1 && result.results.length === 1) {
      downloadBytes(ok[0]!.bytes, ok[0]!.fileName, 'application/pdf');
    } else if (ok.length > 0 && zip) {
      await downloadZip(result.results);
    }
  };

  const downloadZip = async (results: ExportResult[]) => {
    const bytes = await zipResults(results);
    downloadBytes(bytes, `${sanitizeFileBase(project.name) || 'export'}.zip`, 'application/zip');
  };

  const results = summary?.results ?? liveResults;
  const okResults = results.filter((r): r is Extract<ExportResult, { status: 'ok' }> => r.status === 'ok');
  const totalBytes = okResults.reduce((s, r) => s + r.bytes.byteLength, 0);

  return (
    <Modal
      open
      wide
      locked={running}
      title="Export PDFs"
      onClose={() => {
        if (summary && okResults.length > 0 && !confirm('Close the export? Generated files that you have not downloaded will be discarded.')) return;
        onClose();
      }}
      footer={
        running ? (
          <button type="button" className="btn" onClick={() => (cancelRef.current = true)}>
            <Square size={14} /> Stop after current row
          </button>
        ) : summary ? (
          <>
            {okResults.length > 1 && (
              <button type="button" className="btn btn-primary" onClick={() => void downloadZip(summary.results)}>
                <FileArchive size={16} /> Download ZIP ({okResults.length} PDFs, {formatBytes(totalBytes)})
              </button>
            )}
            <button type="button" className="btn" onClick={() => setSummary(null)}>
              Export again
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void start()}
              disabled={!ctx || rowIndexes.length === 0 || !!ws.pdf?.exportBlocked}
            >
              Create {rowIndexes.length} PDF{rowIndexes.length === 1 ? '' : 's'}
            </button>
          </>
        )
      }
    >
      {!running && !summary && (
        <div className="export-form">
          <fieldset className="group">
            <legend>Which rows</legend>
            {!sheet ? (
              <p className="muted">No data file is loaded, so one PDF with the sample values will be created.</p>
            ) : (
              <>
                <label className="check">
                  <input type="radio" name="scope" checked={scope === 'current'} onChange={() => setScope('current')} /> Current row only (row{' '}
                  {sheet.rows[Math.min(ws.currentRow, sheet.rows.length - 1)]?.sourceRow})
                </label>
                <label className="check">
                  <input type="radio" name="scope" checked={scope === 'selected'} onChange={() => setScope('selected')} disabled={ws.selectedRows.size === 0} />{' '}
                  Selected rows ({ws.selectedRows.size}){ws.selectedRows.size === 0 && <span className="muted small"> — tick rows in the list first</span>}
                </label>
                <label className="check">
                  <input type="radio" name="scope" checked={scope === 'valid'} onChange={() => setScope('valid')} /> All ready rows ({validCount} of{' '}
                  {sheet.rows.length}){checking && <span className="muted small"> — still checking rows…</span>}
                </label>
                {scope !== 'valid' && <p className="hint">Rows with errors are reported as failed and skipped; every other row is still created.</p>}
              </>
            )}
          </fieldset>
          <Labeled label="File names" hint="Use {Column name}, {row} or {template}. Unsafe characters are replaced and duplicates get (2), (3)…">
            {(id) => <input id={id} type="text" value={pattern} onChange={(e) => setPattern(e.target.value)} />}
          </Labeled>
          <p className="small">
            Example: {namePreview.map((n) => <code key={n}>{n}</code>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}
          </p>
          {sheet && (
            <div className="chips">
              {sheet.columns.slice(0, 12).map((c) => (
                <button type="button" key={c.key} className="chip" onClick={() => setPattern((p) => `${p}{${c.key}}`)}>
                  +{c.key}
                </button>
              ))}
            </div>
          )}
          <fieldset className="group">
            <legend>Form fields in the output</legend>
            <label className="check">
              <input type="radio" name="formmode" checked={formMode === 'flatten'} onChange={() => setFormMode('flatten')} /> Flatten — values become part of
              the page and cannot be edited (recommended)
            </label>
            <label className="check">
              <input type="radio" name="formmode" checked={formMode === 'interactive'} onChange={() => setFormMode('interactive')} /> Keep editable — PDF form
              fields stay fillable; your text fields become form fields too
            </label>
            {formMode === 'interactive' && (
              <p className="hint">
                Editable fields are drawn by the PDF viewer, which may not shape complex scripts (such as Bangla) correctly or may substitute fonts. Rotated
                text fields are always flattened.
              </p>
            )}
          </fieldset>
          {rowIndexes.length > 1 && (
            <label className="check">
              <input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} /> Download everything as one ZIP file when finished
            </label>
          )}
          <p className="hint">Your original PDF is never changed. Every output is a new file made in this browser.</p>
        </div>
      )}

      {(running || summary) && (
        <div className="export-progress">
          <ProgressBar value={progress.done} max={progress.total} label="Export progress" />
          <p aria-live="polite">
            {running ? 'Creating PDFs… ' : summary?.cancelled ? 'Stopped. ' : 'Finished. '}
            {progress.done} of {progress.total} processed · <SeverityIcon severity="ok" size={14} /> {progress.done - progress.failed} created ·{' '}
            <SeverityIcon severity={progress.failed ? 'error' : 'ok'} size={14} /> {progress.failed} failed
          </p>
          <div className="table-scroll results">
            <table>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {results.slice(-400).map((r) => (
                  <tr key={`${r.rowIndex}-${r.fileName}`}>
                    <td className="mono">{r.fileName}</td>
                    <td>
                      {r.status === 'ok' ? (
                        <span className="status status-ok">
                          Created{r.warnings.length ? ` · ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : ''}
                        </span>
                      ) : (
                        <details>
                          <summary className="status status-error">Failed</summary>
                          {r.issues.length ? <IssueList issues={r.issues} /> : <p className="small">{r.error}</p>}
                        </details>
                      )}
                    </td>
                    <td>
                      {r.status === 'ok' && (
                        <div className="row-gap">
                          <button type="button" className="icon-btn" aria-label={`Open ${r.fileName}`} onClick={() => openPdfInNewTab(r.bytes)}>
                            <ExternalLink size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Download ${r.fileName}`}
                            onClick={() => downloadBytes(r.bytes, r.fileName, 'application/pdf')}
                          >
                            <Download size={16} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.length > 400 && <p className="muted small">Showing the last 400 results. All successful files are in the ZIP.</p>}
        </div>
      )}
    </Modal>
  );
}

function makeJob(rowIndexes: number[], options: ExportOptions) {
  return { id: newId('job'), rowIndexes, options, startedAt: Date.now() };
}
