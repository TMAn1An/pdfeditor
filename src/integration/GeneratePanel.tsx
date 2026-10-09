import { useState } from 'react';
import { useWorkspace } from '../app/workspace';
import { useRenderContext } from '../features/preview/useRowStatus';
import { planRow } from '../lib/render/plan';
import { generateFilledPdf } from '../lib/render/generate';
import { runBatch } from '../lib/export/batch';
import { loadImageFile } from '../lib/images/load';
import { newId } from '../lib/id';
import type { SheetData, SheetColumn, SheetRow } from '../types/project';
import { makeApi, type ManifestReservation, type BatchManifest } from './api';
import type { StudioConfig } from './config';

type RowState = 'pending' | 'rendering' | 'uploading' | 'done' | 'error';

interface Props {
  cfg: StudioConfig;
  batchId: number;
}

/**
 * Generate mode: loads a batch's rows + QR (and, where present, participant
 * photo) images from Laravel into the SAME workspace the Design tab edits,
 * then drives the editor's own, completely unmodified render pipeline
 * (`planRow` + `generateFilledPdf`, batched by `runBatch` — the exact
 * functions `ExportDialog` uses) and uploads each resulting PDF to Laravel
 * automatically. No manual spreadsheet/QR-zip/PDF-zip handoff anywhere in
 * this flow — see docs/PDF_STUDIO_INTEGRATION.md.
 *
 * `runBatch` processes rows strictly one at a time (see
 * src/lib/export/batch.ts) — generation and upload are therefore already
 * naturally bounded to concurrency 1, satisfying the "small bounded
 * requests, not one giant request" requirement without extra machinery.
 */
