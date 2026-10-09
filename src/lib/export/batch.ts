import type { ExportJob, ExportResult, ExportSummary, SheetRow, ValidationIssue } from '../../types/project';
import { applyFileNamePattern, FileNameAllocator } from './filenames';

/**
 * Runs an export job row by row. Each row is generated independently: if one
 * row fails, its error is recorded and the job continues. Successful outputs
 * are kept in the results list as soon as they are produced.
 */

export interface BatchRowInput {
  rowIndex: number;
  row: SheetRow | null;
}

export interface BatchCallbacks {
  /** Validate and generate one row. Throwing marks only this row as failed. */
  generate: (input: BatchRowInput) => Promise<{ bytes: Uint8Array; warnings: ValidationIssue[] }>;
  /** Return blocking problems for a row (errors), or an empty list. */
  blockingIssues?: (input: BatchRowInput) => ValidationIssue[];
  onProgress?: (done: number, total: number, last: ExportResult) => void;
  isCancelled?: () => boolean;
  /** Yield to the browser between rows so the page stays responsive. */
  yieldToUi?: () => Promise<void>;
}

export interface BatchConfig {
  job: ExportJob;
  rows: BatchRowInput[];
  templateName: string;
}

export class RowBlockedError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((i) => i.message).join(' '));
  }
}

export async function runBatch(config: BatchConfig, cb: BatchCallbacks): Promise<ExportSummary> {
  const names = new FileNameAllocator();
  const results: ExportResult[] = [];
  let cancelled = false;
  let done = 0;
  for (const input of config.rows) {
    if (cb.isCancelled?.()) {
      cancelled = true;
      break;
    }
    const rowNumber = input.row?.sourceRow ?? input.rowIndex + 1;
    const fileName = names.allocate(
      applyFileNamePattern(config.job.options.fileNamePattern, input.row, rowNumber, config.templateName),
      `${config.templateName} - row ${rowNumber}`,
    );
    let result: ExportResult;
    try {
      const blocking = cb.blockingIssues?.(input) ?? [];
      if (blocking.length > 0) throw new RowBlockedError(blocking);
      const out = await cb.generate(input);
      result = { rowIndex: input.rowIndex, status: 'ok', fileName, bytes: out.bytes, warnings: out.warnings };
    } catch (err) {
      result = {
        rowIndex: input.rowIndex,
        status: 'failed',
        fileName,
        error: err instanceof Error ? err.message : String(err),
        issues: err instanceof RowBlockedError ? err.issues : [],
      };
    }
    results.push(result);
    done++;
    cb.onProgress?.(done, config.rows.length, result);
    if (cb.yieldToUi) await cb.yieldToUi();
  }
  return {
    job: config.job,
    results,
    completed: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    cancelled,
    finishedAt: Date.now(),
  };
}

export async function zipResults(results: ExportResult[], reportName = 'export-report.txt'): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const lines: string[] = [];
  for (const r of results) {
    if (r.status === 'ok') {
      // PDFs are already compressed; storing them is much faster.
      zip.file(r.fileName, r.bytes, { compression: 'STORE' });
      lines.push(`OK      ${r.fileName}${r.warnings.length ? `  (${r.warnings.length} warning(s))` : ''}`);
    } else {
      lines.push(`FAILED  ${r.fileName}: ${r.error}`);
    }
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  if (failed > 0 || results.some((r) => r.status === 'ok' && r.warnings.length > 0)) {
    zip.file(reportName, `Export report\n\n${lines.join('\n')}\n`);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}
