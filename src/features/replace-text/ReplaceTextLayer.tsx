import { memo } from 'react';
import type { PageTextObjects, TextObjectInfo } from '../../lib/pdfium/textIndex';
import type { NormRect } from '../../types/project';

/**
 * Clickable boxes for the existing text objects PDFium found on a page.
 * Colour shows what is possible: green = the original font can be reused,
 * amber = needs a replacement font, grey = cannot be replaced.
 */
interface Props {
  page: PageTextObjects;
  selected: number[];
  usedBy: Map<number, string>;
  onPick: (obj: TextObjectInfo, additive: boolean) => void;
  onBlocked: (reason: string) => void;
}

function style(r: NormRect) {
  return { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` };
}

export const ReplaceTextLayer = memo(function ReplaceTextLayer({ page, selected, usedBy, onPick, onBlocked }: Props) {
  return (
    <div className="replace-layer">
      {page.blocked.map((b, i) => (
        <button
          key={`b${i}`}
          type="button"
          className="replace-obj status-unsupported"
          style={style(b.rect)}
          title="Text inside a Form XObject — cannot be replaced. Click for details."
          aria-label="Text that cannot be replaced (inside a Form XObject)"
          onClick={() => onBlocked(b.reason)}
        />
      ))}
      {page.objects.map((o) => {
        const status = o.unsupported ? 'unsupported' : o.reuseBlocker ? 'needs-font' : o.subset ? 'subset' : 'ok';
        const used = usedBy.get(o.index);
        return (
          <button
            key={o.index}
            type="button"
            className={`replace-obj status-${status}${selected.includes(o.index) ? ' selected' : ''}${used ? ' used' : ''}`}
            style={style(o.rect)}
            title={
              used
                ? `Already replaced by field “${used}”.`
                : o.unsupported
                  ? `Cannot be replaced: ${o.unsupported}`
                  : `“${o.text}” — ${o.fontName}, ${o.effectiveSize.toFixed(1)} pt. Click to select (Shift+click to add the next part of the same line).`
            }
            aria-label={`PDF text ${o.text}`}
            aria-pressed={selected.includes(o.index)}
            onClick={(e) => onPick(o, e.shiftKey)}
          />
        );
      })}
    </div>
  );
});
