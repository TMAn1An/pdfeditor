import { useEffect, useRef, useState } from 'react';
import { WorkspaceProvider, useWorkspace, preparePdf, newProjectFor } from '../app/workspace';
import { AppInner } from '../app/App';
import { unpackBundle, packBundle } from '../lib/storage/bundle';
import { GeneratePanel } from './GeneratePanel';
import { makeApi } from './api';
import { readStudioConfig, type StudioConfig } from './config';
import { FieldMappingDialog, type FieldMappingResult } from './FieldMappingDialog';
import '../styles/app.css';

export function StudioApp() {
  const cfg = readStudioConfig();
  if (!cfg) {
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h1>PDF Template Studio</h1>
        <p>This page is meant to be opened from the IEEE IUBAT admin — no integration config was found.</p>
      </div>
    );
  }
  return (
    <WorkspaceProvider>
      <StudioInner cfg={cfg} />
    </WorkspaceProvider>
  );
}

function StudioInner({ cfg }: { cfg: StudioConfig }) {
  const ws = useWorkspace();
  const api = makeApi(cfg);
  const [mode, setMode] = useState<'design' | 'generate'>(cfg.batchId ? 'generate' : 'design');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showMappingDialog, setShowMappingDialog] = useState(false);
  // Forces FieldMappingDialog to remount every time it opens (see its own
  // comment on `rows`): bumped on every openSaveDialog() call so each open
  // starts fresh from the project's current fields instead of whatever they
  // were the first time the dialog ever mounted.
  const [saveDialogKey, setSaveDialogKey] = useState(0);
  const [serverSaveState, setServerSaveState] = useState<'unsaved' | 'saving' | 'saved' | 'error'>('unsaved');
  // Distinct from the base editor's own "Saved in this browser" indicator
  // (workspace.tsx's saveState, driven by the IndexedDB autosave — see
  // TopBar.tsx) -- that one only ever reflects whether the LOCAL draft is
  // persisted, not whether it ever reached the certificate system. A
  // project can be "saved" locally and still be "unsaved" here. Tracked by
  // snapshotting the project at the moment of a successful server save and
  // comparing on every change, rather than by "any ws.project change marks
  // unsaved" (that would immediately re-flip to unsaved right after our own
  // save applies the resolved field mapping onto ws.project).
  const lastServerSavedSnapshot = useRef<string | null>(null);
  useEffect(() => {
    if (!ws.project) return;
    const snapshot = JSON.stringify(ws.project);
    if (lastServerSavedSnapshot.current !== null && snapshot !== lastServerSavedSnapshot.current) {
      setServerSaveState('unsaved');
    }
  }, [ws.project]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (serverSaveState === 'unsaved' || serverSaveState === 'saving' || serverSaveState === 'error') {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [serverSaveState]);

  const loadBundleBytes = async (bytes: Uint8Array | null, label: string) => {
    if (!bytes) {
      setNotice('No project has been saved for this template yet — start designing below and use "Save to server".');
      return;
    }
    const bundle = await unpackBundle(bytes);
    let pdf = null;
    if (bundle.pdfBytes) {
      const result = await preparePdf(bundle.pdfBytes, bundle.project.pdf?.fileName ?? 'template.pdf');
      pdf = result.loaded;
    }
    ws.loadProject(bundle.project, pdf, bundle.fonts);
    // Just pulled from the server, so it's in sync by definition — without
    // this, the dirty-check effect would immediately flag a freshly-loaded
    // project as "unsaved" the moment React applies it.
    lastServerSavedSnapshot.current = JSON.stringify(bundle.project);
    setServerSaveState('saved');
    setNotice(`Loaded "${bundle.project.name}"${label}.`);
  };

  const loadFromServer = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await loadBundleBytes(await api.fetchProject(), '');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Generate mode loads the project PINNED to this batch, not the
  // template's current one, so a template re-save after the batch was
  // created never changes what its remaining rows render. See
  // docs/PDF_STUDIO_INTEGRATION.md's "Batch template immutability".
  const loadForBatch = async (batchId: number) => {
    setBusy(true);
    setNotice(null);
    try {
      await loadBundleBytes(await api.fetchBatchProject(batchId), ' (as saved for this batch)');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Arriving directly on a Generate link (e.g. straight from "Confirm &
  // Generate", a bookmark, or a page refresh) starts with an empty
  // workspace — Generate mode needs the project loaded exactly like Design
  // mode does, so this auto-loads it once rather than asking the admin to
  // flip to Design and click "Load from server" first.
  useEffect(() => {
    if (!cfg.batchId || ws.project) return;
    const timer = setTimeout(() => void loadForBatch(cfg.batchId as number), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.batchId]);

  // A brand-new template, created via the unified "New template" step
  // (name + demo certificate PDF in one form): open Design mode already
  // loaded with that PDF as a fresh, not-yet-saved project, instead of
  // making the admin pick "Choose PDF…" again inside the editor's own
  // Welcome screen. Only fires when there is no batch (Design mode) and no
  // project has been saved yet (cfg.initialPdfUrl is unset once one has).
  useEffect(() => {
    if (cfg.batchId || cfg.initialPdfUrl === null || ws.project) return;
    const timer = setTimeout(async () => {
      setBusy(true);
      setNotice(null);
      try {
        const bytes = await api.fetchInitialPdf(cfg.initialPdfUrl as string);
        const result = await preparePdf(bytes, cfg.templateName);
        const project = newProjectFor(cfg.templateName);
        project.pdf = result.meta;
        project.formFields = result.formFields;
        ws.loadProject(project, result.loaded);
        setNotice('Uploaded PDF loaded — draw the QR field and any text/image fields, then "Save to server".');
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.batchId, cfg.initialPdfUrl]);

  // "Save to server" opens FieldMappingDialog instead of the three
  // window.prompt() calls this used to be (QR field / recipient field /
  // per-field Excel column, each a free-text label match against a
  // prompt() — a typo silently aborted the save). The dialog collects the
  // same three things the Laravel save endpoint has always needed
  // (TemplateProjectService::save() requires qr_field_id, optionally
  // recipient_field_id, and a mapping with real column names), it just
  // does it as a real, validated form instead of three sequential browser
  // dialogs.
  const openSaveDialog = () => {
    if (!ws.project) {
      setNotice('Nothing to save yet.');
      return;
    }
    setNotice(null);
    setSaveDialogKey((k) => k + 1);
    setShowMappingDialog(true);
  };

  const saveToServer = async (result: FieldMappingResult) => {
    if (!ws.project) return;
    setShowMappingDialog(false);
    setBusy(true);
    setServerSaveState('saving');
    setNotice(null);
    try {
      // The editor has no built-in notion of "QR field" or "fixed value set
      // at save time" for the Studio flow — apply exactly what the dialog
      // resolved, the same way the old prompt()-driven code did.
      const nextMapping = { ...ws.project.mapping };
      for (const { id, column } of result.columnAssignments) {
        nextMapping[id] = { kind: 'column' as const, column, transform: 'none' as const };
      }
      for (const { id, value } of result.fixedAssignments) {
        nextMapping[id] = { kind: 'fixed' as const, value };
      }
      ws.setMapping(() => nextMapping, 'studio-column-mapping');
      const projectForBundle = { ...ws.project, mapping: nextMapping };
      const bundleBytes = await packBundle({ project: projectForBundle, pdfBytes: ws.pdf?.bytes ?? null, fonts: ws.fontBytes });
      await api.saveProject(bundleBytes, result.qrFieldId, result.recipientFieldId);
      const columnList = result.columnAssignments.filter((c) => c.id !== result.qrFieldId).map((c) => c.column);
      setNotice(columnList.length ? `Saved to the certificate system. Expected Excel columns: ${columnList.join(', ')}.` : 'Saved to the certificate system. No participant columns configured — every other field is fixed.');
      lastServerSavedSnapshot.current = JSON.stringify(projectForBundle);
      setServerSaveState('saved');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setServerSaveState('error');
    } finally {
      setBusy(false);
    }
  };

  const saveStateLabel: Record<typeof serverSaveState, { text: string; color: string }> = {
    unsaved: { text: 'Not saved to server', color: '#92620a' },
    saving: { text: 'Saving to server…', color: '#555' },
    saved: { text: 'Saved to server', color: '#1a7f37' },
    error: { text: 'Save failed', color: '#c0392b' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #dde3ea', background: '#f8fafc' }}>
        <strong>IEEE IUBAT — PDF Studio</strong>
        <button type="button" onClick={() => setMode('design')} disabled={mode === 'design'}>
          Design
        </button>
        <button type="button" onClick={() => setMode('generate')} disabled={mode === 'generate' || !cfg.batchId} title={!cfg.batchId ? 'Save a project, then upload participants, to unlock Generate' : undefined}>
          Generate{cfg.batchId ? ` (batch #${cfg.batchId})` : ''}
        </button>
        {mode === 'design' && (
          <>
            <button type="button" onClick={loadFromServer} disabled={busy}>
              Load from server
            </button>
            <button type="button" onClick={openSaveDialog} disabled={busy}>
              Save to server
            </button>
            {ws.project && (
              <span style={{ fontSize: '0.85em', color: saveStateLabel[serverSaveState].color, fontWeight: 600 }} role="status">
                {saveStateLabel[serverSaveState].text}
              </span>
            )}
            <a href={cfg.apiBase.replace(/\/api\/pdf-studio$/, '') + `/certificates/studio/${cfg.templateId}/prepare`}>Upload participants &rarr;</a>
          </>
        )}
        {notice && <span style={{ marginLeft: 12, color: '#002855' }}>{notice}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {mode === 'design' ? <AppInner /> : cfg.batchId ? <GeneratePanel cfg={cfg} batchId={cfg.batchId} /> : null}
      </div>
      {ws.project && (
        <FieldMappingDialog key={saveDialogKey} open={showMappingDialog} project={ws.project} onCancel={() => setShowMappingDialog(false)} onConfirm={saveToServer} />
      )}
    </div>
  );
}
