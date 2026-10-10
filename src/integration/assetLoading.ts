import type { ImageAsset } from '../lib/images/load';
import type { ValidationIssue } from '../types/project';

/**
 * The readiness barrier for PDF Studio's Generate mode — see
 * docs/PDF_STUDIO_INTEGRATION.md's "Asset readiness barrier" (IEEE repo).
 *
 * Root cause this closes: GeneratePanel used to call `setManifest(m)`
 * (making the row table, and the "Generate remaining" button, visible)
 * BEFORE its QR/photo image-fetch loop had finished — a real admin reading
 * the screen usually outran that gap, but nothing actually blocked
 * clicking Generate sooner. Worse, even once loading finished, a QR image
 * that failed to fetch/decode was only ever recorded as a non-blocking
 * *validation warning* (`checkAsset()` in `lib/render/plan.ts` treats a
 * missing image as `severity: field.required ? 'error' : 'warning'` — and
 * the QR field is not required, since "required" there means "this
 * optional field can be left blank", not "this certificate is useless
 * without it"). GeneratePanel never inspected `plan.issues` at all, so a
 * row with a missing QR would render and finalize as a normal, successful
 * PDF with a blank QR box.
 *
 * This module is therefore the actual barrier — not just a loading
 * spinner — and `GeneratePanel` enforces it twice: once to gate the
 * Generate button, and again, independently, inside the per-row
 * `blockingIssues` check the render pipeline already supports, so a
 * missing/invalid QR can never reach `generateFilledPdf` no matter what UI
 * state got the admin to click Generate.
 */

export type AssetLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RowAssetRequest {
  reservationId: number;
  /** For error messages only — never used to resolve/match the asset. */
  recipientLabel: string;
  qrUrl: string;
  qrFileName: string;
  photoUrl: string | null;
  photoFileName: string | null;
}

export interface ResolvedRowAssets {
  reservationId: number;
  /** Always present once resolved; check `.error`/`.pdfBytes` for validity — never absent-means-ok. */
  qr: ImageAsset;
  /** Null only when this row has no photo field at all (not merely "not loaded yet"). */
  photo: ImageAsset | null;
}

export interface RowAssetError {
  reservationId: number;
  recipientLabel: string;
  kind: 'qr' | 'photo';
  message: string;
}

/** An immutable snapshot of every row's resolved assets, handed to generation as-is — see docs/PDF_STUDIO_INTEGRATION.md. */
export interface AssetSnapshot {
  resolved: ReadonlyMap<number, ResolvedRowAssets>;
  errors: readonly RowAssetError[];
}

export interface AssetLoadDeps {
  fetchQrBytes: (url: string) => Promise<Uint8Array>;
  fetchPhotoBytes: (url: string) => Promise<Uint8Array>;
  loadImageFile: (file: File) => Promise<ImageAsset>;
  /**
   * Checked before each state-affecting step. Returning true abandons the
   * load (already-settled network requests are not aborted — only their
   * results are discarded by the caller, see GeneratePanel's load token).
   */
  isCancelled: () => boolean;
  onProgress?: (done: number, total: number) => void;
  /** Bounded concurrency so a large batch doesn't fire hundreds of requests at once. Default 6. */
  concurrency?: number;
}

function brokenAsset(name: string, message: string): ImageAsset {
  return {
    id: `broken-${name}-${Math.random().toString(36).slice(2)}`,
    name,
    relativePath: name,
    byteLength: 0,
    kind: 'unknown',
    width: 0,
    height: 0,
    pdfBytes: null,
    pdfKind: null,
    previewUrl: null,
    error: message,
    note: null,
  };
}

async function fetchOneImage(
  url: string,
  fileName: string,
  mimeType: string,
  fetchBytes: (url: string) => Promise<Uint8Array>,
  loadImageFile: AssetLoadDeps['loadImageFile'],
): Promise<ImageAsset> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(url);
  } catch (err) {
    return brokenAsset(fileName, err instanceof Error ? err.message : String(err));
  }
  const file = new File([bytes as unknown as BlobPart], fileName, { type: mimeType });
  return loadImageFile(file);
}

