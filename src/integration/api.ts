import type { StudioConfig } from './config';

export interface ManifestReservation {
  id: number;
  row_index: number;
  status: 'reserved' | 'finalized' | 'failed';
  certificate_number: string;
  codeword: string;
  recipient_name: string | null;
  data: Record<string, string | null>;
  qr_url: string;
  photo_url: string | null;
  error_message: string | null;
}

export interface BatchManifest {
  batch: {
    id: number;
    status: string;
    total_rows: number;
    successful_rows: number;
    failed_rows: number;
  };
  columns: string[];
  /** Maps each editor field id (how `reservations[].data` is keyed) to the project's own column name (how its field mapping looks values up). */
  fields: { id: string; column: string }[];
  reservations: ManifestReservation[];
}

export interface FinalizeResult {
  status: 'finalized' | 'already_finalized' | 'conflict';
  certificate_id: number | null;
  message?: string;
}

export interface ProjectField {
  id: string;
  label: string;
  type: 'text' | 'image' | 'replace';
  required: boolean;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function makeApi(cfg: StudioConfig) {
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.method && init.method !== 'GET') headers.set('X-CSRF-TOKEN', cfg.csrfToken);
    const res = await fetch(`${cfg.apiBase}${path}`, { ...init, headers, credentials: 'same-origin' });
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => '');
      throw new ApiError(text || `Request failed (${res.status})`, res.status);
    }
    return res;
  }

  return {
    /** Fetch the saved .pdftemplate bundle bytes, or null if none saved yet. */
    async fetchProject(): Promise<Uint8Array | null> {
      const res = await request(`/templates/${cfg.templateId}/project`);
      if (res.status === 404) return null;
      return new Uint8Array(await res.arrayBuffer());
    },

    /** Save a .pdftemplate bundle as this template's project, with the field the admin marked as QR and (optionally) recipient name. */
    async saveProject(bundleBytes: Uint8Array, qrFieldId: string, recipientFieldId: string | null): Promise<void> {
      const form = new FormData();
      form.set('project', new Blob([bundleBytes as unknown as BlobPart], { type: 'application/zip' }), 'project.pdftemplate');
      form.set('qr_field_id', qrFieldId);
      if (recipientFieldId) form.set('recipient_field_id', recipientFieldId);
      // PHP never populates $_FILES for a PUT request body, even multipart —
      // only POST. The route stays PUT (semantically a replace), but the
      // actual request uses Laravel's own method-spoofing convention
      // instead of a literal HTTP PUT.
      form.set('_method', 'PUT');
      await request(`/templates/${cfg.templateId}/project`, { method: 'POST', body: form });
    },

    /**
     * Fetch the project bundle PINNED to this batch (immutable: captured at
     * confirm time, never affected by a later template re-save), rather
     * than the template's current project. Generate mode must always use
     * this, not fetchProject(), so an in-flight or resumed batch keeps
     * rendering the design it was created against.
     */
    async fetchBatchProject(batchId: number): Promise<Uint8Array | null> {
      const res = await request(`/batches/${batchId}/project`);
      if (res.status === 404) return null;
      return new Uint8Array(await res.arrayBuffer());
    },

    async fetchManifest(batchId: number): Promise<BatchManifest> {
      const res = await request(`/batches/${batchId}/manifest`);
      return (await res.json()) as BatchManifest;
    },

    /** Fetch a reservation's QR PNG as bytes, to feed into the editor's own image matching. */
    async fetchQrBytes(url: string): Promise<Uint8Array> {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(`Could not load QR image (${res.status})`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    },

    async fetchPhotoBytes(url: string): Promise<Uint8Array> {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(`Could not load photo (${res.status})`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    },

    /** Upload one generated PDF for one reservation. Idempotent server-side. */
    async finalizeReservation(reservationId: number, pdfBytes: Uint8Array): Promise<FinalizeResult> {
      const form = new FormData();
      form.set('pdf', new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' }), `${reservationId}.pdf`);
      const res = await request(`/reservations/${reservationId}/finalize`, { method: 'POST', body: form });
      return (await res.json()) as FinalizeResult;
    },

    batchDownloadUrl(batchId: number): string {
      return `${cfg.apiBase}/batches/${batchId}/download.zip`;
    },
  };
}

export { ApiError };
