import { type KeyboardEvent, useId, useState } from "react";

export interface BarChartDatum {
  /** Unique and stable, such as an ISO date. */
  key: string;
  /** Short axis label, such as "8 Nov". */
  label: string;
  value: number;
  /** The whole datum in words, read and shown when the bar is selected, such as "8 Nov: 12 views". */
  description: string;
}

export interface BarChartProps {
  /** What the chart shows, such as "Views per day". It names the chart. */
  label: string;
  /** The series in words for assistive technology, such as the total and the busiest day. */
  summary: string;
  data: readonly BarChartDatum[];
  /** How to move between bars, shown under the chart, such as "Use the arrow keys to pick a day". */
  keyboardHint: string;
}

/** Height of the plot in viewBox units; the width is ten units per bar. */
const PLOT_HEIGHT = 100;
const BAR_WIDTH = 10;
const GAP = 2;

/**
 * A single-series bar chart, drawn in the text color so it reads in both themes, with nothing
 * told by color: one series, and the selected bar is marked by a tick under it and described in
 * words. The plot is one focusable group: Left and Right (and Home and End) select a bar and its
 * description is announced; pointer users select by hovering or clicking. It is a summary for
 * sighted users, so screens must also offer the numbers as a table.
 */
export function BarChart({ label, summary, data, keyboardHint }: BarChartProps) {
  const id = useId();
  const [selected, setSelected] = useState(Math.max(data.length - 1, 0));
  const index = Math.min(selected, Math.max(data.length - 1, 0));
  const max = Math.max(1, ...data.map((datum) => datum.value));
  const width = Math.max(data.length, 1) * BAR_WIDTH;
  const current = data[index];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = data.length - 1;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(index - 1, 0)
        : event.key === "ArrowRight"
          ? Math.min(index + 1, last)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setSelected(next);
  }

  return (
    <figure className="flex flex-col gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this is a chart. */}
      <div
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot is one stop that arrow keys move within.
        tabIndex={0}
        aria-label={label}
        aria-describedby={`${id}-summary ${id}-current ${id}-hint`}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-1 rounded-md text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <div className="flex items-baseline justify-between text-xs text-text-muted tabular-nums">
          <span aria-hidden="true">{max}</span>
        </div>
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${width} ${PLOT_HEIGHT + 6}`}
          preserveAspectRatio="none"
          className="h-40 w-full"
        >
          <line
            x1={0}
            x2={width}
            y1={PLOT_HEIGHT}
            y2={PLOT_HEIGHT}
            stroke="currentColor"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
            className="text-border"
          />
          {data.map((datum, i) => {
            const height = (datum.value / max) * PLOT_HEIGHT;
            const x = i * BAR_WIDTH + GAP / 2;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; the group is the keyboard control.
              <g
                key={datum.key}
                data-selected={i === index ? "true" : undefined}
                onPointerEnter={() => setSelected(i)}
                onClick={() => setSelected(i)}
              >
                <rect
                  x={i * BAR_WIDTH}
                  y={0}
                  width={BAR_WIDTH}
                  height={PLOT_HEIGHT}
                  fill="transparent"
                />
                <rect
                  x={x}
                  y={PLOT_HEIGHT - height}
                  width={BAR_WIDTH - GAP}
                  height={height}
                  fill="currentColor"
                  className={i === index ? "text-text" : "text-text-muted"}
                />
                {i === index ? (
                  <rect
                    x={x}
                    y={PLOT_HEIGHT + 2}
                    width={BAR_WIDTH - GAP}
                    height={4}
                    fill="currentColor"
                    className="text-text"
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
        <div
          aria-hidden="true"
          className="flex items-baseline justify-between gap-2 text-xs text-text-muted"
        >
          <span>{data[0]?.label}</span>
          <span>{data.at(-1)?.label}</span>
        </div>
      </div>
      <figcaption className="flex flex-col gap-1">
        <span id={`${id}-summary`} className="sr-only">
          {summary}
        </span>
        <span id={`${id}-current`} aria-live="polite" className="text-sm font-medium tabular-nums">
          {current?.description}
        </span>
        <span id={`${id}-hint`} className="text-xs text-text-muted">
          {keyboardHint}
        </span>
      </figcaption>
    </figure>
  );
}