export function GeneratePanel({ cfg, batchId }: Props) {
  const ws = useWorkspace();
  const ctx = useRenderContext();
  const api = makeApi(cfg);

  const [manifest, setManifest] = useState<BatchManifest | null>(null);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoadingManifest(true);
    setLoadError(null);
    try {
      const m = await api.fetchManifest(batchId);
      setManifest(m);

      if (!ws.project) {
        setLoadError('Open or load this template’s project first (Design tab).');
        return;
      }

      // Build synthetic sheet data: columns come straight from the
      // manifest (the same column names the template's own field mapping
      // already references — see docs/PDF_STUDIO_INTEGRATION.md), values
      // come from each reservation's server-owned `data`, plus one
      // QR-image column and (optional) one photo column per row, matched
      // to real image assets by filename exactly like any other image
      // field.
      const qrColumn = '__qr_image__';
      const photoColumn = '__photo_image__';
      const columns: SheetColumn[] = [...m.columns, qrColumn, photoColumn].map((key, index) => ({ key, original: key, index }));

      const toFinalize = m.reservations.filter((r) => r.status !== 'finalized');
      const rows: SheetRow[] = m.reservations.map((r) => ({
        sourceRow: r.row_index + 2,
        values: { ...r.data, [qrColumn]: `${r.codeword}.png`, [photoColumn]: r.photo_url ? `${r.id}.photo` : null },
      }));

      const sheet: SheetData = {
        fileName: `batch-${batchId}.xlsx`,
        sheetName: null,
        availableSheets: [],
        headerRow: 1,
        columns,
        rows,
        issues: [],
      };
      ws.setSheet(sheet);

      // Load QR + photo images for not-yet-finalized rows only (resume: a
      // completed row's image was already consumed in an earlier session
      // and need not be re-fetched).
      const assets = [];
      for (const r of toFinalize) {
        const qrBytes = await api.fetchQrBytes(r.qr_url);
        const qrFile = new File([qrBytes as unknown as BlobPart], `${r.codeword}.png`, { type: 'image/png' });
        assets.push(await loadImageFile(qrFile));
        if (r.photo_url) {
          const photoBytes = await api.fetchPhotoBytes(r.photo_url);
          const photoFile = new File([photoBytes as unknown as BlobPart], `${r.id}.photo`, { type: 'image/jpeg' });
          assets.push(await loadImageFile(photoFile));
        }
      }
      ws.addImages(assets);

      const initialStates: Record<number, RowState> = {};
      m.reservations.forEach((r) => {
        initialStates[r.id] = r.status === 'finalized' ? 'done' : 'pending';
      });
      setRowStates(initialStates);
      setDone(m.reservations.length - toFinalize.length);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingManifest(false);
    }
  };

  const generate = async () => {
    if (!manifest || !ctx || !ws.pdf) return;
    setRunning(true);
    const pending = manifest.reservations.filter((r) => rowStates[r.id] !== 'done');
    const pdfBytes = ws.pdf.bytes;

    await runBatch(
      {
        job: {
          id: newId('job'),
          rowIndexes: pending.map((_r, i) => i),
          options: { scope: 'valid', fileNamePattern: '{codeword}', formMode: 'flatten', zip: false },
          startedAt: Date.now(),
        },
        rows: pending.map((r, i) => ({ rowIndex: i, row: ws.sheet!.rows[manifest.reservations.indexOf(r)]! })),
        templateName: manifest.batch.id.toString(),
      },
      {
        generate: async ({ rowIndex }) => {
          const reservation = pending[rowIndex]!;
          setRowStates((s) => ({ ...s, [reservation.id]: 'rendering' }));
          const sheetRowIndex = manifest.reservations.indexOf(reservation);
          const row = ws.sheet!.rows[sheetRowIndex]!;
          const plan = planRow(ctx, row, sheetRowIndex);
          const out = await generateFilledPdf({
            templateBytes: pdfBytes,
            plan,
            formMode: 'flatten',
            formFieldFont: ws.project!.settings.formFieldFont,
            fontBytes: (id) => ws.fontBytes.get(id),
            title: ws.project!.name,
          });

          setRowStates((s) => ({ ...s, [reservation.id]: 'uploading' }));
          const result = await api.finalizeReservation(reservation.id, out.bytes);
          if (result.status === 'conflict') {
            throw new Error(result.message ?? 'This row was already finalized with a different PDF.');
          }
          setRowStates((s) => ({ ...s, [reservation.id]: 'done' }));
          setDone((d) => d + 1);
          return { bytes: out.bytes, warnings: out.issues };
        },
        onProgress: (_done, _total, last) => {
          if (last.status === 'failed') {
            const reservation = pending[last.rowIndex];
            if (reservation) {
              setRowStates((s) => ({ ...s, [reservation.id]: 'error' }));
              setRowErrors((e) => ({ ...e, [reservation.id]: last.error }));
            }
          }
        },
        yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
      },
    );
    setRunning(false);
  };

  const total = manifest?.reservations.length ?? 0;

  return (
    <div style={{ padding: 16, maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>Generate — batch #{batchId}</h2>
      {!manifest && (
        <button type="button" onClick={load} disabled={loadingManifest}>
          {loadingManifest ? 'Loading…' : 'Load batch'}
        </button>
      )}
      {loadError && <p style={{ color: '#b42318' }}>{loadError}</p>}
      {manifest && (
        <>
          <p>
            {done} / {total} finalized.
          </p>
          <button type="button" onClick={generate} disabled={running || !ctx || done >= total}>
            {running ? 'Generating…' : done >= total ? 'All rows finalized' : 'Generate remaining'}
          </button>
          <table style={{ marginTop: 12, width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {manifest.reservations.map((r: ManifestReservation) => (
                <tr key={r.id}>
                  <td>{r.recipient_name ?? r.certificate_number}</td>
                  <td>{rowStates[r.id] ?? 'pending'}</td>
                  <td style={{ color: '#b42318' }}>{rowErrors[r.id] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {done === total && total > 0 && (
            <p>
              <a href={api.batchDownloadUrl(batchId)}>Download completed batch (ZIP)</a>
            </p>
          )}
        </>
      )}
    </div>
  );
}
