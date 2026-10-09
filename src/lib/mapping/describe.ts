import type { FieldSource } from '../../types/project';

/** Short human description of where a field's value comes from. */
export function describeSource(s: FieldSource | undefined): string {
  if (!s || s.kind === 'none') return 'Not matched yet';
  switch (s.kind) {
    case 'column':
      return `Column “${s.column}”`;
    case 'fixed':
      return `Fixed text “${s.value.slice(0, 40)}”`;
    case 'template':
      return `Text template “${s.template.slice(0, 40)}”`;
    case 'date':
      return s.from === 'today' ? `Today's date (${s.format})` : `Date from “${s.from.column}”`;
    case 'fixed-image':
      return 'The same image on every row';
  }
}
