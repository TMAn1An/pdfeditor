/**
 * Suggests a data-field name (and therefore a spreadsheet column header) for
 * a piece of existing PDF text, from the text itself and its neighbours.
 */

export interface NeighbourText {
  text: string;
  /** Distance in points from the selected text's start (negative = to the left, same line). */
  dx: number;
  /** Vertical distance in points (0 = same baseline). */
  dy: number;
}

const DATE_RE = /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}(st|nd|rd|th)?\s+[A-Za-z]{3,}\.?,?\s+\d{2,4}|[A-Za-z]{3,}\.?\s+\d{1,2},?\s+\d{4})$/;
const MONEY_RE = /^[$€£¥৳₹]?\s?\d{1,3}([,.\s]\d{3})*([.,]\d{1,2})?\s?[$€£¥৳₹]?$/;
const ID_RE = /^[A-Z]{0,6}[-/#]?\d[\dA-Z\-/]{2,}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const NAME_RE = /^(\p{Lu}[\p{L}'’-]+)(\s+\p{Lu}[\p{L}'’.-]*){1,3}$/u;

function clean(label: string): string {
  return label
    .replace(/[:：\-–—#]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase())
    .slice(0, 40);
}

export function suggestFieldLabel(fullText: string, selection: { start: number; end: number }, neighbours: NeighbourText[] = []): string {
  const before = fullText.slice(0, selection.start);
  const selected = fullText.slice(selection.start, selection.end).trim();

  // "Label: value" inside the same text object.
  const inline = /([\p{L}][\p{L}\p{N} .'’/]{0,40})[:：]\s*$/u.exec(before);
  if (inline) return clean(inline[1]!);

  // A label just to the left on the same line, e.g. "Name:" | "Amina".
  const left = neighbours.filter((n) => Math.abs(n.dy) < 3 && n.dx < 0 && n.dx > -260 && /[:：]\s*$/.test(n.text.trim())).sort((a, b) => b.dx - a.dx)[0];
  if (left) return clean(left.text);

  if (EMAIL_RE.test(selected)) return 'Email';
  if (DATE_RE.test(selected)) return 'Date';
  if (MONEY_RE.test(selected) && /[.,]\d{2}$|[$€£¥৳₹]/.test(selected)) return 'Amount';
  if (ID_RE.test(selected) && /\d/.test(selected)) return 'ID';
  if (NAME_RE.test(selected)) return 'Name';
  if (/^\d+$/.test(selected)) return 'Number';
  const words = selected.split(/\s+/).slice(0, 4).join(' ');
  return clean(words) || 'Text';
}
