// Placing the viewer's inline comment controls over the artifact frame. The bridge reports where
// the reader's selection is drawn, but the page shares the bridge's window and can report any
// rectangle, so the viewer treats it as a hint: it keeps only the part inside the frame's visible
// box, hides its controls when nothing is left, and places them so they never leave the frame.
// Nothing here can put the viewer's UI over the bar, the caption or the sidebar.
import { BRIDGE_LIMITS, type FrameRect } from "./protocol.ts";

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

const finite = (...values: number[]) => values.every((value) => Number.isFinite(value));

/**
 * The part of `rect` inside a frame of `frame` size (the frame's own viewport, from 0,0), or null
 * when none of it is, the frame has no size, or a value is not a finite number.
 */
export function visibleRect(rect: FrameRect, frame: Size): FrameRect | null {
  if (!finite(rect.x, rect.y, rect.width, rect.height, frame.width, frame.height)) return null;
  if (rect.width < 0 || rect.height < 0 || frame.width <= 0 || frame.height <= 0) return null;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(frame.width, rect.x + rect.width);
  const bottom = Math.min(frame.height, rect.y + rect.height);
  if (right < left || bottom < top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The top left corner for a box of `size` beside `anchor` (a rectangle already inside the frame):
 * below it, else above it, else as close as fits, aligned with its left edge and always wholly
 * inside the frame. Null when the box does not fit in the frame at all, where the viewer falls
 * back to a bottom sheet.
 */
export function placeNear(anchor: FrameRect, size: Size, frame: Size, gap = 8): Point | null {
  if (!finite(size.width, size.height, frame.width, frame.height, gap)) return null;
  if (size.width > frame.width || size.height > frame.height) return null;
  const inside = visibleRect(anchor, frame);
  if (!inside) return null;
  const x = clamp(inside.x, 0, frame.width - size.width);
  const below = inside.y + inside.height + gap;
  const above = inside.y - gap - size.height;
  let y: number;
  if (below + size.height <= frame.height) y = below;
  else if (above >= 0) y = above;
  else y = clamp(below, 0, frame.height - size.height);
  return { x: Math.round(x), y: Math.round(y) };
}

const limit = BRIDGE_LIMITS.rectMaxPixels;

/** A DOM rectangle as the protocol carries it: whole pixels within the protocol's bounds. */
export function frameRect(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): FrameRect | null {
  if (!finite(rect.left, rect.top, rect.width, rect.height)) return null;
  return {
    x: clamp(Math.round(rect.left), -limit, limit),
    y: clamp(Math.round(rect.top), -limit, limit),
    width: clamp(Math.round(rect.width), 0, limit),
    height: clamp(Math.round(rect.height), 0, limit),
  };
}
