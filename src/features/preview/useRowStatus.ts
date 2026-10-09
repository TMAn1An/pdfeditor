import { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../../app/workspace';
import { planRow, type RenderContext } from '../../lib/render/plan';

export interface RowStatus {
  errors: number;
  warnings: number;
  firstError: string | null;
}

export function useRenderContext(): RenderContext | null {
  const ws = useWorkspace();
  return useMemo(() => (ws.project && ws.fontsReady ? { project: ws.project, fonts: ws.fonts, images: ws.imageResolver } : null), [ws.project, ws.fonts, ws.fontsReady, ws.imageResolver]);
}

/**
 * Validates every data row in the background (in small chunks so the page
 * stays responsive) and returns a summary per row.
 */
export function useRowStatuses(): { statuses: (RowStatus | undefined)[]; done: number; total: number } {
  const ws = useWorkspace();
  const ctx = useRenderContext();
  const rows = ws.sheet?.rows;
  const [state, setState] = useState<{ statuses: (RowStatus | undefined)[]; done: number }>({ statuses: [], done: 0 });

  useEffect(() => {
    if (!ctx || !rows) return;
    let cancelled = false;
    const statuses: (RowStatus | undefined)[] = new Array(rows.length);
    let i = 0;
    const chunk = () => {
      if (cancelled) return;
      const end = Math.min(rows.length, i + 50);
      for (; i < end; i++) {
        const plan = planRow(ctx, rows[i]!, i);
        const errors = plan.issues.filter((x) => x.severity === 'error');
        statuses[i] = { errors: errors.length, warnings: plan.issues.filter((x) => x.severity === 'warning').length, firstError: errors[0]?.message ?? null };
      }
      setState({ statuses: [...statuses], done: i });
      if (i < rows.length) setTimeout(chunk, 0);
    };
    const t = setTimeout(chunk, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [ctx, rows]);

  return { statuses: rows ? state.statuses : [], done: rows ? state.done : 0, total: rows?.length ?? 0 };
}
