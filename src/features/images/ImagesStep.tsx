import { useMemo, useRef, useState } from 'react';
import { FolderOpen, ImagePlus, Images, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, IssueList, ProgressBar, SeverityIcon } from '../../components/ui';
import { isProbablyImageFile, loadImageFile } from '../../lib/images/load';
import { cellToString } from '../../lib/spreadsheet/parse';
import type { ImageField } from '../../types/project';
import { formatBytes } from '../../lib/download';

export function ImagesStep() {
  const ws = useWorkspace();
  const project = ws.project!;
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const imageFields = project.fields.filter((f): f is ImageField => f.type === 'image');
  const columnFields = imageFields.filter((f) => project.mapping[f.id]?.kind === 'column');

  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const all = Array.from(list);
    const chosen = all.filter(isProbablyImageFile);
    const skipped = all.length - chosen.length;
    setProgress({ done: 0, total: chosen.length });
    const out = [];
    for (let i = 0; i < chosen.length; i++) {
      out.push(await loadImageFile(chosen[i]!));
      if (i % 5 === 4 || i === chosen.length - 1) setProgress({ done: i + 1, total: chosen.length });
    }
    ws.addImages(out);
    setProgress(null);
    const bad = out.filter((a) => a.error).length;
    ws.toast(`Added ${out.length - bad} image${out.length - bad === 1 ? '' : 's'}${bad ? `, ${bad} unusable` : ''}${skipped ? `, skipped ${skipped} non-image file${skipped === 1 ? '' : 's'}` : ''}.`, bad ? 'warning' : 'success');
  };

  const fileIssues = useMemo(() => {
    const issues = ws.images.filter((a) => a.error).map((a) => ({ severity: 'warning' as const, message: `${a.relativePath}: ${a.error}` }));
    const dups = ws.imageResolver.index?.duplicateNames() ?? [];
    for (const d of dups) issues.push({ severity: 'warning', message: `Several files share the name “${d[0]!.split('/').pop()}”: ${d.join(', ')}. Rows using this name need a manual choice.` });
    return issues;
  }, [ws.images, ws.imageResolver]);

  const totalBytes = ws.images.reduce((s, a) => s + a.byteLength, 0);

  return (
    <div className="step-page">
      <section className="card">
        <header className="card-head">
          <h2>
            <Images size={20} aria-hidden /> Images
          </h2>
          <p className="muted">
            Select the photos your data file refers to. They are read by this browser only — the spreadsheet value is used purely as a lookup key among the files you choose here, never as a path to open.
          </p>
        </header>
        <div className="row-gap wrap">
          <button type="button" className="btn btn-primary" onClick={() => files.current?.click()}>
            <ImagePlus size={16} /> Choose images…
          </button>
          <button type="button" className="btn" onClick={() => folder.current?.click()}>
            <FolderOpen size={16} /> Choose a folder…
          </button>
          {ws.images.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={ws.clearImages}>
              <Trash2 size={16} /> Remove all ({ws.images.length})
            </button>
          )}
          <span className="muted small">JPEG, PNG and WebP. WebP is converted to PNG. Camera rotation tags are applied.</span>
        </div>
        {progress && (
          <div className="progress-wrap">
            <ProgressBar value={progress.done} max={progress.total} label="Reading images" />
            <span className="small">
              Reading {progress.done} / {progress.total}
            </span>
          </div>
        )}
        {ws.images.length > 0 && (
          <p className="small muted">
            {ws.images.length} file{ws.images.length === 1 ? '' : 's'} loaded ({formatBytes(totalBytes)}). Images are not saved with the project.
          </p>
        )}
        <IssueList issues={fileIssues} />
        <input ref={files} type="file" multiple accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" className="visually-hidden" onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))} />
        <input
          ref={folder}
          type="file"
          multiple
          className="visually-hidden"
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))}
        />
      </section>

      {imageFields.length === 0 ? (
        <section className="card">
          <EmptyState title="No image fields">
            <p>Draw an image field on the Design step to place photos.</p>
          </EmptyState>
        </section>
      ) : columnFields.length === 0 ? (
        <section className="card">
          <EmptyState title="No image column chosen">
            <p>On the Data step, set an image field's source to the column that holds file names (for example “Photo”).</p>
            <button type="button" className="btn" onClick={() => ws.setStep('data')}>
              Go to Data
            </button>
          </EmptyState>
        </section>
      ) : !ws.sheet ? (
        <section className="card">
          <EmptyState title="No data file loaded">
            <p>Load the data file on the Data step to see which image each row uses.</p>
          </EmptyState>
        </section>
      ) : (
        columnFields.map((f) => <MatchTable key={f.id} field={f} onlyProblems={onlyProblems} setOnlyProblems={setOnlyProblems} />)
      )}
    </div>
  );
}

