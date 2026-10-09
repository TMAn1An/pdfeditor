import { useCallback } from 'react';
import { newProjectFor, preparePdf, PdfOpenError, useWorkspace } from './workspace';
import { loadProject as loadStoredProject } from '../lib/storage/localStore';
import { BUNDLE_EXTENSION, packBundle, unpackBundle } from '../lib/storage/bundle';
import { sanitizeFileBase } from '../lib/export/filenames';
import { sha256Hex } from '../lib/id';
import type { TemplateProject } from '../types/project';
import { parseCsvText } from '../lib/spreadsheet/parse';
import { loadImageFile } from '../lib/images/load';
import { LARGE_PDF_BYTES } from '../lib/pdf/pdfjs';
import { downloadBytes, formatBytes, readFileBytes } from '../lib/download';

export type PasswordPrompt = (fileName: string, retry: boolean) => Promise<string | null>;

/** Open a PDF, asking for a password when needed. Returns null if the user cancels. */
export async function openPdfWithPassword(bytes: Uint8Array, fileName: string, askPassword: PasswordPrompt) {
  let password: string | undefined;
  let retry = false;
  for (;;) {
    try {
      return await preparePdf(bytes, fileName, password);
    } catch (err) {
      if (err instanceof PdfOpenError && (err.kind === 'password-required' || err.kind === 'password-incorrect')) {
        const p = await askPassword(fileName, retry || err.kind === 'password-incorrect');
        if (p === null) return null;
        password = p;
        retry = true;
        continue;
      }
      throw err;
    }
  }
}

export function useProjectActions(askPassword: PasswordPrompt) {
  const ws = useWorkspace();

  /** Start a new project from a PDF file. */
  const openPdfFile = useCallback(
    async (file: File) => {
      const bytes = await readFileBytes(file);
      const result = await openPdfWithPassword(bytes, file.name, askPassword);
      if (!result) return;
      const project = newProjectFor(result.meta.title || file.name);
      project.pdf = result.meta;
      project.formFields = result.formFields;
      ws.loadProject(project, result.loaded);
      if (result.formFields.length)
        ws.toast(`This PDF has ${result.formFields.length} form field(s). They are listed under “Existing PDF form fields”.`, 'info');
      if (result.loaded.exportBlocked) ws.toast('This PDF is protected; filled copies cannot be created from it.', 'warning');
      if (bytes.byteLength > LARGE_PDF_BYTES) {
        ws.toast(
          `This is a large PDF (${formatBytes(bytes.byteLength)}). Pages may load slowly, and each exported copy will be about as large. Consider turning off “Store the PDF in this browser”.`,
          'warning',
        );
      }
    },
    [ws, askPassword],
  );

  /** Attach the source PDF to a project that was saved without it. */
  const reattachPdf = useCallback(
    async (file: File, project: TemplateProject) => {
      const bytes = await readFileBytes(file);
      const hash = await sha256Hex(bytes);
      if (project.pdf?.sha256 && hash !== project.pdf.sha256) {
        const ok = confirm(
          'This is not the same PDF the template was made with. Fields may land in the wrong places, and fields on pages that do not exist will be flagged. Use it anyway?',
        );
        if (!ok) return;
      }
      const result = await openPdfWithPassword(bytes, file.name, askPassword);
      if (!result) return;
      ws.update((p) => ({ ...p, pdf: result.meta, formFields: result.formFields }));
      ws.attachPdf(result.loaded);
    },
    [ws, askPassword],
  );

  const openStored = useCallback(
    async (id: string) => {
      const loaded = await loadStoredProject(id);
      let pdf = null;
      if (loaded.pdfBytes) {
        const result = await openPdfWithPassword(loaded.pdfBytes, loaded.project.pdf?.fileName ?? 'template.pdf', askPassword);
        pdf = result?.loaded ?? null;
      }
      ws.loadProject(loaded.project, pdf, loaded.fonts);
      for (const w of loaded.warnings) ws.toast(w, 'warning');
    },
    [ws, askPassword],
  );

  const importProjectFile = useCallback(
    async (file: File) => {
      const data = await readFileBytes(file);
      const bundle = await unpackBundle(data);
      let pdf = null;
      if (bundle.pdfBytes) {
        const result = await openPdfWithPassword(bundle.pdfBytes, bundle.project.pdf?.fileName ?? 'template.pdf', askPassword);
        pdf = result?.loaded ?? null;
      }
      ws.loadProject(bundle.project, pdf, bundle.fonts);
      if (bundle.migratedFrom !== null) ws.toast(`The project was upgraded from format version ${bundle.migratedFrom}.`, 'info');
      for (const w of bundle.warnings) ws.toast(w, 'warning');
      ws.toast(`Opened “${bundle.project.name}”.`, 'success');
    },
    [ws, askPassword],
  );

  const exportProjectFile = useCallback(async () => {
    const p = ws.project;
    if (!p) return;
    const bytes = await packBundle({ project: p, pdfBytes: ws.pdf?.bytes ?? null, fonts: ws.fontBytes });
    downloadBytes(bytes, `${sanitizeFileBase(p.name) || 'template'}${BUNDLE_EXTENSION}`, 'application/zip');
    ws.toast('Project file saved. It contains the PDF, field layout, mappings and fonts — no spreadsheet data or photos.', 'success');
  }, [ws]);

  /** Load the synthetic sample (served from this app; contains no real personal data). */
  const loadSample = useCallback(async () => {
    const base = new URL('samples/', document.baseURI);
    const get = async (name: string) => {
      const res = await fetch(new URL(name, base));
      if (!res.ok) throw new Error(`Sample file ${name} is missing.`);
      return new Uint8Array(await res.arrayBuffer());
    };
    const [pdfBytes, projectBytes, csvBytes] = await Promise.all([get('certificate-template.pdf'), get('certificate.pdftemplate'), get('participants.csv')]);
    const bundle = await unpackBundle(projectBytes);
    const result = await preparePdf(pdfBytes, 'certificate-template.pdf');
    ws.loadProject({ ...bundle.project, pdf: result.meta, formFields: result.formFields }, result.loaded, bundle.fonts);
    ws.setSheet(parseCsvText(new TextDecoder().decode(csvBytes), 'participants.csv'));
    const names = ['amina.png', 'rafi.png', 'maria.png', 'kenji.png', 'tanvir.png'];
    const assets = await Promise.all(
      names.map(async (n) => {
        const bytes = await get(`photos/${n}`);
        const file = new File([bytes as Uint8Array<ArrayBuffer>], n, { type: 'image/png' });
        return loadImageFile(file);
      }),
    );
    ws.addImages(assets);
    ws.toast('Sample loaded: a synthetic certificate, 6 made-up participants and generated placeholder photos.', 'success');
  }, [ws]);

  return { openPdfFile, reattachPdf, openStored, importProjectFile, exportProjectFile, loadSample };
}
