import { Download } from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import { downloadBytes } from '../../lib/download';
import { sanitizeFileBase } from '../../lib/export/filenames';
import { replaceField } from '../template-editor/fieldFactory';
import type { TemplateField } from '../../types/project';

function example(f: TemplateField): string {
  if (f.type === 'image') return 'photos/example.jpg';
  if (f.type === 'replace') {
    const joined = f.targets.map((t) => t.text).join('');
    return joined.slice(f.selection.start, f.selection.end);
  }
  return f.sampleValue;
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Suggested spreadsheet layout: one column per field, in reading order, named
 * after the field (editable here), with the original text as an example.
 */
export function SuggestedColumns() {
  const ws = useWorkspace();
  const project = ws.project!;
  const fields = [...project.fields].sort((a, b) => a.page - b.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  if (fields.length === 0) return null;

  const downloadTemplate = () => {
    const header = fields.map((f) => csvCell(f.label)).join(',');
    const row = fields.map((f) => csvCell(example(f))).join(',');
    const bytes = new TextEncoder().encode(`\uFEFF${header}\r\n${row}\r\n`);
    downloadBytes(bytes, `${sanitizeFileBase(project.name) || 'template'} - data.csv`, 'text/csv');
  };

  return (
    <section className="card">
      <header className="card-head row-between">
        <div>
          <h2>Suggested spreadsheet columns</h2>
          <p className="muted">
            One column per field, in reading order. Edit a header to rename the field; matching suggestions use these names. The example comes from the original
            PDF text.
          </p>
        </div>
        <button type="button" className="btn" onClick={downloadTemplate}>
          <Download size={16} /> Download CSV template
        </button>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Column header</th>
              <th scope="col">Field type</th>
              <th scope="col">Example (original)</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={f.id}>
                <td>{i + 1}</td>
                <td>
                  <input
                    type="text"
                    aria-label={`Column header for field ${i + 1}`}
                    value={f.label}
                    maxLength={200}
                    onChange={(e) => ws.update((p) => replaceField(p, { ...f, label: e.target.value }), `${f.id}:label`)}
                  />
                </td>
                <td>{f.type === 'replace' ? 'Replaced PDF text' : f.type === 'image' ? 'Image' : 'Text overlay'}</td>
                <td className="mono">{example(f) || <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
