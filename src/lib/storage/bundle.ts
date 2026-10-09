import type { TemplateProject } from '../../types/project';
import { sha256Hex } from '../id';
import { parseProjectJson, ProjectFileError, serializeProject, type ProjectLoadResult } from './projectFile';

/**
 * Portable project file (".pdftemplate"): a ZIP archive containing
 *   project.json      — the versioned project (fields, mapping, settings)
 *   template.pdf      — the source PDF (optional)
 *   fonts/<id>.bin    — uploaded fonts used by the template
 * Spreadsheet rows and photos are never included.
 */

export const BUNDLE_EXTENSION = '.pdftemplate';
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

export interface ProjectBundle {
  project: TemplateProject;
  pdfBytes: Uint8Array | null;
  fonts: Map<string, Uint8Array>;
}

export async function packBundle(bundle: ProjectBundle): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('project.json', serializeProject(bundle.project));
  if (bundle.pdfBytes) zip.file('template.pdf', bundle.pdfBytes, { compression: 'STORE' });
  for (const font of bundle.project.fonts) {
    const bytes = bundle.fonts.get(font.id);
    if (bytes) zip.file(`fonts/${font.id}.bin`, bytes);
  }
  zip.file('README.txt', 'PDF Template Studio project file. Open it from the app with "Open project file".\n');
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export interface UnpackedBundle extends ProjectLoadResult {
  pdfBytes: Uint8Array | null;
  fonts: Map<string, Uint8Array>;
}

export async function unpackBundle(data: Uint8Array): Promise<UnpackedBundle> {
  // A plain JSON project (without PDF) is accepted too.
  if (data[0] === 0x7b /* { */ || data[0] === 0xef) {
    const result = parseProjectJson(new TextDecoder().decode(data));
    return { ...result, pdfBytes: null, fonts: new Map() };
  }
  if (!(data[0] === 0x50 && data[1] === 0x4b)) throw new ProjectFileError('This is not a project file.');
  const { default: JSZip } = await import('jszip');
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new ProjectFileError('The project file is damaged and could not be opened.');
  }
  const manifest = zip.file('project.json');
  if (!manifest) throw new ProjectFileError('The project file does not contain project.json.');
  const result = parseProjectJson(await manifest.async('string'));
  const warnings = [...result.warnings];

  let pdfBytes: Uint8Array | null = null;
  const pdfEntry = zip.file('template.pdf');
  if (pdfEntry) {
    pdfBytes = await readLimited(pdfEntry);
    if (!(pdfBytes[0] === 0x25 && pdfBytes[1] === 0x50 && pdfBytes[2] === 0x44 && pdfBytes[3] === 0x46)) {
      warnings.push('The PDF inside the project file is not valid and was ignored.');
      pdfBytes = null;
    } else if (result.project.pdf?.sha256) {
      const hash = await sha256Hex(pdfBytes);
      if (hash !== result.project.pdf.sha256) warnings.push('The PDF inside the project file does not match the one the template was made with.');
    }
  }

  const fonts = new Map<string, Uint8Array>();
  for (const font of result.project.fonts) {
    const entry = zip.file(`fonts/${font.id}.bin`);
    if (entry) fonts.set(font.id, await readLimited(entry));
    else warnings.push(`Font "${font.name}" is missing from the project file. Add it again in the Fonts panel.`);
  }
  return { ...result, warnings, pdfBytes, fonts };
}

async function readLimited(entry: { async(type: 'uint8array'): Promise<Uint8Array> }): Promise<Uint8Array> {
  const bytes = await entry.async('uint8array');
  if (bytes.byteLength > MAX_ENTRY_BYTES) throw new ProjectFileError('A file inside the project is too large.');
  return bytes;
}