function MatchTable({ field, onlyProblems, setOnlyProblems }: { field: ImageField; onlyProblems: boolean; setOnlyProblems: (v: boolean) => void }) {
  const ws = useWorkspace();
  const source = ws.project!.mapping[field.id];
  const column = source?.kind === 'column' ? source.column : '';
  const sheet = ws.sheet!;
  const index = ws.imageResolver.index;
  const results = useMemo(
    () =>
      sheet.rows.map((row, i) => {
        const value = cellToString(row.values[column] ?? null);
        const match = index ? index.match(value, ws.imageOverrides) : { key: value.toLowerCase(), status: value.trim() ? ('not-found' as const) : ('empty' as const), fileId: null, candidates: [] };
        const asset = match.fileId ? (ws.imageResolver.assets.get(match.fileId) ?? null) : null;
        return { i, row, value, match, asset };
      }),
    [sheet.rows, column, index, ws.imageOverrides, ws.imageResolver.assets],
  );
  const counts = results.reduce(
    (acc, r) => {
      const bad = r.match.status === 'not-found' || r.match.status === 'ambiguous' || !!r.asset?.error;
      if (bad) acc.problems++;
      else if (r.match.status === 'empty') acc.empty++;
      else acc.ok++;
      return acc;
    },
    { ok: 0, problems: 0, empty: 0 },
  );
  const shown = onlyProblems ? results.filter((r) => r.match.status === 'not-found' || r.match.status === 'ambiguous' || r.asset?.error) : results;
  const LIMIT = 300;

  return (
    <section className="card">
      <header className="card-head row-between">
        <div>
          <h2>
            “{field.label}” ← column “{column}”
          </h2>
          <p className="muted">
            <SeverityIcon severity="ok" /> {counts.ok} matched · <SeverityIcon severity={counts.problems ? 'error' : 'ok'} /> {counts.problems} need attention · {counts.empty} blank
          </p>
        </div>
        <label className="check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Show only problems
        </label>
      </header>
      <div className="table-scroll">
        <table className="match-table">
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Value in data</th>
              <th scope="col">Status</th>
              <th scope="col">Image</th>
              <th scope="col">Choose manually</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, LIMIT).map(({ i, row, value, match, asset }) => (
              <tr key={i}>
                <th scope="row">{row.sourceRow}</th>
                <td className="mono">{value || <span className="muted">blank</span>}</td>
                <td>
                  <StatusLabel status={match.status} error={asset?.error ?? null} candidates={match.candidates.length} />
                </td>
                <td>{asset?.previewUrl ? <img className="thumb" src={asset.previewUrl} alt={`Image for row ${row.sourceRow}`} /> : <span className="muted">—</span>}</td>
                <td>
                  {value.trim() !== '' && ws.images.length > 0 && (
                    <select
                      aria-label={`Choose image for row ${row.sourceRow}`}
                      value={ws.imageOverrides[match.key] ?? ''}
                      onChange={(e) => ws.setImageOverride(match.key, e.target.value || null)}
                    >
                      <option value="">{match.status === 'matched' ? 'Automatic' : 'Choose a file…'}</option>
                      {(match.status === 'ambiguous' ? ws.images.filter((a) => match.candidates.includes(a.id)) : ws.images)
                        .filter((a) => !a.error)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.relativePath}
                          </option>
                        ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > LIMIT && <p className="muted small">Showing the first {LIMIT} of {shown.length} rows.</p>}
      <p className="hint">A manual choice applies to every row with the same value.</p>
    </section>
  );
}

function StatusLabel({ status, error, candidates }: { status: string; error: string | null; candidates: number }) {
  if (error) return <span className="status status-error">Unusable: {error}</span>;
  switch (status) {
    case 'matched':
      return <span className="status status-ok">Matched</span>;
    case 'manual':
      return <span className="status status-ok">Chosen manually</span>;
    case 'empty':
      return <span className="status status-muted">No value</span>;
    case 'ambiguous':
      return <span className="status status-error">{candidates} files match — choose one</span>;
    default:
      return <span className="status status-error">No matching file</span>;
  }
}
