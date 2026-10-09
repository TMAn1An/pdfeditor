import { useMemo } from 'react';
import { FileInput, Image as ImageIcon, Lightbulb, Type } from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import type { FieldSource, TemplateProject, TextTransform } from '../../types/project';
import { suggestAll, type MappingSuggestion } from '../../lib/mapping/suggest';
import { resolveText, templatePlaceholders } from '../../lib/mapping/values';
import { formTarget, templateIssues } from '../../lib/render/plan';
import { IssueList } from '../../components/ui';

interface Target {
  id: string;
  label: string;
  kind: 'text' | 'image' | 'form';
  formKind?: string;
  required: boolean;
  options?: string[];
}

function mappingTargets(project: TemplateProject): Target[] {
  return [
    ...project.fields.map((f) => ({ id: f.id, label: f.label, kind: f.type === 'image' ? 'image' : 'text', required: f.required }) as Target),
    ...project.formFields
      .filter((f) => f.fillable)
      .map((f) => ({ id: formTarget(f.name), label: f.name, kind: 'form', formKind: f.kind, required: f.required, options: f.options }) as Target),
  ];
}

const TRANSFORMS: { value: TextTransform; label: string }[] = [
  { value: 'none', label: 'As is' },
  { value: 'trim', label: 'Trim spaces' },
  { value: 'upper', label: 'UPPERCASE' },
  { value: 'lower', label: 'lowercase' },
  { value: 'title', label: 'Title Case' },
  { value: 'bengali-digits', label: 'Bangla digits (০১২)' },
];

const DATE_FORMATS = ['D MMMM YYYY', 'Do MMMM YYYY', 'MMMM D, YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY'];

