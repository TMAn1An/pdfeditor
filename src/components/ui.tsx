import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { Severity } from '../types/project';

export function SeverityIcon({ severity, size = 16 }: { severity: Severity | 'ok'; size?: number }) {
  switch (severity) {
    case 'error':
      return <AlertCircle size={size} className="sev-error" aria-label="Error" />;
    case 'warning':
      return <AlertTriangle size={size} className="sev-warning" aria-label="Warning" />;
    case 'info':
      return <Info size={size} className="sev-info" aria-label="Note" />;
    default:
      return <CheckCircle2 size={size} className="sev-ok" aria-label="OK" />;
  }
}

export function IssueList({ issues, empty }: { issues: { severity: Severity; message: string }[]; empty?: ReactNode }) {
  if (issues.length === 0) return empty ? <p className="muted">{empty}</p> : null;
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <ul className="issue-list">
      {sorted.map((i, n) => (
        <li key={n} className={`issue issue-${i.severity}`}>
          <SeverityIcon severity={i.severity} />
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function Labeled({ label, children, hint, inline }: { label: string; children: (id: string) => ReactNode; hint?: string; inline?: boolean }) {
  const id = useId();
  return (
    <div className={`labeled${inline ? ' labeled-inline' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step = 1,
  ariaLabel,
}: {
  id?: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      value={Number.isFinite(value) ? Math.round(value * 100) / 100 : ''}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onChange={(e) => {
        const n = Number.parseFloat(e.target.value);
        if (Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)));
      }}
    />
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="progress-fill" style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} />
    </div>
  );
}
