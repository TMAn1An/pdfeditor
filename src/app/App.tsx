import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { WorkspaceProvider, useWorkspace } from './workspace';
import { useProjectActions, type PasswordPrompt } from './actions';
import { Welcome } from './Welcome';
import { TopBar } from './TopBar';
import { StorageDialog } from './StorageDialog';
import { isEditableTarget } from './keyboard';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/ui';
import { DesignStep } from '../features/template-editor/DesignStep';
import { DataStep } from '../features/data-import/DataStep';
import { ImagesStep } from '../features/images/ImagesStep';
import { PreviewStep } from '../features/preview/PreviewStep';
import { FontsDialog } from '../features/fonts/FontsDialog';
import { lastProjectId, rememberLastProject } from '../lib/storage/localStore';

export function App() {
  return (
    <WorkspaceProvider>
      <AppInner />
    </WorkspaceProvider>
  );
}

interface PasswordRequest {
  fileName: string;
  retry: boolean;
  resolve: (password: string | null) => void;
}

function AppInner() {
  const ws = useWorkspace();
  const [pwRequest, setPwRequest] = useState<PasswordRequest | null>(null);
  const [restoring, setRestoring] = useState(() => !!lastProjectId());
  const askPassword = useCallback<PasswordPrompt>((fileName, retry) => new Promise((resolve) => setPwRequest({ fileName, retry, resolve })), []);
  const actions = useProjectActions(askPassword);
  const restored = useRef(false);

  // Recover the last open project after a refresh.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const id = lastProjectId();
    if (!id) return;
    actions
      .openStored(id)
      .catch(() => rememberLastProject(null))
      .finally(() => setRestoring(false));
  }, [actions]);

  // Global shortcuts: undo/redo/save (ignored while typing in a text box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !ws.project) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void ws.saveNow();
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        ws.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        ws.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ws]);

  const close = () => {
    if (ws.saveState.status === 'error' && !confirm('The latest changes could not be saved in this browser. Close anyway?')) return;
    ws.loadProject(null, null);
    ws.setSheet(null);
    ws.setWorkbook(null);
    ws.clearImages();
  };

  let body;
  if (restoring) {
    body = (
      <div className="center-fill full">
        <Spinner label="Restoring your last project" />
        <p className="muted">Restoring your last project…</p>
      </div>
    );
  } else if (!ws.project) {
    body = <Welcome onOpenPdf={actions.openPdfFile} onOpenProjectFile={actions.importProjectFile} onOpenStored={actions.openStored} onSample={actions.loadSample} />;
  } else if (!ws.pdf) {
    body = <NeedPdf onPick={(f) => actions.reattachPdf(f, ws.project!)} onClose={close} />;
  } else {
    body = (
      <div className="app-shell">
        <TopBar onExportProject={() => void actions.exportProjectFile()} onOpenFonts={() => ws.setDialog('fonts')} onOpenStorage={() => ws.setDialog('storage')} onClose={close} />
        <main className={`workspace step-${ws.step}`}>
          {ws.step === 'design' && <DesignStep />}
          {ws.step === 'data' && <DataStep />}
          {ws.step === 'images' && <ImagesStep />}
          {ws.step === 'preview' && <PreviewStep />}
        </main>
        {ws.dialog === 'fonts' && <FontsDialog onClose={() => ws.setDialog(null)} />}
        {ws.dialog === 'storage' && (
          <StorageDialog onClose={() => ws.setDialog(null)} onCleared={() => ws.toast('Local data cleared. The open project will be saved again if you keep editing.', 'info')}>
            <label className="check">
              <input
                type="checkbox"
                checked={ws.project.settings.storePdfInBrowser}
                onChange={(e) => ws.update((p) => ({ ...p, settings: { ...p.settings, storePdfInBrowser: e.target.checked } }))}
              />
              Store the PDF of this template in this browser (otherwise you will be asked to select it again when reopening)
            </label>
          </StorageDialog>
        )}
      </div>
    );
  }

  return (
    <>
      {body}
      <PasswordDialog request={pwRequest} onDone={() => setPwRequest(null)} />
      <Toasts />
    </>
  );
}

function NeedPdf({ onPick, onClose }: { onPick: (f: File) => Promise<void>; onClose: () => void }) {
  const ws = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="welcome">
      <div className="welcome-inner narrow">
        <h1>{ws.project!.name}</h1>
        <p>
          This template's PDF is not stored in this browser. Select <strong>{ws.project!.pdf?.fileName ?? 'the original PDF'}</strong> to continue. The app checks that it is the same file.
        </p>
        <div className="row-gap">
          <button type="button" className="btn btn-primary" onClick={() => input.current?.click()}>
            <FileText size={16} /> Select PDF…
          </button>
          <button type="button" className="btn" onClick={onClose}>
            <X size={16} /> Close
          </button>
        </div>
        {error && <p className="callout callout-error">{error}</p>}
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="visually-hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onPick(f).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        />
      </div>
    </main>
  );
}

function PasswordDialog({ request, onDone }: { request: PasswordRequest | null; onDone: () => void }) {
  const [value, setValue] = useState('');
  const finish = (v: string | null) => {
    request?.resolve(v);
    setValue('');
    onDone();
  };
  return (
    <Modal
      open={!!request}
      title="Password required"
      onClose={() => finish(null)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" form="pw-form" className="btn btn-primary">
            Open
          </button>
        </>
      }
    >
      <form
        id="pw-form"
        onSubmit={(e) => {
          e.preventDefault();
          finish(value);
        }}
      >
        <p>
          “{request?.fileName}” is protected. Enter its password to view it. The password is only used in this browser and is not saved.
        </p>
        {request?.retry && (
          <p className="callout callout-error" role="alert">
            That password did not work. Try again.
          </p>
        )}
        <label htmlFor="pdf-password">Password</label>
        <input id="pdf-password" type="password" autoFocus autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <p className="hint">Encrypted PDFs can be viewed, but filled copies cannot be generated from them. Save an unprotected copy first if you need to export.</p>
      </form>
    </Modal>
  );
}

function Toasts() {
  const ws = useWorkspace();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {ws.toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.message}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => ws.dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
