import { useState } from 'react';
import { ScanText } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { ProgressBar } from '../../components/ui';
import { useWorkspace } from '../../app/workspace';
import { languageCodeFromFileName, recognizePage, type OcrLanguage } from '../../lib/ocr/ocr';
import type { ExtractedTextRun } from '../../lib/pdf/pdfjs';
import { formatBytes, readFileBytes } from '../../lib/download';

interface Props {
  currentPage: number;
  imageOnlyPages: number[];
  onClose: () => void;
  onResult: (page: number, runs: ExtractedTextRun[]) => void;
}

/** Language data stays in memory for this tab only (never uploaded, never stored). */
let rememberedLanguages: OcrLanguage[] = [];

export function OcrDialog({ currentPage, imageOnlyPages, onClose, onResult }: Props) {
  const ws = useWorkspace();
  const [languages, setLanguages] = useState<OcrLanguage[]>(rememberedLanguages);
  const [scope, setScope] = useState<'current' | 'scanned'>(imageOnlyPages.includes(currentPage) || imageOnlyPages.length === 0 ? 'current' : 'scanned');
  const [status, setStatus] = useState<{ text: string; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const addLanguage = async (files: FileList | null) => {
    setError(null);
    for (const f of Array.from(files ?? [])) {
      const code = languageCodeFromFileName(f.name);
      if (!code) {
        setError(`“${f.name}” is not a Tesseract language file. Its name should look like “eng.traineddata” or “ben.traineddata”.`);
        continue;
      }
      const data = await readFileBytes(f);
      setLanguages((l) => {
        const next = [...l.filter((x) => x.code !== code), { code, data }];
        rememberedLanguages = next;
        return next;
      });
    }
  };

  const run = async () => {
    if (!ws.pdf || languages.length === 0) return;
    const pages = scope === 'current' ? [currentPage] : imageOnlyPages;
    setError(null);
    setDone(null);
    let total = 0;
    try {
      for (const [i, n] of pages.entries()) {
        const page = await ws.pdf.doc.getPage(n);
        const lines = await recognizePage(page, languages, (text, progress) =>
          setStatus({ text: `Page ${n} (${i + 1} of ${pages.length}): ${text}`, progress: (i + progress) / pages.length }),
        );
        total += lines.length;
        onResult(
          n,
          lines.map((l, k) => ({
            id: `ocr-${n}-${k}`,
            page: n,
            text: l.text,
            rect: l.rect,
            fontSize: l.fontSize,
            fontName: '',
            fontFamily: '',
            source: 'ocr',
            confidence: l.confidence,
          })),
        );
      }
      setDone(
        `Recognized ${total} line${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}. They are shown as boxes when “PDF text” is on.`,
      );
    } catch (err) {
      setError(`OCR failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStatus(null);
    }
  };

  return (
    <Modal
      open
      title="OCR for scanned pages (optional)"
      onClose={() => !status && onClose()}
      locked={!!status}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={!!status}>
            {done ? 'Close' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={!!status || languages.length === 0}>
            <ScanText size={16} /> Recognize text
          </button>
        </>
      }
    >
      <p>
        OCR reads text from page images so you can see where things are on a scanned page. It runs entirely in this browser with Tesseract. Results are{' '}
        <strong>suggestions only</strong> and often contain mistakes; nothing is changed in your PDF.
      </p>
      <fieldset className="group">
        <legend>Language data</legend>
        <p className="small">
          Tesseract needs a language file. This app does not download it for you. Get it yourself from the official <code>tessdata_fast</code> repository
          (github.com/tesseract-ocr/tessdata_fast), e.g. <code>eng.traineddata</code> for English or <code>ben.traineddata</code> for Bangla, then select it
          here.
        </p>
        <label className="btn btn-small">
          Choose .traineddata file…
          <input
            type="file"
            accept=".traineddata,.gz"
            multiple
            className="visually-hidden"
            onChange={(e) => void addLanguage(e.target.files).finally(() => (e.target.value = ''))}
          />
        </label>
        {languages.length > 0 && (
          <ul className="small">
            {languages.map((l) => (
              <li key={l.code}>
                {l.code} ({formatBytes(l.data.byteLength)})
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <fieldset className="group">
        <legend>Pages</legend>
        <label className="check">
          <input type="radio" name="ocr-scope" checked={scope === 'current'} onChange={() => setScope('current')} /> Current page ({currentPage})
        </label>
        <label className="check">
          <input type="radio" name="ocr-scope" checked={scope === 'scanned'} disabled={imageOnlyPages.length === 0} onChange={() => setScope('scanned')} /> All
          pages without selectable text ({imageOnlyPages.length})
        </label>
      </fieldset>
      <p className="hint">The OCR engine (about 4 MB) is loaded from this app only when you press “Recognize text”. Large pages can take a minute.</p>
      {status && (
        <div>
          <ProgressBar value={status.progress} max={1} label="OCR progress" />
          <p className="small">{status.text}</p>
        </div>
      )}
      {error && (
        <p className="callout callout-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="callout callout-info" role="status">
          {done}
        </p>
      )}
    </Modal>
  );
}