/**
 * Runs a list of async jobs with at most `limit` in flight at once,
 * collecting results by index — correct regardless of which job settles
 * first (see the "multiple assets finishing out of order" regression
 * test), since each result is written to its own fixed slot, never
 * appended in completion order.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Fetches and validates every required image asset (QR always, photo when
 * present) for a set of rows, returning a single immutable snapshot. Never
 * throws for an individual asset failure — a bad QR for one row is
 * recorded in `errors` and does not stop the others from loading, but it
 * DOES make the overall load non-`ready` (see `isSnapshotReady`): nothing
 * downstream decides "this one row's failure is fine, generate the rest"
 * on its own — that decision belongs to the admin via the UI's error list
 * and an explicit retry, not an automatic partial pass.
 */
export async function loadRowAssets(requests: RowAssetRequest[], deps: AssetLoadDeps): Promise<AssetSnapshot> {
  const resolved = new Map<number, ResolvedRowAssets>();
  const errors: RowAssetError[] = [];
  const total = requests.reduce((n, r) => n + 1 + (r.photoUrl ? 1 : 0), 0);
  let done = 0;
  const concurrency = deps.concurrency ?? 6;

  if (deps.isCancelled()) return { resolved, errors };

  await mapWithConcurrency(requests, concurrency, async (req) => {
    if (deps.isCancelled()) return;

    const qr = await fetchOneImage(req.qrUrl, req.qrFileName, 'image/png', deps.fetchQrBytes, deps.loadImageFile);
    if (qr.error || !qr.pdfBytes) {
      errors.push({ reservationId: req.reservationId, recipientLabel: req.recipientLabel, kind: 'qr', message: qr.error ?? 'QR image could not be prepared for the PDF.' });
    }
    done++;
    deps.onProgress?.(done, total);

    let photo: ImageAsset | null = null;
    if (req.photoUrl && req.photoFileName && !deps.isCancelled()) {
      photo = await fetchOneImage(req.photoUrl, req.photoFileName, 'image/jpeg', deps.fetchPhotoBytes, deps.loadImageFile);
      if (photo.error || !photo.pdfBytes) {
        errors.push({ reservationId: req.reservationId, recipientLabel: req.recipientLabel, kind: 'photo', message: photo.error ?? 'Photo could not be prepared for the PDF.' });
      }
      done++;
      deps.onProgress?.(done, total);
    }

    if (!deps.isCancelled()) {
      resolved.set(req.reservationId, { reservationId: req.reservationId, qr, photo });
    }
  });

  return { resolved, errors };
}

/** Whether every requested row has a valid, loaded QR (and photo, if expected) in this snapshot. */
export function isSnapshotReady(snapshot: AssetSnapshot, requests: RowAssetRequest[]): boolean {
  if (snapshot.errors.length > 0) return false;
  return requests.every((req) => rowAssetsReady(snapshot.resolved.get(req.reservationId), req.photoUrl !== null));
}

/** Whether one row's resolved assets are actually usable — never "absent means fine". */
export function rowAssetsReady(result: ResolvedRowAssets | undefined, photoExpected: boolean): boolean {
  if (!result) return false;
  if (result.qr.error || !result.qr.pdfBytes) return false;
  if (photoExpected && (!result.photo || result.photo.error || !result.photo.pdfBytes)) return false;
  return true;
}

export interface BlockingIssueRow {
  recipientLabel: string;
  photoExpected: boolean;
}

/**
 * The actual per-row generation barrier — used by GeneratePanel's
 * `runBatch` `blockingIssues` callback, and unit-tested directly here so
 * the decision ("does this row's PDF get generated at all") is verified
 * independent of any React rendering. Re-checks the snapshot fresh for
 * every row; never assumes "no entry" means "skip the check".
 */
export function blockingIssuesForRow(reservationId: number, row: BlockingIssueRow, snapshot: AssetSnapshot): ValidationIssue[] {
  const result = snapshot.resolved.get(reservationId);
  if (rowAssetsReady(result, row.photoExpected)) return [];

  const issues: ValidationIssue[] = [];
  if (!result || result.qr.error || !result.qr.pdfBytes) {
    issues.push({
      code: 'image-missing',
      severity: 'error',
      message: `QR code image was not successfully loaded for ${row.recipientLabel} — this certificate was not generated. ${result?.qr.error ?? 'No QR asset was resolved for this row.'}`,
    });
  }
  if (row.photoExpected && (!result?.photo || result.photo.error || !result.photo.pdfBytes)) {
    issues.push({
      code: 'image-missing',
      severity: 'error',
      message: `Participant photo was not successfully loaded for ${row.recipientLabel} — this certificate was not generated. ${result?.photo?.error ?? 'No photo asset was resolved for this row.'}`,
    });
  }
  return issues;
}
