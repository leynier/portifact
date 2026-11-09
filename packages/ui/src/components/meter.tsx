import { CircleAlert } from "lucide-react";
import { useId } from "react";

export interface MeterProps {
  /** What is measured, such as "Storage". It names the meter. */
  label: string;
  value: number;
  max: number;
  /** The amount in words, such as "1.2 GB of 5 GB", read with the meter. */
  valueText: string;
  /**
   * Shown with an icon from 80% of `max`, such as "Near the limit", so a quota close to its end
   * reads in words as well as in the bar's pattern.
   */
  nearLimitLabel: string;
  /** Shown instead of `nearLimitLabel` once `value` reaches `max`. */
  atLimitLabel: string;
}

const NEAR = 0.8;

/**
 * How much of a limit is used: a native `meter` with its amount in words. The bar turns hatched
 * near the limit, and the words say so, never the tone alone.
 */
export function Meter({ label, value, max, valueText, nearLimitLabel, atLimitLabel }: MeterProps) {
  const id = useId();
  const limit = Math.max(max, 0);
  const clamped = Math.min(Math.max(value, 0), limit);
  const high = limit * NEAR;
  const state = limit > 0 && value >= limit ? "at" : limit > 0 && value >= high ? "near" : "ok";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span id={`${id}-label`} className="text-sm font-medium">
          {label}
        </span>
        <span id={`${id}-text`} className="text-sm text-text-muted tabular-nums">
          {valueText}
        </span>
      </div>
      <meter
        className="meter-bar"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-text${state === "ok" ? "" : ` ${id}-state`}`}
        min={0}
        max={limit || 1}
        low={high}
        high={high}
        optimum={0}
        value={clamped}
      />
      {state === "ok" ? null : (
        <p id={`${id}-state`} className="flex items-center gap-1.5 text-xs font-semibold">
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {state === "at" ? atLimitLabel : nearLimitLabel}
        </p>
      )}
    </div>
  );
}
