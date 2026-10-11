/**
 * A readable default Excel header from a field's label, e.g. "Full Name" ->
 * "Full Name" stays as-is but "Student ID#" -> "Student ID". Purely a
 * starting suggestion -- the admin can edit or clear it in StudioApp's
 * save-time prompt.
 */
export function suggestColumnName(label: string): string {
  // \p{M} (combining marks) is required alongside \p{L}/\p{N}, or this
  // mangles any script that composes letters with combining diacritics
  // (e.g. Bengali vowel signs/virama) by stripping marks out of a word.
  return label.replace(/[^\p{L}\p{N}\p{M} ]+/gu, '').replace(/\s+/g, ' ').trim() || 'Value';
}
