import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { FieldMapping, FontRef, SheetData, TemplateProject } from '../types/project';
import { historyReducer, initialHistory } from './history';
import { FontLibrary } from '../lib/fonts/engine';
import { STANDARD_FONTS } from '../lib/fonts/standard';
import { registerBrowserFont } from '../lib/fonts/upload';
import { ImageIndex } from '../lib/images/match';
import { releaseImage, type ImageAsset } from '../lib/images/load';
import { sha256Hex } from '../lib/id';
import { closePdf, detectFormFields, openPdf, PdfOpenError, readPageInfos, type PDFDocumentProxy } from '../lib/pdf/pdfjs';
import { loadTemplateForEditing } from '../lib/render/generate';
import type { ImageResolver } from '../lib/render/plan';
import { createProject } from '../lib/storage/projectFile';
import { rememberLastProject, saveProject, StorageQuotaError } from '../lib/storage/localStore';
import type { XlsxWorkbook } from '../lib/spreadsheet/parse';

export type Step = 'design' | 'data' | 'images' | 'preview';
export type SaveState = { status: 'saved' | 'unsaved' | 'saving' | 'error' | 'off'; message?: string; at?: number };
export type ToastKind = 'info' | 'success' | 'error' | 'warning';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface LoadedPdf {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  /** Why filled copies cannot be generated (e.g. encrypted PDF), or null. */
  exportBlocked: string | null;
}

export interface Workspace {
  project: TemplateProject | null;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Update the project and record an undo step (merged for repeated `key`). */
  update: (fn: (p: TemplateProject) => TemplateProject, key?: string) => void;
  setMapping: (fn: (m: FieldMapping) => FieldMapping, key?: string) => void;
  loadProject: (project: TemplateProject | null, pdf: LoadedPdf | null, fonts?: Map<string, Uint8Array>) => void;
  pdf: LoadedPdf | null;
  attachPdf: (pdf: LoadedPdf) => void;

  fontBytes: Map<string, Uint8Array>;
  setFontBytes: (fn: (m: Map<string, Uint8Array>) => Map<string, Uint8Array>) => void;
  fonts: FontLibrary;
  fontsReady: boolean;
  fontsError: string | null;

  sheet: SheetData | null;
  setSheet: (s: SheetData | null) => void;
  workbook: XlsxWorkbook | null;
  setWorkbook: (w: XlsxWorkbook | null) => void;

  images: ImageAsset[];
  addImages: (assets: ImageAsset[]) => void;
  clearImages: () => void;
  imageOverrides: Record<string, string>;
  setImageOverride: (key: string, fileId: string | null) => void;
  sampleImages: Record<string, ImageAsset | undefined>;
  setSampleImage: (fieldId: string, asset: ImageAsset | null) => void;
  imageResolver: ImageResolver;

  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  step: Step;
  setStep: (s: Step) => void;
  currentRow: number;
  setCurrentRow: (n: number) => void;
  selectedRows: Set<number>;
  setSelectedRows: (s: Set<number>) => void;

  saveState: SaveState;
  saveNow: () => Promise<void>;

  dialog: 'fonts' | 'export' | 'storage' | null;
  setDialog: (d: 'fonts' | 'export' | 'storage' | null) => void;

