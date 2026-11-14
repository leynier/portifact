// Choosing a rectangle of an image drawn in a frame, such as the viewer's "Mark a region" over a
// picture in the artifact (decision 0028). It lives in a `FrameOverlay` layer, so it is the holding
// page's own UI and is clipped to the frame. It is controlled: the page turns the reader's drag and
// keys into a region (the geometry is `packages/anchors`, region.ts) and passes it back.
import { type KeyboardEvent, type PointerEvent, useId, useLayoutEffect, useRef } from "react";
import type { OverlayPoint } from "./frame-overlay.tsx";

/** A box in the layer's pixels. */
export interface RegionSelectorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle as fractions (0 to 1) of the box. */
export interface RegionSelectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionSelectorProps {
  /** Where the image is drawn in the layer; the selector covers exactly this box. */
  box: RegionSelectorBox;
  /** The rectangle chosen now. */
  region: RegionSelectorRect;
  /** Accessible name of the surface, such as "Region of the image". */
  label: string;
  /** How to draw with the keyboard and the pointer; the surface's description. */
  instructions: string;
  /** The rectangle in words, announced politely after each change. */
  status: string;
  /** The reader dragged from `from` to `to`, both in the box's pixels (0,0 is its top left). */
  onDraw(from: OverlayPoint, to: OverlayPoint): void;
  /** An arrow key, with or without Shift. Returns whether it changed anything. */
  onKey(key: string, shift: boolean): boolean;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * A focusable surface over an image with the chosen rectangle drawn on it. Dragging draws a new
 * rectangle; arrow keys move it and Shift with arrows resizes it; Enter confirms and Escape cancels.
 * It takes focus when it mounts. Positions are set through the CSSOM, the dynamic-geometry
 * exception of the design rules.
 */
export function RegionSelector({
  box,
  region,
  label,
  instructions,
  status,
  onDraw,
  onKey,
  onConfirm,
  onCancel,
}: RegionSelectorProps) {
  const surface = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const drag = useRef<OverlayPoint | null>(null);
  const descriptionId = useId();
  const statusId = useId();

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    element.style.transform = `translate(${box.x}px, ${box.y}px)`;
    element.style.width = `${box.width}px`;
    element.style.height = `${box.height}px`;
  }, [box.x, box.y, box.width, box.height]);

  useLayoutEffect(() => {
    const element = mark.current;
    if (!element) return;
    element.style.left = `${region.x * 100}%`;
    element.style.top = `${region.y * 100}%`;
    element.style.width = `${region.width * 100}%`;
    element.style.height = `${region.height * 100}%`;
  }, [region.x, region.y, region.width, region.height]);

  useLayoutEffect(() => {
    surface.current?.focus({ preventScroll: true });
  }, []);

  const pointOf = (event: PointerEvent<HTMLDivElement>): OverlayPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = pointOf(event);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onDraw(drag.current, pointOf(event));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const from = drag.current;
    drag.current = null;
    const to = pointOf(event);
    // A click without a drag keeps the rectangle: it is not a rectangle of no size.
    if (Math.abs(to.x - from.x) >= 2 || Math.abs(to.y - from.y) >= 2) onDraw(from, to);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onConfirm();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (onKey(event.key, event.shiftKey)) event.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a drawing surface has no native element; it is a labelled group that takes focus and keys.
    <div
      ref={surface}
      role="group"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the surface takes the arrow keys that move and resize the rectangle, so it must be focusable.
      tabIndex={0}
      aria-label={label}
      aria-describedby={`${descriptionId} ${statusId}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={onKeyDown}
      className="pointer-events-auto absolute top-0 left-0 cursor-crosshair touch-none bg-text/10 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <div
        ref={mark}
        aria-hidden="true"
        className="absolute border-2 border-text bg-selection/40 ring-2 ring-canvas"
      />
      <p id={descriptionId} className="sr-only">
        {instructions}
      </p>
      <p id={statusId} className="sr-only" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
