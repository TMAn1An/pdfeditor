import type { TemplateProject } from '../types/project';

/**
 * Undo/redo history of project snapshots. Projects are immutable values, so a
 * snapshot is just a reference. Rapid edits with the same `key` (typing in a
 * property box, nudging with arrow keys) are merged into one undo step.
 */

export interface HistoryState {
  past: TemplateProject[];
  present: TemplateProject | null;
  future: TemplateProject[];
  lastKey: string | null;
  lastTime: number;
}

export type HistoryAction =
  | { type: 'load'; project: TemplateProject | null }
  | { type: 'commit'; project: TemplateProject; key?: string; now?: number }
  | { type: 'update'; update: (p: TemplateProject) => TemplateProject; key?: string; now?: number }
  | { type: 'undo' }
  | { type: 'redo' };

const LIMIT = 200;
const MERGE_WINDOW_MS = 1200;

export const initialHistory: HistoryState = { past: [], present: null, future: [], lastKey: null, lastTime: 0 };

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'load':
      return { past: [], present: action.project, future: [], lastKey: null, lastTime: 0 };
    case 'commit':
    case 'update': {
      if (!state.present) return state;
      const next = action.type === 'commit' ? action.project : action.update(state.present);
      if (next === state.present) return state;
      const stamped = { ...next, updatedAt: new Date().toISOString() };
      const now = action.now ?? Date.now();
      const merge = !!action.key && action.key === state.lastKey && now - state.lastTime < MERGE_WINDOW_MS;
      return {
        past: merge ? state.past : [...state.past, state.present].slice(-LIMIT),
        present: stamped,
        future: [],
        lastKey: action.key ?? null,
        lastTime: now,
      };
    }
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev || !state.present) return state;
      return { past: state.past.slice(0, -1), present: prev, future: [state.present, ...state.future], lastKey: null, lastTime: 0 };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next || !state.present) return state;
      return { past: [...state.past, state.present], present: next, future: state.future.slice(1), lastKey: null, lastTime: 0 };
    }
  }
}
