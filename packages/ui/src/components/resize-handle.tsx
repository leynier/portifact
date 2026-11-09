import type { KeyboardEvent, PointerEvent } from "react";
import { useRef } from "react";

export interface ResizeHandleProps {
  /** Names what it resizes, such as "Resize sidebar". */
  label: string;
  /** The current size in CSS pixels. */
  value: number;
  min: number;
  max: number;
  /** Pixels per arrow key press; Shift moves four times as far. */
  step?: number;
  /** Turns a pointer position (`clientX`) into a size, for example minus the panel's left edge. */
  fromPointer(clientX: number): number;
  onChange(value: number): void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(Math.max(value, min), max));

/**
 * The draggable edge of a panel: a focusable vertical `separator` with its value, so it is
 * resized with a pointer or with the arrow keys (Home and End for the limits). Place it on the
 * panel's edge, inside a positioned parent.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  step = 16,
  fromPointer,
  onChange,
}: ResizeHandleProps) {
  const dragging = useRef(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    onChange(clamp(fromPointer(event.clientX), min, max));
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? step * 4 : step;
    const next =
      event.key === "ArrowRight"
        ? value + by
        : event.key === "ArrowLeft"
          ? value - by
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next, min, max));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an `hr` cannot take focus or a value; a focusable separator is the ARIA pattern for a splitter
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -right-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center focus-visible:outline-none"
    >
      <span
        aria-hidden="true"
        className="h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-border-strong group-focus-visible:w-0.5 group-focus-visible:bg-focus"
      />
    </div>
  );
}
