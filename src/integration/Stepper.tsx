/**
 * The unified 4-step guided-workflow indicator for the Studio integration:
 * Design -> Configure Data -> Upload Participants -> Generate & Download.
 *
 * This single component is reused on both sides of the Studio flow: the
 * React app (StudioApp.tsx, steps 1/2/4) and the plain-Blade participant
 * upload page (step 3, resources/views/admin/pdf-studio/prepare.blade.php)
 * — see stepper.css and the inline markup in that Blade file, which mirror
 * these class names and step list exactly so the indicator looks and
 * behaves identically wherever the admin is in the flow.
 */
import './stepper.css';
import { STEPS, type StepKey } from './steps';

export type { StepKey };

export function Stepper({
  current,
  completed,
  onNavigate,
}: {
  current: StepKey;
  /** Steps the admin has already reached a valid state for; drives the checkmark and makes the step clickable. */
  completed: Set<StepKey>;
  /** Called when the admin clicks an already-completed step, or the current step, to jump back to it. Steps that are neither completed nor current are not clickable. */
  onNavigate: (step: StepKey) => void;
}) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="studio-stepper" aria-label="Certificate workflow steps">
      {STEPS.map((step, i) => {
        const isCurrent = step.key === current;
        const isDone = completed.has(step.key) && !isCurrent;
        const isClickable = isDone || isCurrent;
        const isFuture = i > currentIndex && !completed.has(step.key);
        return (
          <li
            key={step.key}
            className={`studio-step${isCurrent ? ' studio-step--current' : ''}${isDone ? ' studio-step--done' : ''}${isFuture ? ' studio-step--future' : ''}`}
          >
            <button
              type="button"
              className="studio-step__button"
              disabled={!isClickable}
              aria-current={isCurrent ? 'step' : undefined}
              onClick={() => isClickable && onNavigate(step.key)}
              title={step.helper}
            >
              <span className="studio-step__badge" aria-hidden="true">
                {isDone ? '✓' : i + 1}
              </span>
              <span className="studio-step__text">
                <span className="studio-step__label">{step.label}</span>
                <span className="studio-step__helper">{step.helper}</span>
              </span>
            </button>
            {i < STEPS.length - 1 && <span className="studio-step__connector" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
