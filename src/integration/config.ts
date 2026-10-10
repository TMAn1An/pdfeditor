/**
 * Reads the config Laravel injects into studio.html before serving it (see
 * StudioController in the Laravel repo). Isolated in its own module so the
 * rest of the integration code never touches `document` directly — and so
 * the standalone editor (index.html/main.tsx) never imports this at all.
 */
/**
 * The fixed, well-known column name the QR image is always matched through
 * — a server-generated per-row filename, never something a participant
 * spreadsheet supplies. Shared by StudioApp (writes the field mapping) and
 * GeneratePanel (writes the matching row value) so the two can never drift.
 */
export const QR_IMAGE_COLUMN = '__qr_image__';

export interface StudioConfig {
  /** Laravel route base, e.g. "/admin/api/pdf-studio" — same origin, always. */
  apiBase: string;
  /** The certificate_templates.id being edited. */
  templateId: number;
  /** The template's current name — used only to name a brand-new project; never shown as a control. */
  templateName: string;
  /** Laravel's CSRF token, sent as X-CSRF-TOKEN on every mutating request. */
  csrfToken: string;
  /** A batch id to resume straight into Generate mode, or null for Design mode. */
  batchId: number | null;
  /**
   * Same-origin URL for a just-uploaded "demo certificate" PDF to open as
   * the starting point of a brand-new, not-yet-saved project — set only
   * when the template has no saved PDF Studio project yet. Lets the admin
   * supply the PDF once, at template-creation time (the unified "New
   * template" step), instead of re-selecting it inside the editor's own
   * Welcome screen. Null once a project has been saved (the normal
   * fetchProject() load takes over) or when no PDF was supplied.
   */
  initialPdfUrl: string | null;
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
      templateName: typeof parsed.templateName === 'string' ? parsed.templateName : 'Untitled template',
      csrfToken: parsed.csrfToken,
      batchId: typeof parsed.batchId === 'number' ? parsed.batchId : null,
      initialPdfUrl: typeof parsed.initialPdfUrl === 'string' ? parsed.initialPdfUrl : null,
    };
  } catch {
    return null;
  }
}
