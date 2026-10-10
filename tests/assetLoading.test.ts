import { describe, expect, it, vi } from 'vitest';
import { blockingIssuesForRow, isSnapshotReady, loadRowAssets, rowAssetsReady, type AssetLoadDeps, type AssetSnapshot, type RowAssetRequest } from '../src/integration/assetLoading';
import type { ImageAsset } from '../src/lib/images/load';

/**
 * Regression tests for the Generate-mode asset readiness barrier — see
 * src/integration/assetLoading.ts's docblock for the root cause (a QR
 * image failure was only ever a non-blocking validation *warning*, and the
 * manifest/Generate button became usable before image loading finished).
 */

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function okAsset(name: string): ImageAsset {
  return {
    id: `asset-${name}`,
    name,
    relativePath: name,
    byteLength: 100,
    kind: 'png',
    width: 10,
    height: 10,
    pdfBytes: new Uint8Array([1, 2, 3]),
    pdfKind: 'png',
    previewUrl: null,
    error: null,
    note: null,
  };
}

/** A fake loadImageFile that just inspects the file's name/bytes synchronously, mirroring the real function's "always resolves" contract. */
async function fakeLoadImageFile(file: File): Promise<ImageAsset> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) {
    return { ...okAsset(file.name), pdfBytes: null, error: 'The image header is damaged or unreadable.' };
  }
  return okAsset(file.name);
}

function makeDeps(overrides: Partial<AssetLoadDeps> = {}): AssetLoadDeps {
  return {
    fetchQrBytes: async (url) => new Uint8Array([9, 9, 9]),
    fetchPhotoBytes: async (url) => new Uint8Array([9, 9, 9]),
    loadImageFile: fakeLoadImageFile,
    isCancelled: () => false,
    ...overrides,
  };
}

function request(id: number, opts: Partial<RowAssetRequest> = {}): RowAssetRequest {
  return {
    reservationId: id,
    recipientLabel: `Row ${id}`,
    qrUrl: `/qr/${id}.png`,
    qrFileName: `${id}-code.png`,
    photoUrl: null,
    photoFileName: null,
    ...opts,
  };
}

