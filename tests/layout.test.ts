import { describe, expect, it } from 'vitest';
import { layoutText, wrapText, type LayoutOptions } from '../src/lib/text/layout';

// Every character is 0.5em wide.
const measure = (t: string, size: number) => Array.from(t).length * 0.5 * size;

const base: LayoutOptions = {
  width: 100,
  height: 20,
  fontSize: 10,
  minFontSize: 4,
  lineHeight: 1.2,
  fit: 'shrink',
  align: 'left',
  verticalAlign: 'middle',
};

describe('layoutText', () => {
  it('keeps the requested size when text fits', () => {
    const r = layoutText('Short', base, measure);
    expect(r.fontSize).toBe(10);
    expect(r.overflow).toBe(false);
    expect(r.shrunk).toBe(false);
  });

  it('shrinks a long single line until it fits', () => {
    const text = 'A considerably longer participant name'; // 38 chars → 190pt at 10pt
    const r = layoutText(text, base, measure);
    expect(r.shrunk).toBe(true);
    expect(r.overflow).toBe(false);
    expect(measure(text, r.fontSize)).toBeLessThanOrEqual(100);
    expect(r.lines).toHaveLength(1);
  });

  it('flags text that does not fit even at the minimum size', () => {
    const r = layoutText('x'.repeat(200), base, measure);
    expect(r.hitMinimum).toBe(true);
    expect(r.overflow).toBe(true);
    expect(r.fontSize).toBe(4);
  });

  it('wraps onto several lines and reports hidden lines', () => {
    const opts = { ...base, fit: 'wrap' as const, height: 30 };
    const r = layoutText('one two three four five six seven eight nine ten eleven twelve', opts, measure);
    expect(r.overflow).toBe(true);
    expect(r.droppedLines).toBeGreaterThan(0);
    for (const line of r.lines) expect(measure(line.text, 10)).toBeLessThanOrEqual(100);
  });

  it('wrap-shrink fits everything by reducing size', () => {
    const opts = { ...base, fit: 'wrap-shrink' as const, height: 30 };
    const r = layoutText('one two three four five six seven eight nine ten eleven twelve', opts, measure);
    expect(r.overflow).toBe(false);
    expect(r.shrunk).toBe(true);
    expect(r.droppedLines).toBe(0);
  });

  it('clip keeps one line and marks overflow; overflow mode disables clipping', () => {
    const clip = layoutText('x'.repeat(40), { ...base, fit: 'clip' }, measure);
    expect(clip.overflow).toBe(true);
    expect(clip.clip).toBe(true);
    const over = layoutText('x'.repeat(40), { ...base, fit: 'overflow' }, measure);
    expect(over.clip).toBe(false);
    expect(over.overflow).toBe(true);
  });

  it('aligns lines horizontally', () => {
    const left = layoutText('abcd', { ...base, align: 'left' }, measure).lines[0]!;
    const center = layoutText('abcd', { ...base, align: 'center' }, measure).lines[0]!;
    const right = layoutText('abcd', { ...base, align: 'right' }, measure).lines[0]!;
    expect(left.x).toBe(0);
    expect(center.x).toBe(40);
    expect(right.x).toBe(80);
  });

  it('places the baseline according to vertical alignment', () => {
    const top = layoutText('a', { ...base, verticalAlign: 'top' }, measure).lines[0]!;
    const bottom = layoutText('a', { ...base, verticalAlign: 'bottom' }, measure).lines[0]!;
    expect(top.baseline).toBeCloseTo(20 - 8);
    expect(bottom.baseline).toBeCloseTo(2);
  });
});

describe('wrapText', () => {
  it('breaks very long words between graphemes', () => {
    const lines = wrapText('supercalifragilistic', 25, 10, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('supercalifragilistic');
  });

  it('keeps Bengali clusters together when breaking', () => {
    const word = 'শিক্ষার্থী';
    const lines = wrapText(word, 10, 10, measure);
    expect(lines.join('')).toBe(word);
    // No line may start with a combining vowel sign.
    for (const l of lines) expect(/^\p{M}/u.test(l)).toBe(false);
  });

  it('respects explicit line breaks', () => {
    expect(wrapText('a\nb', 100, 10, measure)).toEqual(['a', 'b']);
  });
});
