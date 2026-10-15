import { useRef, useState } from 'react';
import { useWorkspace } from '../app/workspace';
import { useRenderContext } from '../features/preview/useRowStatus';
import { planRow } from '../lib/render/plan';
import { generateFilledPdf } from '../lib/render/generate';
import { runBatch } from '../lib/export/batch';
import { loadImageFile } from '../lib/images/load';
import { newId } from '../lib/id';
import type { SheetData, SheetColumn, SheetRow } from '../types/project';
import { makeApi, type ManifestReservation, type BatchManifest } from './api';
import { QR_IMAGE_COLUMN, type StudioConfig } from './config';
import { loadRowAssets, isSnapshotReady, blockingIssuesForRow, type AssetLoadStatus, type AssetSnapshot, type RowAssetRequest } from './assetLoading';

type RowState = 'pending' | 'rendering' | 'uploading' | 'done' | 'error';

interface Props {
  cfg: StudioConfig;
  batchId: number;
}

const EMPTY_SNAPSHOT: AssetSnapshot = { resolved: new Map(), errors: [] };

/**
 * Generate mode: loads a batch's rows + QR (and, where present, participant
 * photo) images from Laravel into the SAME workspace the Design tab edits,
 * then drives the editor's own, completely unmodified render pipeline
 * (`planRow` + `generateFilledPdf`, batched by `runBatch` — the exact
 * functions `ExportDialog` uses) and uploads each resulting PDF to Laravel
 * automatically. No manual spreadsheet/QR-zip/PDF-zip handoff anywhere in
 * this flow — see docs/PDF_STUDIO_INTEGRATION.md.
 *
 * Asset readiness barrier (see assetLoading.ts's docblock for the root
 * cause this closes): generation is gated on `assetStatus === 'ready'`,
 * which is only reached after `loadRowAssets()` has fetched AND validated
 * every row's QR (and photo, if any) — not merely after the manifest
 * fetch resolves. The resulting `AssetSnapshot` is immutable (a fresh Map
 * built once, never mutated) and is re-checked inside `generate()`'s own
 * `blockingIssues` callback, per row, so a missing/broken asset can never
 * reach `generateFilledPdf` regardless of what UI state let the admin
 * click the button. A monotonic `loadToken` discards any load's results
 * that are no longer the most recent attempt (switching batches, a second
 * "Load batch" click, StrictMode double-invoke) before they touch state.
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

  const [assetStatus, setAssetStatus] = useState<AssetLoadStatus>('idle');
  const [assetProgress, setAssetProgress] = useState({ done: 0, total: 0 });
  const [assetSnapshot, setAssetSnapshot] = useState<AssetSnapshot>(EMPTY_SNAPSHOT);

  // Stale-response guard: incremented at the start of every load() call.
  // Every state-affecting continuation checks it still matches before
  // applying results, so a slower, older attempt can never clobber a
  // newer one (switching batches, a second click, remount) — see
  // assetLoading.ts's isCancelled() contract.
  const loadToken = useRef(0);
  // Synchronous re-entrancy guard for generate() — see its own comment.
  const runningRef = useRef(false);

  const load = async () => {
    const myToken = ++loadToken.current;
    const isStale = () => loadToken.current !== myToken;

    setLoadingManifest(true);
    setLoadError(null);
    setAssetStatus('idle');
    setAssetSnapshot(EMPTY_SNAPSHOT);
    setAssetProgress({ done: 0, total: 0 });
    try {
      const m = await api.fetchManifest(batchId);
      if (isStale()) return;
      setManifest(m);

      if (!ws.project) {
        setLoadError('Open or load this template’s project first (Design tab).');
        return;
      }

      // Build synthetic sheet data: columns come straight from the
      // manifest (the same column names the template's own field mapping
      // already references — see docs/PDF_STUDIO_INTEGRATION.md), plus one
      // QR-image column and (optional) one photo column per row, matched
      // to real image assets by filename exactly like any other image
      // field. Each reservation's `data` is keyed by editor FIELD ID (the
      // stable identifier used everywhere else `data` is read), but the
      // project's own field mapping looks values up by COLUMN NAME — so
      // every value is re-keyed through `m.fields` before it reaches the
      // unmodified render engine (`planRow` expects `row.values[column]`).
      const qrColumn = QR_IMAGE_COLUMN;
      const photoColumn = '__photo_image__';
      const columns: SheetColumn[] = [...m.columns, qrColumn, photoColumn].map((key, index) => ({ key, original: key, index }));
      const columnByFieldId = new Map(m.fields.map((f) => [f.id, f.column]));

      const toFinalize = m.reservations.filter((r) => r.status !== 'finalized');
      const rows: SheetRow[] = m.reservations.map((r) => {
        const values: SheetRow['values'] = {};
        for (const [fieldId, value] of Object.entries(r.data)) {
          const column = columnByFieldId.get(fieldId);
          if (column) values[column] = value;
        }
        values[qrColumn] = `${r.codeword}.png`;
        values[photoColumn] = r.photo_url ? `${r.id}.photo` : null;
        return { sourceRow: r.row_index + 2, values };
      });

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

      const initialStates: Record<number, RowState> = {};
      m.reservations.forEach((r) => {
        initialStates[r.id] = r.status === 'finalized' ? 'done' : 'pending';
      });
      setRowStates(initialStates);
      setDone(m.reservations.length - toFinalize.length);

      // Asset readiness barrier: fetch + validate every not-yet-finalized
      // row's QR (and photo, if any) BEFORE generation can be enabled.
      // "Load batch" visibly finishing the manifest step is not the same
      // as being ready — the manifest/row table is shown already (above)
      // for progress feedback, but assetStatus stays 'loading' until this
      // resolves, and `generate()` is independently guarded on it too.
      const requests: RowAssetRequest[] = toFinalize.map((r) => ({
        reservationId: r.id,
        recipientLabel: r.recipient_name ?? r.certificate_number,
        qrUrl: r.qr_url,
        qrFileName: `${r.codeword}.png`,
        photoUrl: r.photo_url,
        photoFileName: r.photo_url ? `${r.id}.photo` : null,
      }));

      setAssetStatus('loading');
      setAssetProgress({ done: 0, total: requests.reduce((n, r) => n + 1 + (r.photoUrl ? 1 : 0), 0) });

      const snapshot = await loadRowAssets(requests, {
        fetchQrBytes: api.fetchQrBytes,
        fetchPhotoBytes: api.fetchPhotoBytes,
        loadImageFile,
        isCancelled: isStale,
        onProgress: (p, total) => {
          if (!isStale()) setAssetProgress({ done: p, total });
        },
      });
      if (isStale()) return;

      // addImages() still gets every successfully-loaded asset (even if a
      // sibling row failed) so the Design/Preview tabs can inspect them —
      // only the *generate* gate below depends on the snapshot being
      // fully ready.
      const loadedAssets = Array.from(snapshot.resolved.values()).flatMap((r) => [r.qr, ...(r.photo ? [r.photo] : [])]);
      ws.addImages(loadedAssets);

      setAssetSnapshot(snapshot);
      setAssetStatus(isSnapshotReady(snapshot, requests) ? 'ready' : 'error');
    } catch (err) {
      if (isStale()) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      setAssetStatus('error');
    } finally {
      if (!isStale()) setLoadingManifest(false);
    }
  };

  const generate = async () => {
    // Guards repeated/overlapping clicks and stale readiness: even if the
    // button's `disabled` attribute hasn't re-rendered yet, this function
    // re-checks the real state itself (see docs/PDF_STUDIO_INTEGRATION.md's
    // "Asset readiness barrier" — rule 5: validated in the handler, not
    // only via a disabled button). `runningRef` (not the `running` STATE)
    // is the actual re-entrancy guard: several synchronous clicks on the
    // same button (a double/triple-click, or a programmatic repeat) each
    // call generate() within the same tick, before React has re-rendered
    // `running` from the first call's setRunning(true) — a `useState`
    // guard alone would let every one of them read the same stale
    // `running === false` and start its own runBatch(). A ref mutates
    // synchronously, so the second call always sees the first one's flag.
    if (runningRef.current) return;
    if (assetStatus !== 'ready') return;
    if (!manifest || !ctx || !ws.pdf) return;

    // Captured once, used for the whole run: an immutable snapshot, not a
    // live reference to state that could change mid-batch.
    const snapshot = assetSnapshot;

    runningRef.current = true;
    setRunning(true);
    const pending = manifest.reservations.filter((r) => rowStates[r.id] !== 'done');
    const pdfBytes = ws.pdf.bytes;

    // Identify which project field is the QR field (its mapping points at
    // the fixed QR column) so the per-row check below can also confirm the
    // unmodified render engine's OWN image resolution agrees with our
    // snapshot — defense in depth, not a replacement for it.
    const qrFieldId = Object.entries(ws.project?.mapping ?? {}).find(([, source]) => source.kind === 'column' && source.column === QR_IMAGE_COLUMN)?.[0] ?? null;

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
        // The actual barrier for THIS run of generation: never trust that
        // "Generate" was only reachable because assets were ready — check
        // this row's own snapshot entry again, right before it would be
        // rendered. A row whose QR (or expected photo) isn't valid here is
        // marked failed and never reaches generateFilledPdf, no matter
        // what state got the button enabled.
        blockingIssues: ({ rowIndex }) => {
          const reservation = pending[rowIndex]!;
          return blockingIssuesForRow(
            reservation.id,
            { recipientLabel: reservation.recipient_name ?? reservation.certificate_number, photoExpected: reservation.photo_url !== null },
            snapshot,
          );
        },
        generate: async ({ rowIndex }) => {
          const reservation = pending[rowIndex]!;
          setRowStates((s) => ({ ...s, [reservation.id]: 'rendering' }));
          const sheetRowIndex = manifest.reservations.indexOf(reservation);
          const row = ws.sheet!.rows[sheetRowIndex]!;
          const plan = planRow(ctx, row, sheetRowIndex);

          // Defense in depth: confirm the render engine's own resolution
          // of the QR field agrees an asset was actually attached, not
          // just that our snapshot thought it would be.
          if (qrFieldId) {
            const qrImagePlan = plan.images.find((i) => i.field.id === qrFieldId);
            if (qrImagePlan && !qrImagePlan.asset) {
              throw new Error(`QR code did not resolve in the render plan for ${reservation.recipient_name ?? reservation.certificate_number} — this certificate was not generated.`);
            }
          }

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
    runningRef.current = false;
    setRunning(false);
  };

  const total = manifest?.reservations.length ?? 0;
  const assetsLoading = assetStatus === 'loading';
  const assetsFailed = assetStatus === 'error';
  const generateDisabled = running || !ctx || done >= total || assetStatus !== 'ready';
  const pendingCount = total - done;
  const batchesUrl = cfg.apiBase.replace(/\/api\/pdf-studio$/, '') + `/pdf-certificates/${cfg.templateId}/batches`;

  const handleGenerateClick = () => {
    // A confirmation only for starting a *fresh* run (nothing finalized
    // yet) -- resuming a partially-finalized batch (a reload, a retry
    // after fixing an image error) needs no extra click, since it isn't
    // the moment real certificates first get minted. See
    // docs/PDF_STUDIO_INTEGRATION.md's "Prevent accidental duplicate
    // generation" requirement.
    if (done === 0 && total > 0) {
      const ok = window.confirm(`Generate ${total} certificate${total === 1 ? '' : 's'} now? Each one gets a permanent certificate number and verification code.`);
      if (!ok) return;
    }
    void generate();
  };

  const STATE_LABEL: Record<RowState, { text: string; className: string }> = {
    pending: { text: 'Pending', className: 'pill-muted' },
    rendering: { text: 'Rendering…', className: 'pill' },
    uploading: { text: 'Uploading…', className: 'pill' },
    done: { text: 'Done', className: 'pill-ok' },
    error: { text: 'Failed', className: 'pill-warn' },
  };

  return (
    <div style={{ padding: 20, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Generate &amp; download — batch #{batchId}</h2>
        <a href={batchesUrl} className="btn btn-small">
          View all batches for this template &rarr;
        </a>
      </div>

      {!manifest && (
        <button type="button" className="btn btn-primary" onClick={load} disabled={loadingManifest} style={{ marginTop: 12 }}>
          {loadingManifest ? 'Loading…' : 'Load batch'}
        </button>
      )}
      {loadError && <p className="callout callout-error">{loadError}</p>}

      {manifest && (
        <>
          <p className={`callout ${done >= total ? 'callout-info' : 'callout-info'}`} style={{ marginTop: 14 }}>
            <strong>
              {done} of {total} certificate{total === 1 ? '' : 's'} finalized
            </strong>
            {pendingCount > 0 && ` · ${pendingCount} remaining`}
          </p>

          {total > 0 && (
            <div aria-hidden="true" style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden', margin: '4px 0 14px' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.round((done / total) * 100)}%`,
                  background: done >= total ? 'var(--ok)' : 'var(--primary)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          )}

          {assetsLoading && (
            <p className="callout callout-info">
              Loading QR/photo images: {assetProgress.done} / {assetProgress.total}…
            </p>
          )}
          {assetsFailed && assetSnapshot.errors.length > 0 && (
            <div className="callout callout-error" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <p style={{ margin: '0 0 4px', fontWeight: 600 }}>
                {assetSnapshot.errors.length} image{assetSnapshot.errors.length === 1 ? '' : 's'} failed to load. Generation is disabled until this is resolved.
              </p>
              <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                {assetSnapshot.errors.map((e, i) => (
                  <li key={i}>
                    {e.kind === 'qr' ? 'QR code' : 'Photo'} for {e.recipientLabel}: {e.message}
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-small" onClick={load} disabled={loadingManifest || assetsLoading}>
                Retry loading images
              </button>
            </div>
          )}

          <button type="button" className="btn btn-primary" onClick={handleGenerateClick} disabled={generateDisabled}>
            {running ? 'Generating…' : done >= total ? 'All rows finalized' : assetsLoading ? 'Waiting for images…' : assetsFailed ? 'Fix image errors first' : `Generate ${pendingCount} remaining`}
          </button>

          <div className="table-scroll" style={{ marginTop: 14 }}>
            <table className="mapping-table">
              <thead>
                <tr>
                  <th scope="col">Recipient</th>
                  <th scope="col">Status</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {manifest.reservations.map((r: ManifestReservation) => {
                  const state = rowStates[r.id] ?? 'pending';
                  const label = STATE_LABEL[state];
                  return (
                    <tr key={r.id}>
                      <th scope="row">{r.recipient_name ?? r.certificate_number}</th>
                      <td>
                        <span className={`pill ${label.className}`}>{label.text}</span>
                      </td>
                      <td className="muted">{rowErrors[r.id] ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {done === total && total > 0 && (
            <p className="callout callout-info" style={{ marginTop: 14 }}>
              <span>
                All certificates generated. <a href={api.batchDownloadUrl(batchId)}>Download the completed batch (ZIP) &rarr;</a> You can also find this
                batch again later from <a href={batchesUrl}>this template&apos;s batch history</a>.
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
