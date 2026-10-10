import { useEffect, useState } from 'react';
import { WorkspaceProvider, useWorkspace, preparePdf } from '../app/workspace';
import { AppInner } from '../app/App';
import { unpackBundle, packBundle } from '../lib/storage/bundle';
import { GeneratePanel } from './GeneratePanel';
import { makeApi } from './api';
import { QR_IMAGE_COLUMN, readStudioConfig, type StudioConfig } from './config';
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

  const saveToServer = async () => {
    if (!ws.project) {
      setNotice('Nothing to save yet.');
      return;
    }
    const imageFields = ws.project.fields.filter((f) => f.type === 'image');
    if (imageFields.length === 0) {
      setNotice('Add an image field for the QR code before saving (Design tab → draw an image box where the QR should go).');
      return;
    }
    const qrLabel = prompt(`Which image field is the QR code? Type its exact label:\n${imageFields.map((f) => f.label).join(', ')}`, imageFields[0]!.label);
    const qrField = imageFields.find((f) => f.label === qrLabel);
    if (!qrField) {
      setNotice('Save cancelled — no matching QR field.');
      return;
    }
    const textFields = ws.project.fields.filter((f) => f.type === 'text');
    const recipientLabel = textFields.length
      ? prompt(
          `Which text field is the recipient's name (shown on the public verification page)? Leave blank to skip.\n${textFields.map((f) => f.label).join(', ')}`,
          textFields[0]!.label,
        )
      : null;
    const recipientField = textFields.find((f) => f.label === recipientLabel);

    setBusy(true);
    setNotice(null);
    try {
      // The editor has no built-in notion of "QR field" — its own Data
      // step was never used to map this field to a column. Set that
      // mapping here, to the fixed column GeneratePanel always provides a
      // value for, so the unmodified render engine actually draws the QR
      // image instead of silently treating the field as unmapped.
      ws.setMapping((m) => ({ ...m, [qrField.id]: { kind: 'column', column: QR_IMAGE_COLUMN, transform: 'none' } }), 'studio-qr-mapping');
      const projectForBundle = {
        ...ws.project,
        mapping: { ...ws.project.mapping, [qrField.id]: { kind: 'column' as const, column: QR_IMAGE_COLUMN, transform: 'none' as const } },
      };
      const bundleBytes = await packBundle({ project: projectForBundle, pdfBytes: ws.pdf?.bytes ?? null, fonts: ws.fontBytes });
      await api.saveProject(bundleBytes, qrField.id, recipientField?.id ?? null);
      setNotice('Saved to the certificate system.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #dde3ea', background: '#f8fafc' }}>
        <strong>IEEE IUBAT — PDF Studio</strong>
        <button type="button" onClick={() => setMode('design')} disabled={mode === 'design'}>
          Design
        </button>
        <button type="button" onClick={() => setMode('generate')} disabled={mode === 'generate' || !cfg.batchId}>
          Generate{cfg.batchId ? ` (batch #${cfg.batchId})` : ''}
        </button>
        {mode === 'design' && (
          <>
            <button type="button" onClick={loadFromServer} disabled={busy}>
              Load from server
            </button>
            <button type="button" onClick={saveToServer} disabled={busy}>
              Save to server
            </button>
            <a href={cfg.apiBase.replace(/\/api\/pdf-studio$/, '') + `/certificates/studio/${cfg.templateId}/prepare`}>Upload participants &rarr;</a>
          </>
        )}
        {notice && <span style={{ marginLeft: 12, color: '#002855' }}>{notice}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {mode === 'design' ? <AppInner /> : cfg.batchId ? <GeneratePanel cfg={cfg} batchId={cfg.batchId} /> : null}
      </div>
    </div>
  );
}
