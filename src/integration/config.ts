/**
 * Reads the config Laravel injects into studio.html before serving it (see
 * StudioController in the Laravel repo). Isolated in its own module so the
 * rest of the integration code never touches `document` directly — and so
 * the standalone editor (index.html/main.tsx) never imports this at all.
 */
export interface StudioConfig {
  /** Laravel route base, e.g. "/admin/api/pdf-studio" — same origin, always. */
  apiBase: string;
  /** The certificate_templates.id being edited. */
  templateId: number;
  /** Laravel's CSRF token, sent as X-CSRF-TOKEN on every mutating request. */
  csrfToken: string;
  /** A batch id to resume straight into Generate mode, or null for Design mode. */
  batchId: number | null;
}

export function readStudioConfig(): StudioConfig | null {
  const el = document.getElementById('studio-config');
  if (!el || !el.textContent) return null;
  try {
    const parsed = JSON.parse(el.textContent) as Partial<StudioConfig>;
    if (typeof parsed.apiBase !== 'string' || typeof parsed.templateId !== 'number' || typeof parsed.csrfToken !== 'string') {
      return null;
    }
    return {
      apiBase: parsed.apiBase,
      templateId: parsed.templateId,
      csrfToken: parsed.csrfToken,
      batchId: typeof parsed.batchId === 'number' ? parsed.batchId : null,
    };
  } catch {
    return null;
  }
}
