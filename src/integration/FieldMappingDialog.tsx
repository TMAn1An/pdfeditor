import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { IssueList, Labeled } from '../components/ui';
import { suggestColumnName } from './columnMapping';
import { QR_IMAGE_COLUMN } from './config';
import type { TemplateField, TemplateProject } from '../types/project';

/**
 * Replaces the three window.prompt() calls that used to live in
 * StudioApp.tsx's saveToServer() (QR field, recipient field, per-field
 * Excel column name — all free-text label matching with no visual picker).
 * This is specific to the Studio-embedded save step, not the standalone
 * editor's own Data-step MappingTable
 * (src/features/field-mapping/MappingTable.tsx): that component picks a
 * column from an *already-loaded* spreadsheet's real columns, which do not
 * exist yet here — the participant Excel is uploaded to Laravel only after
 * the template is saved (see docs/PDF_STUDIO_INTEGRATION.md in the sibling
 * repo). This dialog instead lets the admin *declare* the column names the
 * certificate system will expect participants' spreadsheets to have.
 */

export type ImageFieldRole = 'qr' | 'photo' | 'unused';
export type TextFieldRole = 'column' | 'fixed' | 'unused';

export interface FieldMappingResult {
  qrFieldId: string;
  recipientFieldId: string | null;
  /** Every text/image field this flow controls, with its resolved outcome. */
  columnAssignments: Array<{ id: string; column: string }>;
  fixedAssignments: Array<{ id: string; value: string }>;
}

interface RowState {
  field: TemplateField;
  imageRole: ImageFieldRole;
  textRole: TextFieldRole;
  column: string;
  fixedValue: string;
}

/**
 * Builds each mappable field's initial row state from the project's current
 * fields/mapping. Pulled out of the component so it can run both at first
 * mount and again whenever the dialog re-opens (see the effect below) --
 * StudioApp keeps one FieldMappingDialog instance alive for the whole
 * session (toggling only its `open` prop, never unmounting it), so a plain
 * lazy useState initializer here would freeze this dialog's fields at
 * whatever the project looked like the first time it was ever opened,
 * silently ignoring any field added, removed or changed afterwards.
 */
function buildRows(mappableFields: TemplateField[], project: TemplateProject): RowState[] {
  return mappableFields.map((field) => {
    const existing = project.mapping[field.id];
    if (field.type === 'image') {
      // A field already wired to the fixed QR_IMAGE_COLUMN sentinel (see
      // config.ts) from a previous save is "the" QR field; anything else
      // with a column mapping is treated as a participant photo so a
      // re-opened save doesn't silently forget it.
      const isQr = existing?.kind === 'column' && existing.column === QR_IMAGE_COLUMN;
      const isPhoto = existing?.kind === 'column' && !isQr;
      return {
        field,
        imageRole: isQr ? 'qr' : isPhoto ? 'photo' : 'unused',
        textRole: 'unused',
        column: isPhoto && existing?.kind === 'column' ? existing.column : suggestColumnName(field.label),
        fixedValue: '',
      } satisfies RowState;
    }
    const isColumn = existing?.kind === 'column';
    const isFixed = existing?.kind === 'fixed';
    return {
      field,
      imageRole: 'unused',
      textRole: isColumn ? 'column' : isFixed ? 'fixed' : 'unused',
      column: isColumn && existing?.kind === 'column' ? existing.column : suggestColumnName(field.label),
      fixedValue: isFixed && existing?.kind === 'fixed' ? existing.value : '',
    } satisfies RowState;
  });
}