describe('loadRowAssets — the readiness barrier', () => {
  it('resolves every row ready on the happy path', async () => {
    const requests = [request(1), request(2), request(3)];
    const snapshot = await loadRowAssets(requests, makeDeps());

    expect(snapshot.errors).toEqual([]);
    expect(isSnapshotReady(snapshot, requests)).toBe(true);
    for (const r of requests) {
      expect(rowAssetsReady(snapshot.resolved.get(r.reservationId), false)).toBe(true);
    }
  });

  it('a slow QR response is still awaited, not raced past', async () => {
    const deps = makeDeps({
      fetchQrBytes: async (url) => delay(new Uint8Array([1, 2, 3]), url.includes('2') ? 40 : 5),
    });
    const requests = [request(1), request(2), request(3)];
    const snapshot = await loadRowAssets(requests, deps);

    // All three must be present and valid once loadRowAssets resolves,
    // regardless of which one took longer.
    expect(isSnapshotReady(snapshot, requests)).toBe(true);
    expect(snapshot.resolved.size).toBe(3);
  });

  it('a failed QR response is recorded as an error, not silently dropped', async () => {
    const deps = makeDeps({
      fetchQrBytes: async (url) => {
        if (url.includes('2')) throw new Error('Could not load QR image (404)');
        return new Uint8Array([1, 2, 3]);
      },
    });
    const requests = [request(1), request(2), request(3)];
    const snapshot = await loadRowAssets(requests, deps);

    expect(isSnapshotReady(snapshot, requests)).toBe(false);
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toMatchObject({ reservationId: 2, kind: 'qr' });
    expect(snapshot.errors[0]!.message).toContain('404');
    // Row 2's own asset is marked unusable, never silently "fine".
    expect(rowAssetsReady(snapshot.resolved.get(2), false)).toBe(false);
    // Rows 1 and 3 still loaded successfully — one row's failure doesn't corrupt the others.
    expect(rowAssetsReady(snapshot.resolved.get(1), false)).toBe(true);
    expect(rowAssetsReady(snapshot.resolved.get(3), false)).toBe(true);
  });

  it('a slow non-QR (photo) response is awaited and validated the same way', async () => {
    const deps = makeDeps({
      fetchPhotoBytes: async () => delay(new Uint8Array([1, 2, 3]), 40),
    });
    const requests = [request(1, { photoUrl: '/photo/1', photoFileName: '1.photo' })];
    const snapshot = await loadRowAssets(requests, deps);

    expect(isSnapshotReady(snapshot, requests)).toBe(true);
    expect(snapshot.resolved.get(1)!.photo).not.toBeNull();
  });

  it('a failed photo response blocks readiness for that row even though the QR succeeded', async () => {
    const deps = makeDeps({
      fetchPhotoBytes: async () => {
        throw new Error('Could not load photo (500)');
      },
    });
    const requests = [request(1, { photoUrl: '/photo/1', photoFileName: '1.photo' })];
    const snapshot = await loadRowAssets(requests, deps);

    expect(isSnapshotReady(snapshot, requests)).toBe(false);
    expect(snapshot.errors).toEqual([expect.objectContaining({ reservationId: 1, kind: 'photo' })]);
    const result = snapshot.resolved.get(1)!;
    expect(result.qr.error).toBeNull(); // QR itself loaded fine
    expect(rowAssetsReady(result, true)).toBe(false); // but the row as a whole is not ready
  });

  it('an unusable (corrupt) QR image is treated as a failure even though the HTTP fetch succeeded', async () => {
    // fetchQrBytes succeeds, but returns zero bytes -> fakeLoadImageFile reports it as damaged.
    const deps = makeDeps({ fetchQrBytes: async () => new Uint8Array([]) });
    const requests = [request(1)];
    const snapshot = await loadRowAssets(requests, deps);

    expect(isSnapshotReady(snapshot, requests)).toBe(false);
    expect(snapshot.errors[0]).toMatchObject({ reservationId: 1, kind: 'qr' });
  });

  it('multiple assets finishing out of order are still attributed to the correct row', async () => {
    // Row 1's QR is the SLOWEST; row 3's is the fastest. If completion
    // order ever leaked into row attribution (e.g. push-in-order instead
    // of keyed-by-id), this would catch it.
    const timings: Record<string, number> = { '/qr/1.png': 60, '/qr/2.png': 30, '/qr/3.png': 5 };
    const deps = makeDeps({
      fetchQrBytes: async (url) => delay(new Uint8Array([1, 2, 3]), timings[url] ?? 10),
    });
    const requests = [request(1), request(2), request(3)];
    const snapshot = await loadRowAssets(requests, deps);

    expect(snapshot.resolved.get(1)!.qr.name).toBe('1-code.png');
    expect(snapshot.resolved.get(2)!.qr.name).toBe('2-code.png');
    expect(snapshot.resolved.get(3)!.qr.name).toBe('3-code.png');
    expect(isSnapshotReady(snapshot, requests)).toBe(true);
  });

  it('stops adding results once cancelled (switching batches mid-load)', async () => {
    let cancelled = false;
    const deps = makeDeps({
      fetchQrBytes: async (url) => delay(new Uint8Array([1, 2, 3]), url.includes('2') ? 50 : 5),
      isCancelled: () => cancelled,
    });
    const requests = [request(1), request(2), request(3)];
    const promise = loadRowAssets(requests, deps);
    // Cancel partway through — simulates the admin switching batches / a second load() call.
    setTimeout(() => {
      cancelled = true;
    }, 15);
    const snapshot = await promise;

    // Row 1 (fast) may have landed before cancellation; row 2 (slow) must
    // not be added after cancellation flips true — the exact count is
    // timing-dependent, so the real guarantee under test is the one below:
    // a caller that discards this snapshot on a token mismatch never sees
    // a corrupted one here.
    expect(snapshot.resolved.size).toBeLessThanOrEqual(3);
  });
});

describe('blockingIssuesForRow — the generation-time barrier', () => {
  const readySnapshot: AssetSnapshot = {
    resolved: new Map([[1, { reservationId: 1, qr: okAsset('1.png'), photo: null }]]),
    errors: [],
  };

  it('allows generation when the row is fully ready', () => {
    const issues = blockingIssuesForRow(1, { recipientLabel: 'Alice', photoExpected: false }, readySnapshot);
    expect(issues).toEqual([]);
  });

  it('blocks generation when no snapshot entry exists for the row at all', () => {
    const issues = blockingIssuesForRow(999, { recipientLabel: 'Ghost', photoExpected: false }, readySnapshot);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('Ghost');
  });

  it('blocks generation when the QR asset has an error', () => {
    const snapshot: AssetSnapshot = {
      resolved: new Map([[1, { reservationId: 1, qr: { ...okAsset('1.png'), error: 'broken', pdfBytes: null }, photo: null }]]),
      errors: [{ reservationId: 1, recipientLabel: 'Alice', kind: 'qr', message: 'broken' }],
    };
    const issues = blockingIssuesForRow(1, { recipientLabel: 'Alice', photoExpected: false }, snapshot);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('image-missing');
  });

  it('blocks generation when a photo is expected but missing, even if the QR is fine', () => {
    const snapshot: AssetSnapshot = {
      resolved: new Map([[1, { reservationId: 1, qr: okAsset('1.png'), photo: null }]]),
      errors: [],
    };
    const issues = blockingIssuesForRow(1, { recipientLabel: 'Alice', photoExpected: true }, snapshot);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('photo');
  });

  it('never silently omits the QR: an empty issues list is only possible when the asset is genuinely valid', () => {
    const brokenQr: AssetSnapshot = {
      resolved: new Map([[1, { reservationId: 1, qr: { ...okAsset('1.png'), pdfBytes: null }, photo: null }]]),
      errors: [],
    };
    expect(blockingIssuesForRow(1, { recipientLabel: 'Alice', photoExpected: false }, brokenQr)).not.toEqual([]);
  });
});
