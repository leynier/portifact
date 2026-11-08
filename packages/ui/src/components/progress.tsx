import { useId } from "react";

export interface ProgressBarProps {
  /** What is progressing, shown above the bar and used as its accessible name. */
  label: string;
  /** Done so far, from 0 to `max`; omit it while the amount is unknown. */
  value?: number | undefined;
  max: number;
  /** Progress in words, such as "3 of 8 files, 2.1 MB of 9 MB", read with the bar. */
  valueText: string;
}

/**
 * A labelled native `progress` with its progress in words beside it. The words carry the
 * meaning; the bar is a visual aid. Announce milestones through a live region separately, since
 * a changing bar is not read out on its own.
 */
export function ProgressBar({ label, value, max, valueText }: ProgressBarProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span id={`${id}-label`} className="font-medium">
          {label}
        </span>
        <span id={`${id}-text`} className="text-text-muted">
          {valueText}
        </span>
      </div>
      <progress
        className="progress-bar"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-text`}
        aria-valuetext={valueText}
        max={max}
        {...(value === undefined ? {} : { value: Math.min(Math.max(value, 0), max) })}
      />
    </div>
  );
}
