import type { FieldSource } from '../../types/project';

/**
 * The fixed, well-known column name the QR image is always matched through
 * when a project is saved from the Laravel-embedded Studio integration — a
 * server-generated per-row filename, never something a participant
 * spreadsheet supplies. Defined here (core) rather than in
 * integration/config.ts so describeSource() below can recognize it without
 * a core -> integration import; integration/config.ts re-exports this same
 * constant so existing Studio code is unaffected. See that file's own doc
 * comment for the full picture (shared by StudioApp and GeneratePanel so
 * the two can never drift).
 */
export const QR_IMAGE_COLUMN = '__qr_image__';

/** Short human description of where a field's value comes from. */
export function describeSource(s: FieldSource | undefined): string {
  if (!s || s.kind === 'none') return 'Not matched yet';
  switch (s.kind) {
    case 'column':
      // The sentinel column Studio's save flow uses to mark "this image
      // field is the system-generated verification QR" -- showing it as a
      // literal "Column "__qr_image__"" would be meaningless internal
      // detail to an admin looking at the Properties panel.
      if (s.column === QR_IMAGE_COLUMN) return 'System-generated verification QR';
      return `Column “${s.column}”`;
    case 'fixed':
      return `Fixed text “${s.value.slice(0, 40)}”`;
    case 'template':
      return `Text template “${s.template.slice(0, 40)}”`;
    case 'date':
      return s.from === 'today' ? `Today's date (${s.format})` : `Date from “${s.from.column}”`;
    case 'fixed-image':
      return 'The same image on every row';
  }
}