export function FieldMappingDialog({
  open,
  project,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  project: TemplateProject;
  onCancel: () => void;
  onConfirm: (result: FieldMappingResult) => void;
}) {
  const mappableFields = useMemo(() => project.fields.filter((f): f is TemplateField => f.type === 'text' || f.type === 'image'), [project.fields]);

  // NOTE: this component must be remounted (via a changing `key` prop) every
  // time it is opened -- see StudioApp.tsx's saveDialogKey. This lazy
  // initializer only runs once per mount, so without a fresh mount per open
  // it would keep showing whatever the project looked like the first time
  // the dialog was ever opened, including reporting "no image field" for a
  // field added after that first open.
  const [rows, setRows] = useState<RowState[]>(() => buildRows(mappableFields, project));

  const imageRows = rows.filter((r) => r.field.type === 'image');
  const textRows = rows.filter((r) => r.field.type === 'text');
  const qrRow = imageRows.find((r) => r.imageRole === 'qr') ?? null;

  const [recipientFieldId, setRecipientFieldId] = useState<string>(() => {
    // No prior "this is the recipient" marker exists in the project format
    // itself (StudioApp previously only ever *sent* it to Laravel, never
    // stored it back) — default to unset, matching prior behavior exactly.
    return '';
  });

  const setRow = (id: string, patch: Partial<RowState>) => setRows((rs) => rs.map((r) => (r.field.id === id ? { ...r, ...patch } : r)));

  const setImageRole = (id: string, role: ImageFieldRole) => {
    setRows((rs) =>
      rs.map((r) => {
        if (r.field.id === id) return { ...r, imageRole: role };
        // Only one field can be the QR code at a time.
        if (role === 'qr' && r.field.type === 'image' && r.imageRole === 'qr') return { ...r, imageRole: 'unused' };
        return r;
      }),
    );
  };

  const usedColumns = new Map<string, string[]>(); // column (lowercased) -> field labels using it
  for (const r of rows) {
    const usesColumn = (r.field.type === 'image' && r.imageRole === 'photo') || (r.field.type === 'text' && r.textRole === 'column');
    if (!usesColumn) continue;
    const key = r.column.trim().toLowerCase();
    if (!key) continue;
    usedColumns.set(key, [...(usedColumns.get(key) ?? []), r.field.label]);
  }

  const issues: { severity: 'error' | 'warning' | 'info'; message: string }[] = [];
  if (imageRows.length === 0) {
    issues.push({ severity: 'error', message: 'Add an image field for the QR code first (Design tab → draw an image box where the QR should go).' });
  } else if (!qrRow) {
    issues.push({ severity: 'error', message: 'Choose which image field is the QR code.' });
  }
  for (const r of rows) {
    const usesColumn = (r.field.type === 'image' && r.imageRole === 'photo') || (r.field.type === 'text' && r.textRole === 'column');
    if (usesColumn && r.column.trim() === '') {
      issues.push({ severity: 'error', message: `"${r.field.label}" is set to use an Excel column, but no column name is entered.` });
    }
  }
  for (const [key, labels] of usedColumns) {
    if (labels.length > 1) {
      issues.push({ severity: 'error', message: `More than one field is mapped to the column "${key}": ${labels.join(', ')}. Each field needs its own column.` });
    }
  }

  const blocking = issues.some((i) => i.severity === 'error');

  const confirm = () => {
    if (blocking || !qrRow) return;
    const columnAssignments: Array<{ id: string; column: string }> = [{ id: qrRow.field.id, column: QR_IMAGE_COLUMN }];
    const fixedAssignments: Array<{ id: string; value: string }> = [];
    for (const r of rows) {
      if (r.field.id === qrRow.field.id) continue;
      if (r.field.type === 'image' && r.imageRole === 'photo') columnAssignments.push({ id: r.field.id, column: r.column.trim() });
      if (r.field.type === 'text' && r.textRole === 'column') columnAssignments.push({ id: r.field.id, column: r.column.trim() });
      if (r.field.type === 'text' && r.textRole === 'fixed') fixedAssignments.push({ id: r.field.id, value: r.fixedValue });
    }
    onConfirm({
      qrFieldId: qrRow.field.id,
      recipientFieldId: recipientFieldId || null,
      columnAssignments,
      fixedAssignments,
    });
  };

  return (
    <Modal
      open={open}
      title="Configure fields before saving"
      onClose={onCancel}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={blocking}>
            Save to server
          </button>
        </>
      }
    >
      <p className="hint">
        Every field below needs to know where its value comes from: a column participants' spreadsheets will have, a fixed value that's the same on every
        certificate, or — for exactly one image field — the system-generated verification QR code.
      </p>

      {imageRows.length > 0 && (
        <>
          <h3>Image fields</h3>
          <div className="table-scroll">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Source</th>
                  <th scope="col">Excel column (for participant photos)</th>
                </tr>
              </thead>
              <tbody>
                {imageRows.map((r) => (
                  <tr key={r.field.id}>
                    <th scope="row">{r.field.label}</th>
                    <td>
                      <select
                        aria-label={`Source for ${r.field.label}`}
                        value={r.imageRole}
                        onChange={(e) => setImageRole(r.field.id, e.target.value as ImageFieldRole)}
                      >
                        <option value="qr">System-generated verification QR</option>
                        <option value="photo">Participant image (uploaded per row)</option>
                        <option value="unused">Unmapped / intentionally unused</option>
                      </select>
                    </td>
                    <td>
                      {r.imageRole === 'photo' ? (
                        <input
                          type="text"
                          aria-label={`Excel column for ${r.field.label}`}
                          value={r.column}
                          onChange={(e) => setRow(r.field.id, { column: e.target.value })}
                          placeholder="e.g. Photo"
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            A participant photo column holds the <em>filename</em> of an uploaded image (e.g. <code>photo1.jpg</code>) — the admin uploads the matching
            image files alongside the spreadsheet on the next step. A spreadsheet cannot point at an arbitrary path on anyone's computer; the server only
            ever reads image bytes it was actually sent.
          </p>
        </>
      )}

      {textRows.length > 0 && (
        <>
          <h3>Text fields</h3>
          <div className="table-scroll">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Source</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {textRows.map((r) => (
                  <tr key={r.field.id}>
                    <th scope="row">{r.field.label}</th>
                    <td>
                      <select aria-label={`Source for ${r.field.label}`} value={r.textRole} onChange={(e) => setRow(r.field.id, { textRole: e.target.value as TextFieldRole })}>
                        <option value="column">Excel column</option>
                        <option value="fixed">Fixed value (same on every certificate)</option>
                        <option value="unused">Unmapped / intentionally unused</option>
                      </select>
                    </td>
                    <td>
                      {r.textRole === 'column' && (
                        <input
                          type="text"
                          aria-label={`Excel column for ${r.field.label}`}
                          value={r.column}
                          onChange={(e) => setRow(r.field.id, { column: e.target.value })}
                        />
                      )}
                      {r.textRole === 'fixed' && (
                        <input
                          type="text"
                          aria-label={`Fixed value for ${r.field.label}`}
                          value={r.fixedValue}
                          onChange={(e) => setRow(r.field.id, { fixedValue: e.target.value })}
                        />
                      )}
                      {r.textRole === 'unused' && <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Labeled label="Recipient name field (shown on the public verification page)">
            {(id) => (
              <select id={id} value={recipientFieldId} onChange={(e) => setRecipientFieldId(e.target.value)}>
                <option value="">None</option>
                {textRows.map((r) => (
                  <option key={r.field.id} value={r.field.id}>
                    {r.field.label}
                  </option>
                ))}
              </select>
            )}
          </Labeled>
        </>
      )}

      <IssueList issues={issues} />
    </Modal>
  );
}
