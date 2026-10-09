import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { clearAllLocalData, storageEstimate } from '../lib/storage/localStore';
import { formatBytes } from '../lib/download';

/** Explains what is stored locally and lets the user wipe it. */
export function StorageDialog({ onClose, onCleared, children }: { onClose: () => void; onCleared?: () => void; children?: React.ReactNode }) {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    storageEstimate()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);
  return (
    <Modal open title="Privacy and local storage" onClose={onClose}>
      <p>This app has no server. Files are processed by your browser and nothing is uploaded.</p>
      <h3>Stored in this browser (IndexedDB)</h3>
      <ul>
        <li>Template layouts: field positions, names, styles and column matches.</li>
        <li>Column names of the last data file (not the data itself).</li>
        <li>The template PDF, unless you turn off “Store the PDF in this browser”.</li>
        <li>Fonts you added.</li>
      </ul>
      <h3>Never stored</h3>
      <ul>
        <li>Spreadsheet rows, photos and generated PDFs. Reloading the page clears them.</li>
      </ul>
      {children}
      {usage && (
        <p className="small muted">
          This site currently uses about {formatBytes(usage.usage)} of browser storage{usage.quota ? ` (limit about ${formatBytes(usage.quota)})` : ''}.
        </p>
      )}
      <button
        type="button"
        className="btn danger"
        onClick={async () => {
          if (!confirm('Delete all templates, stored PDFs and fonts from this browser? This cannot be undone. Export project files first if you want to keep them.')) return;
          try {
            await clearAllLocalData();
            setMessage('All local project data was deleted.');
            onCleared?.();
          } catch (err) {
            setMessage(`Could not clear storage: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        Clear local project data
      </button>
      {message && (
        <p className="callout callout-info" role="status">
          {message}
        </p>
      )}
    </Modal>
  );
}
