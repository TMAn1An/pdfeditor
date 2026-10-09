import { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, Lock, Sparkles, Trash2, Upload } from 'lucide-react';
import { deleteProject, listProjects, type StoredProjectSummary } from '../lib/storage/localStore';
import { Spinner } from '../components/ui';
import { BUNDLE_EXTENSION } from '../lib/storage/bundle';
import { StorageDialog } from './StorageDialog';

interface WelcomeProps {
  onOpenPdf: (file: File) => Promise<void>;
  onOpenProjectFile: (file: File) => Promise<void>;
  onOpenStored: (id: string) => Promise<void>;
  onSample: () => Promise<void>;
}

export function Welcome({ onOpenPdf, onOpenProjectFile, onOpenStored, onSample }: WelcomeProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<StoredProjectSummary[] | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const pdfInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);

  const refresh = () =>
    listProjects()
      .then(setRecent)
      .catch((err: unknown) => {
        setRecent([]);
        setStorageError(err instanceof Error ? err.message : String(err));
      });
  useEffect(() => {
    void refresh();
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleFile = (file: File) => {
    if (file.name.toLowerCase().endsWith(BUNDLE_EXTENSION) || file.name.toLowerCase().endsWith('.json')) return run('Opening project…', () => onOpenProjectFile(file));
    return run('Opening PDF…', () => onOpenPdf(file));
  };

  return (
    <main className="welcome">
      <div className="welcome-inner">
        <header className="welcome-head">
          <h1>PDF Template Studio</h1>
          <p className="lead">Turn any PDF into a reusable template, then create one filled PDF per spreadsheet row — names, numbers, dates and photos.</p>
          <p className="privacy">
            <Lock size={16} aria-hidden /> Everything happens in this browser. Your PDFs, spreadsheets and photos are never uploaded.
          </p>
        </header>

        <div
          className={`dropzone big${drag ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) void handleFile(f);
          }}
        >
          {busy ? (
            <>
              <Spinner label={busy} />
              <p>{busy}</p>
            </>
          ) : (
            <>
              <Upload size={36} aria-hidden />
              <p className="dz-title">Drop a PDF here to start a new template</p>
              <div className="row-gap wrap center">
                <button type="button" className="btn btn-primary btn-large" onClick={() => pdfInput.current?.click()}>
                  <FileText size={18} /> Choose PDF…
                </button>
                <button type="button" className="btn btn-large" onClick={() => projectInput.current?.click()}>
                  <FolderOpen size={18} /> Open project file…
                </button>
                <button type="button" className="btn btn-ghost btn-large" onClick={() => void run('Loading sample…', onSample)}>
                  <Sparkles size={18} /> Try the sample
                </button>
              </div>
              <p className="hint">PDF files up to 300 MB. Password-protected PDFs can be viewed after entering the password.</p>
            </>
          )}
        </div>
        {error && (
          <p className="callout callout-error" role="alert">
            {error}
          </p>
        )}

        <section className="recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Saved in this browser</h2>
          {storageError && <p className="callout callout-warning">{storageError}</p>}
          {recent === null ? (
            <Spinner label="Loading saved projects" />
          ) : recent.length === 0 ? (
            <p className="muted">No saved templates yet. Templates are saved automatically while you work.</p>
          ) : (
            <ul className="recent-list">
              {recent.map((p) => (
                <li key={p.id}>
                  <button type="button" className="recent-open" onClick={() => void run('Opening project…', () => onOpenStored(p.id))}>
                    <FileText size={18} aria-hidden />
                    <span>
                      <strong>{p.name}</strong>
                      <span className="muted small">
                        {p.pdfName ?? 'no PDF'} · {p.fieldCount} field{p.fieldCount === 1 ? '' : 's'} · {new Date(p.updatedAt).toLocaleString()}
                        {!p.hasPdf && ' · PDF not stored'}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    aria-label={`Delete ${p.name} from this browser`}
                    onClick={async () => {
                      if (!confirm(`Delete “${p.name}” from this browser? This cannot be undone.`)) return;
                      await deleteProject(p.id);
                      void refresh();
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="link-btn" onClick={() => setStorageOpen(true)}>
            What is stored, and clearing local data…
          </button>
        </section>

        <section className="how" aria-label="How it works">
          <ol>
            <li>
              <strong>Design</strong> — draw text and image boxes on the PDF.
            </li>
            <li>
              <strong>Data</strong> — load an Excel or CSV file and match columns to boxes.
            </li>
            <li>
              <strong>Images</strong> — pick the photo files the spreadsheet names.
            </li>
            <li>
              <strong>Preview &amp; export</strong> — check each row, then download PDFs or a ZIP.
            </li>
          </ol>
        </section>
      </div>
      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf,.pdf"
        className="visually-hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void run('Opening PDF…', () => onOpenPdf(f));
        }}
      />
      <input
        ref={projectInput}
        type="file"
        accept={`${BUNDLE_EXTENSION},.json,application/zip`}
        className="visually-hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void run('Opening project…', () => onOpenProjectFile(f));
        }}
      />
      {storageOpen && (
        <StorageDialog
          onClose={() => {
            setStorageOpen(false);
            void refresh();
          }}
        />
      )}
    </main>
  );
}