  toasts: Toast[];
  toast: (message: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return ws;
}

/** Read a PDF file into a LoadedPdf plus the metadata for a project. */
export async function preparePdf(bytes: Uint8Array, fileName: string, password?: string) {
  const doc = await openPdf(bytes, password);
  const pages = await readPageInfos(doc);
  const formFields = await detectFormFields(doc).catch(() => []);
  const sha256 = await sha256Hex(bytes);
  let exportBlocked: string | null = null;
  try {
    await loadTemplateForEditing(bytes);
  } catch (err) {
    exportBlocked = err instanceof Error ? err.message : String(err);
  }
  let title: string | undefined;
  try {
    const meta = await doc.getMetadata();
    const info = meta.info as { Title?: unknown };
    if (typeof info?.Title === 'string' && info.Title.trim()) title = info.Title.trim();
  } catch {
    /* metadata is optional */
  }
  const meta = {
    fileName,
    byteLength: bytes.byteLength,
    pageCount: doc.numPages,
    sha256,
    title,
    pages,
    hasAcroForm: formFields.length > 0,
  };
  return { loaded: { bytes, doc, exportBlocked } satisfies LoadedPdf, meta, formFields };
}

export { PdfOpenError };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [history, dispatch] = useReducer(historyReducer, initialHistory);
  const project = history.present;
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [fontBytes, setFontBytesState] = useState<Map<string, Uint8Array>>(new Map());
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [workbook, setWorkbook] = useState<XlsxWorkbook | null>(null);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const [sampleImages, setSampleImages] = useState<Record<string, ImageAsset | undefined>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('design');
  const [currentRow, setCurrentRow] = useState(0);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<Workspace['dialog']>(null);
  const toastId = useRef(0);

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // --- Fonts -----------------------------------------------------------------
  const fonts = useMemo(() => new FontLibrary((id) => fontBytes.get(id)), [fontBytes]);
  const customRefs = useMemo(
    () => (project?.fonts ?? []).filter((f) => fontBytes.has(f.id)).map((f) => `custom:${f.id}` as FontRef),
    [project?.fonts, fontBytes],
  );
  const [fontState, setFontState] = useState<{ fonts: FontLibrary; refs: FontRef[]; error: string | null } | null>(null);
  const fontsReady = fontState?.fonts === fonts && fontState.refs === customRefs;
  const fontsError = fontsReady ? fontState.error : null;
  useEffect(() => {
    let cancelled = false;
    const refs: FontRef[] = [...STANDARD_FONTS.map((f) => `std:${f.id}` as FontRef), ...customRefs];
    fonts
      .prepare(refs)
      .then(() => {
        if (!cancelled) setFontState({ fonts, refs: customRefs, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setFontState({ fonts, refs: customRefs, error: err instanceof Error ? err.message : String(err) });
      });
    for (const [id, bytes] of fontBytes) registerBrowserFont(id, bytes).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fonts, customRefs, fontBytes]);

  const setFontBytes = useCallback((fn: (m: Map<string, Uint8Array>) => Map<string, Uint8Array>) => setFontBytesState((m) => fn(new Map(m))), []);

  // --- Images ----------------------------------------------------------------
  const imageResolver = useMemo<ImageResolver>(() => {
    const assets = new Map<string, ImageAsset>();
    for (const a of images) assets.set(a.id, a);
    for (const a of Object.values(sampleImages)) if (a) assets.set(a.id, a);
    return {
      index: images.length > 0 ? new ImageIndex(images.map((a) => ({ id: a.id, name: a.name, relativePath: a.relativePath }))) : null,
      assets,
      overrides: imageOverrides,
      samples: sampleImages,
    };
  }, [images, imageOverrides, sampleImages]);

  const addImages = useCallback((assets: ImageAsset[]) => setImages((prev) => [...prev, ...assets]), []);
  const clearImages = useCallback(() => {
    setImages((prev) => {
      prev.forEach(releaseImage);
      return [];
    });
    setImageOverrides({});
  }, []);
  const setImageOverride = useCallback((key: string, fileId: string | null) => {
    setImageOverrides((o) => {
      const next = { ...o };
      if (fileId) next[key] = fileId;
      else delete next[key];
      return next;
    });
  }, []);
  const setSampleImage = useCallback((fieldId: string, asset: ImageAsset | null) => {
    setSampleImages((s) => {
      const prev = s[fieldId];
      if (prev && prev !== asset) releaseImage(prev);
      return { ...s, [fieldId]: asset ?? undefined };
    });
  }, []);

  // --- Project ---------------------------------------------------------------
  const [savedProject, setSavedProject] = useState<TemplateProject | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const loadProject = useCallback((p: TemplateProject | null, loaded: LoadedPdf | null, fontMap?: Map<string, Uint8Array>) => {
    dispatch({ type: 'load', project: p });
    setPdf((old) => {
      if (old && old !== loaded) void closePdf(old.doc);
      return loaded;
    });
    setFontBytesState(fontMap ?? new Map());
    setSelectedId(null);
    setStep('design');
    setCurrentRow(0);
    setSelectedRows(new Set());
    setSampleImages({});
    setSavedProject(p);
    setSaveError(null);
    rememberLastProject(p?.id ?? null);
  }, []);

  const attachPdf = useCallback((loaded: LoadedPdf) => {
    setPdf((old) => {
      if (old && old !== loaded) void closePdf(old.doc);
      return loaded;
    });
  }, []);

  const update = useCallback((fn: (p: TemplateProject) => TemplateProject, key?: string) => dispatch({ type: 'update', update: fn, key }), []);
  const setMapping = useCallback(
    (fn: (m: FieldMapping) => FieldMapping, key?: string) => dispatch({ type: 'update', update: (p) => ({ ...p, mapping: fn(p.mapping) }), key }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);

  // --- Saving ----------------------------------------------------------------
  const pdfRef = useRef(pdf);
  const fontBytesRef = useRef(fontBytes);
  useEffect(() => {
    pdfRef.current = pdf;
    fontBytesRef.current = fontBytes;
  }, [pdf, fontBytes]);

  const saveNow = useCallback(async () => {
    const p = history.present;
    if (!p) return;
    setSaving(true);
    try {
      await saveProject(p, pdfRef.current?.bytes ?? null, fontBytesRef.current);
      setSavedProject(p);
      setSavedAt(Date.now());
      setSaveError(null);
      rememberLastProject(p.id);
    } catch (err) {
      setSaveError(
        err instanceof StorageQuotaError
          ? err.message
          : `Could not save in this browser: ${err instanceof Error ? err.message : String(err)}. Use "Export project file" to keep a copy.`,
      );
    } finally {
      setSaving(false);
    }
  }, [history.present]);

  const saveState: SaveState = !project
    ? { status: 'saved' }
    : saveError
      ? { status: 'error', message: saveError }
      : saving
        ? { status: 'saving' }
        : project !== savedProject
          ? { status: 'unsaved' }
          : { status: 'saved', at: savedAt };

  useEffect(() => {
    if (!project || project === savedProject) return;
    const t = setTimeout(() => void saveNow(), 900);
    return () => clearTimeout(t);
  }, [project, savedProject, saveNow]);

  // Save when a new PDF or font is attached to the current project.
  useEffect(() => {
    if (!project || (!pdf && fontBytes.size === 0)) return;
    const t = setTimeout(() => void saveNow(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, fontBytes]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (saveState.status === 'unsaved' || saveState.status === 'saving' || saveState.status === 'error') {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveState.status]);

  // A selection pointing at a deleted field (e.g. after undo) counts as no selection.
  const validSelectedId =
    selectedId &&
    project &&
    (selectedId.startsWith('form:') ? project.formFields.some((f) => `form:${f.name}` === selectedId) : project.fields.some((f) => f.id === selectedId))
      ? selectedId
      : null;

  // Remember column names (not data) so mappings can be edited without the file.
  const setSheetAndColumns = useCallback((next: SheetData | null) => {
    setSheet(next);
    if (next) {
      const cols = next.columns.map((c) => c.key);
      dispatch({ type: 'update', update: (p) => (JSON.stringify(cols) === JSON.stringify(p.knownColumns) ? p : { ...p, knownColumns: cols }), key: 'columns' });
    }
  }, []);

  const value: Workspace = {
    project,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo,
    redo,
    update,
    setMapping,
    loadProject,
    pdf,
    attachPdf,
    fontBytes,
    setFontBytes,
    fonts,
    fontsReady,
    fontsError,
    sheet,
    setSheet: setSheetAndColumns,
    workbook,
    setWorkbook,
    images,
    addImages,
    clearImages,
    imageOverrides,
    setImageOverride,
    sampleImages,
    setSampleImage,
    imageResolver,
    selectedId: validSelectedId,
    setSelectedId,
    step,
    setStep,
    currentRow,
    setCurrentRow,
    selectedRows,
    setSelectedRows,
    saveState,
    saveNow,
    dialog,
    setDialog,
    toasts,
    toast,
    dismissToast,
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function newProjectFor(name: string): TemplateProject {
  return createProject(name.replace(/\.pdf$/i, '') || 'Untitled template');
}