export function MappingTable() {
  const ws = useWorkspace();
  const project = ws.project!;
  const columns = useMemo(() => ws.sheet?.columns.map((c) => c.key) ?? project.knownColumns, [ws.sheet, project.knownColumns]);
  const targets = useMemo(() => mappingTargets(project), [project]);
  const suggestions = useMemo(() => {
    const map = new Map<string, MappingSuggestion>();
    for (const s of suggestAll(
      targets.map((t) => ({ target: t.id, label: t.label })),
      columns,
    ))
      map.set(s.target, s);
    return map;
  }, [targets, columns]);
  const row = ws.sheet?.rows[ws.currentRow] ?? ws.sheet?.rows[0] ?? null;
  const issues = useMemo(() => templateIssues(project, ws.sheet ? columns : null), [project, ws.sheet, columns]);

  const unmappedConfident = targets.filter((t) => {
    const s = project.mapping[t.id];
    return (!s || s.kind === 'none') && suggestions.get(t.id)?.confident;
  });

  const setSource = (id: string, source: FieldSource, key?: string) => ws.setMapping((m) => ({ ...m, [id]: source }), key ? `map:${id}:${key}` : undefined);

  return (
    <div className="mapping">
      {columns.length === 0 && (
        <p className="callout callout-info">Load a data file above to match fields to columns. You can still use fixed text, templates or dates.</p>
      )}
      {unmappedConfident.length > 0 && (
        <div className="callout callout-info suggestion-bar">
          <Lightbulb size={16} aria-hidden />
          <span>
            {unmappedConfident.length} field{unmappedConfident.length === 1 ? ' has' : 's have'} one clear matching column.
          </span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              ws.setMapping((m) => {
                const next = { ...m };
                for (const t of unmappedConfident) {
                  const c = suggestions.get(t.id)!.candidates[0]!;
                  next[t.id] = { kind: 'column', column: c.column, transform: 'none' };
                }
                return next;
              })
            }
          >
            Use these {unmappedConfident.length} suggestion{unmappedConfident.length === 1 ? '' : 's'}
          </button>
        </div>
      )}
      <IssueList issues={issues.filter((i) => i.code === 'unmapped-required' || i.code === 'unused-column')} />
      <div className="table-scroll">
        <table className="mapping-table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value comes from</th>
              <th scope="col">Details</th>
              <th scope="col">{row ? `Row ${row.sourceRow} gives` : 'Result'}</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => {
              const source = project.mapping[t.id] ?? { kind: 'none' };
              const sug = suggestions.get(t.id);
              const preview = t.kind === 'image' ? imagePreview(source, row?.values) : resolveText(source, row).value;
              return (
                <tr key={t.id} className={t.required && source.kind === 'none' ? 'row-error' : ''}>
                  <th scope="row">
                    <span className="target-name">
                      {t.kind === 'text' ? (
                        <Type size={15} aria-hidden />
                      ) : t.kind === 'image' ? (
                        <ImageIcon size={15} aria-hidden />
                      ) : (
                        <FileInput size={15} aria-hidden />
                      )}
                      {t.label}
                      {t.required && (
                        <span className="req" title="Required">
                          {' '}
                          *
                        </span>
                      )}
                    </span>
                    {t.kind === 'form' && <span className="badge badge-form">PDF form {t.formKind}</span>}
                  </th>
                  <td>
                    <select
                      aria-label={`Source for ${t.label}`}
                      value={source.kind}
                      onChange={(e) => {
                        const kind = e.target.value as FieldSource['kind'];
                        const first = sug?.candidates[0]?.column ?? columns[0] ?? '';
                        const next: FieldSource =
                          kind === 'column'
                            ? { kind, column: first, transform: 'none' }
                            : kind === 'fixed'
                              ? { kind, value: '' }
                              : kind === 'template'
                                ? { kind, template: columns.length ? `{${first}}` : '', transform: 'none' }
                                : kind === 'date'
                                  ? { kind, from: 'today', format: 'D MMMM YYYY', transform: 'none' }
                                  : kind === 'fixed-image'
                                    ? { kind, imageId: ws.images[0]?.id ?? '' }
                                    : { kind: 'none' };
                        setSource(t.id, next);
                      }}
                    >
                      <option value="none">— Not filled —</option>
                      <option value="column" disabled={columns.length === 0}>
                        A column
                      </option>
                      {t.kind !== 'image' && <option value="fixed">Fixed text</option>}
                      {t.kind !== 'image' && <option value="template">Text with columns</option>}
                      {t.kind !== 'image' && <option value="date">A date</option>}
                      {t.kind === 'image' && <option value="fixed-image">Same image for every row</option>}
                    </select>
                  </td>
                  <td>
                    <SourceDetails target={t} source={source} columns={columns} setSource={(s, key) => setSource(t.id, s, key)} />
                    {source.kind === 'none' && sug && sug.candidates.length > 0 && (
                      <div className="sugg">
                        <span className="muted small">{sug.confident ? 'Suggested:' : 'Several possible columns:'}</span>
                        {sug.candidates.slice(0, sug.confident ? 1 : 3).map((c) => (
                          <button
                            type="button"
                            key={c.column}
                            className="chip"
                            title={`${c.reason === 'exact' ? 'Same name' : c.reason === 'synonym' ? 'Similar meaning' : 'Similar spelling'} (${Math.round(c.score * 100)}%)`}
                            onClick={() => setSource(t.id, { kind: 'column', column: c.column, transform: 'none' })}
                          >
                            Use “{c.column}”
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="preview-cell">{preview ? <span>{preview}</span> : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">
        The same column can fill several fields. Text with columns uses {'{Column name}'} placeholders, e.g. “Dr. {'{First Name}'} {'{Last Name}'}”.
      </p>
    </div>
  );
}

function imagePreview(source: FieldSource, values?: Record<string, unknown>): string {
  if (source.kind === 'column') return values ? String(values[source.column] ?? '') : '';
  if (source.kind === 'fixed-image') return 'Fixed image';
  return '';
}

function SourceDetails({
  target,
  source,
  columns,
  setSource,
}: {
  target: Target;
  source: FieldSource;
  columns: string[];
  setSource: (s: FieldSource, key?: string) => void;
}) {
  const ws = useWorkspace();
  const transformSelect = (value: TextTransform, onChange: (t: TextTransform) => void) =>
    target.kind !== 'image' && (
      <select aria-label={`Text change for ${target.label}`} value={value} onChange={(e) => onChange(e.target.value as TextTransform)}>
        {TRANSFORMS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    );
  switch (source.kind) {
    case 'column': {
      const known = columns.includes(source.column);
      return (
        <div className="details">
          <select
            aria-label={`Column for ${target.label}`}
            value={known ? source.column : ''}
            onChange={(e) => setSource({ ...source, column: e.target.value })}
          >
            {!known && <option value="">“{source.column}” (not in this file)</option>}
            {columns.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          {transformSelect(source.transform, (t) => setSource({ ...source, transform: t }))}
          {target.kind !== 'image' && (
            <select
              aria-label={`Treat ${target.label} as a date`}
              value={source.dateFormat ?? ''}
              onChange={(e) => setSource({ ...source, dateFormat: e.target.value || undefined })}
            >
              <option value="">Not a date</option>
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  Date: {f}
                </option>
              ))}
            </select>
          )}
          {target.kind === 'form' && target.options && target.options.length > 0 && (
            <span className="hint">Allowed values: {target.options.slice(0, 8).join(', ')}</span>
          )}
        </div>
      );
    }
    case 'fixed':
      return (
        <input
          type="text"
          aria-label={`Fixed text for ${target.label}`}
          value={source.value}
          onChange={(e) => setSource({ ...source, value: e.target.value }, 'fixed')}
        />
      );
    case 'template': {
      const unknown = templatePlaceholders(source.template).filter((p) => columns.length > 0 && !columns.some((c) => c.toLowerCase() === p.toLowerCase()));
      return (
        <div className="details">
          <input
            type="text"
            aria-label={`Text template for ${target.label}`}
            value={source.template}
            onChange={(e) => setSource({ ...source, template: e.target.value }, 'template')}
          />
          {transformSelect(source.transform, (t) => setSource({ ...source, transform: t }))}
          {columns.length > 0 && (
            <select
              aria-label="Insert a column placeholder"
              value=""
              onChange={(e) => {
                if (e.target.value) setSource({ ...source, template: `${source.template}{${e.target.value}}` });
              }}
            >
              <option value="">Insert column…</option>
              {columns.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
          {unknown.length > 0 && <span className="hint sev-warning">Unknown: {unknown.map((u) => `{${u}}`).join(', ')}</span>}
        </div>
      );
    }
    case 'date':
      return (
        <div className="details">
          <select
            aria-label={`Date source for ${target.label}`}
            value={source.from === 'today' ? '' : source.from.column}
            onChange={(e) => setSource({ ...source, from: e.target.value ? { column: e.target.value } : 'today' })}
          >
            <option value="">Today's date</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                Column “{c}”
              </option>
            ))}
          </select>
          <input
            type="text"
            list="date-formats"
            aria-label="Date format"
            value={source.format}
            onChange={(e) => setSource({ ...source, format: e.target.value }, 'datefmt')}
          />
          <datalist id="date-formats">
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {transformSelect(source.transform, (t) => setSource({ ...source, transform: t }))}
          <span className="hint">YYYY year, MMMM month name, MM month, DD day, Do 1st/2nd.</span>
        </div>
      );
    case 'fixed-image':
      return ws.images.length === 0 ? (
        <span className="hint">
          Add images on the{' '}
          <button type="button" className="link-btn" onClick={() => ws.setStep('images')}>
            Images step
          </button>{' '}
          first.
        </span>
      ) : (
        <select aria-label={`Image for ${target.label}`} value={source.imageId} onChange={(e) => setSource({ ...source, imageId: e.target.value })}>
          <option value="">Choose…</option>
          {ws.images
            .filter((i) => !i.error)
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.relativePath}
              </option>
            ))}
        </select>
      );
    default:
      return null;
  }
}
