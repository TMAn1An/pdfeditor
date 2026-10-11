import { describe, expect, it } from 'vitest';
import { suggestColumnName } from '../src/integration/columnMapping';

/**
 * Regression coverage for the blank-sample-Excel bug: StudioApp's
 * saveToServer() used to only ever set a `{kind: 'column'}` mapping for the
 * QR field, never for ordinary text/image fields -- and
 * TemplateProjectService::deriveSchema() (Laravel side) unconditionally
 * excludes the QR field too, so editor_schema['fields'] was always empty.
 * The fix prompts for a column per non-QR field at save time, seeded with
 * this suggestion. Full end-to-end coverage (save -> sample.xlsx has
 * headers) lives in the Laravel repo's PdfStudioTest.php, since it needs
 * the server round trip; this covers the suggestion logic directly.
 */
describe('suggestColumnName', () => {
  it('keeps a clean label as-is', () => {
    expect(suggestColumnName('Full Name')).toBe('Full Name');
  });

  it('strips punctuation that would make an awkward Excel header', () => {
    expect(suggestColumnName('Student ID#')).toBe('Student ID');
  });

  it('collapses repeated whitespace', () => {
    expect(suggestColumnName('Paper   Title')).toBe('Paper Title');
  });

  it('falls back to a placeholder for a label with nothing usable', () => {
    expect(suggestColumnName('###')).toBe('Value');
    expect(suggestColumnName('')).toBe('Value');
  });

  it('keeps non-Latin letters (e.g. Bengali labels) intact', () => {
    expect(suggestColumnName('শিক্ষার্থীর নাম')).toBe('শিক্ষার্থীর নাম');
  });
});
