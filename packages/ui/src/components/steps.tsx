import { Check } from "lucide-react";

export interface Step {
  label: string;
  state: "done" | "current" | "upcoming";
}

export interface StepsProps {
  /** Names the list, such as "Publishing steps". */
  label: string;
  steps: readonly Step[];
  /** Words read after each step's label for its state, such as "done" and "not started". */
  stateLabels: { done: string; upcoming: string };
}

/**
 * Where a multi-step flow stands. The current step is marked `aria-current="step"` and drawn as a
 * selection; finished steps have a check and say "done", so nothing depends on the look.
 */
export function Steps({ label, steps, stateLabels }: StepsProps) {
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-x-2 gap-y-3 text-sm">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden="true" className="h-px w-6 bg-border-strong sm:w-10" />
          ) : null}
          <span
            aria-current={step.state === "current" ? "step" : undefined}
            className={`inline-flex h-8 items-center gap-2 rounded-xs px-2.5 ${
              step.state === "current"
                ? "selection-band font-semibold"
                : step.state === "done"
                  ? "text-text"
                  : "text-text-muted"
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-flex size-5 items-center justify-center rounded-full text-xs tabular-nums ${
                step.state === "done"
                  ? "bg-surface-inverse text-text-inverse"
                  : "border border-current"
              }`}
            >
              {step.state === "done" ? <Check className="size-3" /> : index + 1}
            </span>
            {step.label}
            {step.state === "current" ? null : (
              <span className="sr-only">
                {`, ${step.state === "done" ? stateLabels.done : stateLabels.upcoming}`}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
