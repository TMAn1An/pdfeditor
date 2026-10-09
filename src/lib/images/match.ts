/**
 * Matches spreadsheet values such as "photos/amina.jpg" to image files the
 * user selected in the browser.
 *
 * The spreadsheet value is only ever used as a *lookup key* into the set of
 * files the user explicitly picked. It never grants access to any other path:
 * "..", ".", drive letters, URL schemes and leading slashes are discarded, and
 * only the remaining path segments are compared with the selected files.
 */

export interface ImageCandidate {
  id: string;
  /** File name, e.g. "amina.jpg". */
  name: string;
  /** Path relative to the chosen folder, e.g. "class-a/photos/amina.jpg" (or just the name). */
  relativePath: string;
}

export type ImageMatchStatus = 'matched' | 'manual' | 'empty' | 'not-found' | 'ambiguous';

export interface ImageMatch {
  key: string;
  status: ImageMatchStatus;
  fileId: string | null;
  candidates: string[];
}

/** Split a user-supplied path into safe, normalized segments. */
export function safePathSegments(value: string): string[] {
  let v = value.normalize('NFC').trim();
  // Strip URL schemes like file:// or https://; we never fetch them.
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Windows drive letters ("C:") and UNC prefixes.
  v = v.replace(/^[a-z]:/i, '');
  v = v.replace(/\\/g, '/');
  // Remove query strings / fragments that might come from URLs.
  v = v.replace(/[?#].*$/, '');
  return (
    v
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s !== '' && s !== '.' && s !== '..')
      // eslint-disable-next-line no-control-regex -- strip control characters on purpose
      .map((s) => s.replace(/[\u0000-\u001f]/g, ''))
      .filter((s) => s !== '')
  );
}

export function normalizeKey(value: string): string {
  return safePathSegments(value).join('/').toLowerCase();
}

function stem(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function hasExtension(name: string): boolean {
  return /\.[a-z0-9]{2,5}$/i.test(name);
}

export class ImageIndex {
  private readonly byName = new Map<string, ImageCandidate[]>();
  private readonly byStem = new Map<string, ImageCandidate[]>();

  constructor(readonly files: ImageCandidate[]) {
    for (const f of files) {
      const name = f.name.normalize('NFC').toLowerCase();
      push(this.byName, name, f);
      push(this.byStem, stem(name), f);
    }
  }

  /** Files that share a file name (case-insensitive) with another selected file. */
  duplicateNames(): string[][] {
    return [...this.byName.values()].filter((list) => list.length > 1).map((list) => list.map((f) => f.relativePath));
  }

  match(value: unknown, overrides: Record<string, string> = {}): ImageMatch {
    const raw = value == null ? '' : String(value);
    const key = normalizeKey(raw);
    if (key === '') return { key, status: 'empty', fileId: null, candidates: [] };
    const override = overrides[key];
    if (override && this.files.some((f) => f.id === override)) {
      return { key, status: 'manual', fileId: override, candidates: [override] };
    }
    const segments = key.split('/');
    const base = segments[segments.length - 1]!;
    let candidates = this.byName.get(base) ?? [];
    if (candidates.length === 0 && !hasExtension(base)) candidates = this.byStem.get(base) ?? [];
    if (candidates.length > 1 && segments.length > 1) {
      // Prefer files whose folder path ends with the same folders.
      const narrowed = candidates.filter((f) => {
        const fileSegs = safePathSegments(f.relativePath).map((s) => s.toLowerCase());
        return endsWith(fileSegs.slice(0, -1), segments.slice(0, -1));
      });
      if (narrowed.length > 0) candidates = narrowed;
    }
    if (candidates.length === 1) return { key, status: 'matched', fileId: candidates[0]!.id, candidates: [candidates[0]!.id] };
    if (candidates.length === 0) return { key, status: 'not-found', fileId: null, candidates: [] };
    return { key, status: 'ambiguous', fileId: null, candidates: candidates.map((c) => c.id) };
  }
}

function endsWith(haystack: string[], needle: string[]): boolean {
  if (needle.length > haystack.length) return false;
  const offset = haystack.length - needle.length;
  return needle.every((s, i) => haystack[offset + i] === s);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
