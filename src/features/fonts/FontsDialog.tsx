import { useMemo, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Labeled } from '../../components/ui';
import { useWorkspace } from '../../app/workspace';
import { inspectFontFile, registerBrowserFont, unregisterBrowserFont, cssFamilyFor } from '../../lib/fonts/upload';
import { STANDARD_FONTS } from '../../lib/fonts/standard';
import type { FontRef } from '../../types/project';
import { readFileBytes } from '../../lib/download';
import { hasRtl } from '../../lib/text/runs';

const DEFAULT_SAMPLE = 'আমার সোনার বাংলা · শিক্ষার্থী ২০২৪ · Hello, World 123';

export function FontsDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const project = ws.project!;
  const [sample, setSample] = useState(DEFAULT_SAMPLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const bytes = await readFileBytes(file);
        try {
          const asset = await inspectFontFile(bytes, file.name);
          await registerBrowserFont(asset.id, bytes).catch(() => undefined);
          ws.setFontBytes((m) => m.set(asset.id, bytes));
          ws.update((p) => ({ ...p, fonts: [...p.fonts, asset] }));
          ws.toast(`Added font “${asset.name}”.`, 'success');
        } catch (err) {
          setError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string) => {
    const ref = `custom:${id}` as FontRef;
    const users = project.fields.filter((f) => f.type === 'text' && (f.style.font === ref || f.style.fallbackFont === ref));
    if (users.length && !confirm(`${users.length} field(s) use this font. They will switch to Helvetica. Remove the font?`)) return;
    ws.update((p) => ({
      ...p,
      fonts: p.fonts.filter((f) => f.id !== id),
      fields: p.fields.map((f) =>
        f.type === 'text'
          ? {
              ...f,
              style: {
                ...f.style,
                font: f.style.font === ref ? 'std:Helvetica' : f.style.font,
                fallbackFont: f.style.fallbackFont === ref ? null : f.style.fallbackFont,
              },
            }
          : f,
      ),
      settings: { ...p.settings, formFieldFont: p.settings.formFieldFont === ref ? 'std:Helvetica' : p.settings.formFieldFont },
    }));
    ws.setFontBytes((m) => {
      m.delete(id);
      return m;
    });
    ws.fonts.forget(ref);
    unregisterBrowserFont(id);
  };

  const coverage = useMemo(() => {
    if (!ws.fontsReady) return new Map<string, string[]>();
    const out = new Map<string, string[]>();
    for (const f of project.fonts) {
      const ref = `custom:${f.id}` as FontRef;
      if (!ws.fonts.isPrepared(ref)) continue;
      out.set(f.id, ws.fonts.stack(ref, null).missing(sample));
    }
    return out;
  }, [project.fonts, ws.fonts, ws.fontsReady, sample]);
  const stdMissing = useMemo(() => (ws.fontsReady ? ws.fonts.stack('std:Helvetica', null).missing(sample) : []), [ws.fonts, ws.fontsReady, sample]);

  return (
    <Modal open wide title="Fonts" onClose={onClose}>
      <p>
        The built-in PDF fonts (Helvetica, Times, Courier) only cover Western European letters. For Bangla, other scripts or a specific look, add a{' '}
        <strong>.ttf</strong> or <strong>.otf</strong> font file from your computer. Fonts are embedded in the generated PDFs and are stored in this browser
        with the project. Check that the font's license allows embedding.
      </p>
      <div className="row-gap wrap">
        <label className={`btn btn-primary${busy ? ' disabled' : ''}`}>
          <Upload size={16} /> {busy ? 'Reading…' : 'Add font file…'}
          <input
            type="file"
            accept=".ttf,.otf,font/ttf,font/otf"
            multiple
            className="visually-hidden"
            disabled={busy}
            onChange={(e) => void upload(e.target.files).finally(() => (e.target.value = ''))}
          />
        </label>
        <span className="muted small">
          Example: Noto Sans Bengali (free, SIL Open Font License) from fonts.google.com — download it yourself; this app never fetches fonts.
        </span>
      </div>
      {error && (
        <p className="callout callout-error" role="alert">
          {error}
        </p>
      )}
      {ws.fontsError && <p className="callout callout-error">{ws.fontsError}</p>}

      <Labeled label="Test text" hint="Check which characters each font can draw.">
        {(id) => <input id={id} type="text" value={sample} onChange={(e) => setSample(e.target.value)} />}
      </Labeled>

      <table className="font-table">
        <thead>
          <tr>
            <th scope="col">Font</th>
            <th scope="col">Sample</th>
            <th scope="col">Missing characters</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">
              Helvetica <span className="muted small">(built-in)</span>
            </th>
            <td style={{ fontFamily: STANDARD_FONTS[0]!.css }}>{sample}</td>
            <td>{stdMissing.length ? <span className="sev-error">{stdMissing.slice(0, 20).join(' ')}</span> : <span className="sev-ok">None</span>}</td>
            <td />
          </tr>
          {project.fonts.map((f) => {
            const loaded = ws.fontBytes.has(f.id);
            const missing = coverage.get(f.id) ?? [];
            return (
              <tr key={f.id}>
                <th scope="row">
                  {f.name}
                  <br />
                  <span className="muted small">
                    {f.fileName} · {f.glyphCount} glyphs
                  </span>
                </th>
                <td style={{ fontFamily: `"${cssFamilyFor(f.id)}", sans-serif` }}>
                  {loaded ? sample : <span className="sev-error">Not loaded — add the file again</span>}
                </td>
                <td>
                  {!loaded ? (
                    '—'
                  ) : missing.length ? (
                    <span className="sev-warning">{missing.slice(0, 20).join(' ')}</span>
                  ) : (
                    <span className="sev-ok">None</span>
                  )}
                </td>
                <td>
                  <button type="button" className="icon-btn danger" aria-label={`Remove font ${f.name}`} onClick={() => remove(f.id)}>
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {project.fonts.length > 0 && (
        <p className="hint">
          Missing characters can come from a fallback font: set “Fallback font” on a text field (e.g. Bangla font + Helvetica for English).
        </p>
      )}

      {project.formFields.length > 0 && (
        <Labeled label="Font for existing PDF form fields" hint="Used to draw values into the PDF's own form fields.">
          {(id) => (
            <select
              id={id}
              value={project.settings.formFieldFont}
              onChange={(e) => ws.update((p) => ({ ...p, settings: { ...p.settings, formFieldFont: e.target.value as FontRef } }))}
            >
              {STANDARD_FONTS.map((s) => (
                <option key={s.id} value={`std:${s.id}`}>
                  {s.label}
                </option>
              ))}
              {project.fonts
                .filter((f) => ws.fontBytes.has(f.id))
                .map((f) => (
                  <option key={f.id} value={`custom:${f.id}`}>
                    {f.name}
                  </option>
                ))}
            </select>
          )}
        </Labeled>
      )}

      <details className="limits">
        <summary>How text shaping works and its limits</summary>
        <ul>
          <li>
            Uploaded fonts are shaped with HarfBuzz (running locally as WebAssembly), so Bangla conjuncts, vowel signs and mark positions follow the font's
            OpenType rules.
          </li>
          <li>
            If a character is not in the field's font or its fallback font, the row is flagged and not exported — characters are never silently replaced with
            boxes.
          </li>
          <li>
            Right-to-left scripts (Arabic, Hebrew) are supported for simple lines; complex mixed-direction text with embedded numbers and punctuation may be
            ordered imperfectly.{hasRtl(sample) ? ' Your test text contains right-to-left characters.' : ''}
          </li>
          <li>Fonts are embedded in full (not subset), so large fonts make larger PDFs.</li>
          <li>Editable (non-flattened) form fields are drawn by the PDF viewer, which may not shape complex scripts.</li>
        </ul>
      </details>
    </Modal>
  );
}
