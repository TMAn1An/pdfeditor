import { useRef, useState } from 'react';
import { FileSpreadsheet, Trash2, Upload } from 'lucide-react';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, IssueList, Labeled, NumberInput, Spinner } from '../../components/ui';
import { cellToString, dataFileKind, decodeCsvBytes, parseCsvText, readXlsxWorkbook, sheetFromWorkbook } from '../../lib/spreadsheet/parse';
import { formatBytes, readFileBytes } from '../../lib/download';
import { MappingTable } from '../field-mapping/MappingTable';
import { SuggestedColumns } from '../field-mapping/SuggestedColumns';

const MAX_DATA_FILE = 50 * 1024 * 1024;

export function DataStep() {
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawCsv, setRawCsv] = useState<{ text: string; fileName: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sheet = ws.sheet;

  const load = async (file: File) => {
    setError(null);
    if (file.size > MAX_DATA_FILE) {
      setError(`This file is ${formatBytes(file.size)}. Data files up to 50 MB are supported.`);
      return;
    }
    setBusy(true);
    try {
      const bytes = await readFileBytes(file);
      const kind = dataFileKind(file.name, bytes);
      if (kind === 'unsupported') {
        throw new Error(
          /\.xls$/i.test(file.name)
            ? 'Old .xls files are not supported. Open the file in your spreadsheet app and save it as .xlsx or .csv.'
            : 'Please choose a .xlsx or .csv file.',
        );
      }
      if (kind === 'csv') {
        const text = decodeCsvBytes(bytes);
        setRawCsv({ text, fileName: file.name });
        ws.setWorkbook(null);
        ws.setSheet(parseCsvText(text, file.name, 1));
      } else {
        const wb = await readXlsxWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        setRawCsv(null);
        ws.setWorkbook(wb);
        ws.setSheet(sheetFromWorkbook(wb, file.name, null, 1));
      }
      ws.setCurrentRow(0);
      ws.setSelectedRows(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reparse = (sheetName: string | null, headerRow: number) => {
    if (ws.workbook && sheet) ws.setSheet(sheetFromWorkbook(ws.workbook, sheet.fileName, sheetName, headerRow));
    else if (rawCsv) ws.setSheet(parseCsvText(rawCsv.text, rawCsv.fileName, headerRow));
    ws.setCurrentRow(0);
    ws.setSelectedRows(new Set());
  };

  return (
    <div className="step-page">
      <SuggestedColumns />
      <section className="card">
        <header className="card-head">
          <h2>
            <FileSpreadsheet size={20} aria-hidden /> Data file
          </h2>
          <p className="muted">One output PDF is made per row. The file is read in this browser only and is not saved with the project.</p>
        </header>
        {!sheet ? (
          <div
            className={`dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) void load(f);
            }}
          >
            {busy ? (
              <Spinner label="Reading data file" />
            ) : (
              <>
                <Upload size={28} aria-hidden />
                <p>Drop an Excel (.xlsx) or CSV file here</p>
                <button type="button" className="btn btn-primary" onClick={() => input.current?.click()}>
                  Choose data file…
                </button>
                {ws.project!.knownColumns.length > 0 && (
                  <p className="hint">This template was last used with columns: {ws.project!.knownColumns.slice(0, 8).join(', ')}.</p>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="file-row">
              <strong>{sheet.fileName}</strong>
              <span className="muted">
                {sheet.rows.length} row{sheet.rows.length === 1 ? '' : 's'} · {sheet.columns.length} column{sheet.columns.length === 1 ? '' : 's'}
              </span>
              <button type="button" className="btn btn-small" onClick={() => input.current?.click()}>
                Replace file…
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove data file"
                onClick={() => {
                  ws.setSheet(null);
                  ws.setWorkbook(null);
                  setRawCsv(null);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="grid-2 narrow">
              {sheet.availableSheets.length > 0 && (
                <Labeled label="Worksheet">
                  {(id) => (
                    <select id={id} value={sheet.sheetName ?? ''} onChange={(e) => reparse(e.target.value, sheet.headerRow)}>
                      {sheet.availableSheets.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  )}
                </Labeled>
              )}
              <Labeled label="Header row" hint="The row that contains column names.">
                {(id) => <NumberInput id={id} value={sheet.headerRow} min={1} max={50} onChange={(n) => reparse(sheet.sheetName, Math.round(n))} />}
              </Labeled>
            </div>
            <IssueList issues={sheet.issues} />
            <DataPreview />
          </>
        )}
        {error && (
          <p className="callout callout-error" role="alert">
            {error}
          </p>
        )}
        <input
          ref={input}
          type="file"
          accept=".xlsx,.xlsm,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="visually-hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void load(f);
          }}
        />
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Match fields to data</h2>
          <p className="muted">Choose where each field gets its value. Suggestions are only applied when you click them.</p>
        </header>
        {ws.project!.fields.length === 0 && ws.project!.formFields.length === 0 ? (
          <EmptyState title="No fields yet">
            <p>Add text or image fields on the Design step first.</p>
            <button type="button" className="btn" onClick={() => ws.setStep('design')}>
              Go to Design
            </button>
          </EmptyState>
        ) : (
          <MappingTable />
        )}
      </section>
    </div>
  );
}

function DataPreview() {
  const ws = useWorkspace();
  const sheet = ws.sheet!;
  const rows = sheet.rows.slice(0, 8);
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Data preview">
      <table className="data-table">
        <caption className="visually-hidden">First rows of the data file</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            {sheet.columns.map((c) => (
              <th key={c.key} scope="col" className={c.original ? '' : 'missing-header'}>
                {c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sourceRow}>
              <th scope="row">{r.sourceRow}</th>
              {sheet.columns.map((c) => {
                const v = cellToString(r.values[c.key] ?? null);
                return (
                  <td key={c.key} className={v.trim() === '' ? 'blank' : ''}>
                    {v.trim() === '' ? <span className="visually-hidden">blank</span> : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.rows.length > rows.length && <p className="muted small">…and {sheet.rows.length - rows.length} more rows.</p>}
    </div>
  );
}
