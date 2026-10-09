/**
 * Suggests spreadsheet columns for template fields using normalized name
 * similarity plus a small synonym list. Suggestions are only ever *offered*:
 * the UI shows them and the user accepts or changes them.
 */

export interface MappingCandidate {
  column: string;
  score: number;
  reason: 'exact' | 'synonym' | 'similar';
}

export interface MappingSuggestion {
  target: string;
  candidates: MappingCandidate[];
  /** The best candidate is clearly ahead of the others. */
  confident: boolean;
}

const SYNONYM_GROUPS: string[][] = [
  ['name', 'full name', 'fullname', 'participant name', 'participant', 'student name', 'student', 'candidate name', 'candidate', 'recipient name', 'recipient', 'awardee', 'attendee', 'attendee name', 'employee name', 'member name', 'person', 'holder name', 'nam', 'নাম'],
  ['first name', 'firstname', 'given name', 'forename'],
  ['last name', 'lastname', 'surname', 'family name'],
  ['id', 'certificate id', 'certificate no', 'certificate number', 'cert id', 'cert no', 'serial', 'serial no', 'serial number', 'sl no', 'id no', 'id number', 'reference', 'ref', 'ref no', 'registration no', 'registration number', 'reg no', 'roll', 'roll no', 'roll number', 'student id', 'employee id', 'member id'],
  ['photo', 'image', 'picture', 'photo file', 'photo filename', 'image file', 'image filename', 'picture file', 'pic', 'avatar', 'headshot', 'photograph', 'portrait', 'ছবি'],
  ['signature', 'sign', 'signature file', 'signature image'],
  ['date', 'issue date', 'issued on', 'date of issue', 'issued', 'completion date', 'date issued', 'award date'],
  ['date of birth', 'dob', 'birth date', 'birthday', 'birthdate'],
  ['course', 'course name', 'program', 'programme', 'program name', 'training', 'training name', 'subject', 'event', 'event name', 'workshop'],
  ['email', 'e mail', 'email address', 'mail'],
  ['phone', 'mobile', 'phone number', 'mobile number', 'contact', 'contact number', 'telephone', 'tel'],
  ['address', 'street address', 'postal address', 'location'],
  ['grade', 'result', 'score', 'marks', 'gpa', 'cgpa', 'division'],
  ['organization', 'organisation', 'company', 'institution', 'school', 'university', 'college', 'employer'],
  ['title', 'designation', 'position', 'job title', 'role'],
  ['father name', 'fathers name', 'father s name', 'father'],
  ['mother name', 'mothers name', 'mother s name', 'mother'],
];

const STOP_WORDS = new Set(['the', 'of', 'a', 'an', 'field', 'text', 'value', 'col', 'column']);

/** Lowercase, strip accents and punctuation, collapse spaces; keeps letters of all scripts. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_\-./\\#:()[\]{}'"’`]+/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter((t) => t && !STOP_WORDS.has(t));
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  const chars = Array.from(t);
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i]! + chars[i + 1]!;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient on character bigrams (0..1). */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return (2 * inter) / total;
}

function synonymGroups(name: string): number[] {
  const n = tokens(name).join(' ');
  const out: number[] = [];
  SYNONYM_GROUPS.forEach((group, i) => {
    if (group.some((g) => normalizeName(g) === n)) out.push(i);
  });
  return out;
}

export function scoreNames(fieldName: string, column: string): { score: number; reason: MappingCandidate['reason'] } {
  const a = tokens(fieldName).join(' ');
  const b = tokens(column).join(' ');
  if (!a || !b) return { score: 0, reason: 'similar' };
  if (a === b || a.replace(/ /g, '') === b.replace(/ /g, '')) return { score: 1, reason: 'exact' };
  const ga = synonymGroups(fieldName);
  const gb = synonymGroups(column);
  if (ga.some((g) => gb.includes(g))) return { score: 0.9, reason: 'synonym' };
  const dice = diceSimilarity(a, b);
  // Token overlap helps "Participant Full Name" vs "Full Name".
  const ta = new Set(a.split(' '));
  const tb = new Set(b.split(' '));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  const overlap = shared / Math.max(ta.size, tb.size);
  const contains = a.includes(b) || b.includes(a) ? 0.15 : 0;
  return { score: Math.min(0.85, Math.max(dice, overlap * 0.9) + contains), reason: 'similar' };
}

export const MIN_SUGGESTION_SCORE = 0.55;
export const AMBIGUITY_MARGIN = 0.08;

export function suggestColumns(target: string, label: string, columns: string[]): MappingSuggestion {
  const candidates = columns
    .map((column) => ({ column, ...scoreNames(label, column) }))
    .filter((c) => c.score >= MIN_SUGGESTION_SCORE)
    .sort((x, y) => y.score - x.score || x.column.localeCompare(y.column));
  const [best, second] = candidates;
  const confident = !!best && (!second || best.score - second.score >= AMBIGUITY_MARGIN);
  return { target, candidates: candidates.slice(0, 5), confident };
}

export interface NamedTarget {
  target: string;
  label: string;
}

export function suggestAll(targets: NamedTarget[], columns: string[]): MappingSuggestion[] {
  return targets.map((t) => suggestColumns(t.target, t.label, columns));
}
