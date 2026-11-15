// Geometry of image regions (decision 0028): a rectangle of an image as fractions of the image's
// box, so it follows the image wherever and however large the page draws it. The viewer turns the
// reader's pointer or keys into a region here, the bridge turns a stored region back into a box,
// and both map an image's URL to its file in the version the same way. Pure, no DOM.
import { AnchorPath, IMAGE_REGION_LIMITS } from "@portifact/contracts";

/** A rectangle in CSS pixels. */
export interface PixelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A point in CSS pixels, in the same space as the image's box. */
export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

/** A rectangle as fractions of the image's box: every value between 0 and 1. */
export interface RegionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const SCALE = 10 ** IMAGE_REGION_LIMITS.decimals;
const MIN = IMAGE_REGION_LIMITS.minExtent;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const finite = (...values: number[]) => values.every((value) => Number.isFinite(value));
/** Down to the grid of four decimals, so a rounded corner never leaves the image. */
const floorFraction = (value: number) => Math.floor(value * SCALE + 1e-6) / SCALE;
const roundFraction = (value: number) => Math.round(value * SCALE) / SCALE;

/** The region a new layer starts with: the middle half of the image. */
export const INITIAL_REGION: RegionRect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

/** How far one key press moves or resizes the region, as a fraction of the image. */
export const REGION_STEP = 0.02;

/**
 * A region that satisfies the contract (`ImageRegionRequest`): four decimals, each side at least
 * the minimum, wholly inside the image. Sizes are kept when they fit; a corner is moved in, never
 * the size cut, unless the size itself is larger than the image.
 */
export function normalizeRegion(rect: RegionRect): RegionRect {
  const width = clamp(finite(rect.width) ? roundFraction(rect.width) : MIN, MIN, 1);
  const height = clamp(finite(rect.height) ? roundFraction(rect.height) : MIN, MIN, 1);
  const x = clamp(finite(rect.x) ? floorFraction(rect.x) : 0, 0, roundFraction(1 - width));
  const y = clamp(finite(rect.y) ? floorFraction(rect.y) : 0, 0, roundFraction(1 - height));
  return { x, y, width, height };
}

/**
 * The region between two points the reader dragged between over an image drawn at `box`, clamped
 * to the image and grown to the minimum size. Null when the box has no area or a value is not a
 * finite number.
 */
export function regionFromDrag(from: PixelPoint, to: PixelPoint, box: PixelBox): RegionRect | null {
  if (!finite(from.x, from.y, to.x, to.y, box.x, box.y, box.width, box.height)) return null;
  if (box.width <= 0 || box.height <= 0) return null;
  const fx = (value: number) => clamp((value - box.x) / box.width, 0, 1);
  const fy = (value: number) => clamp((value - box.y) / box.height, 0, 1);
  const left = Math.min(fx(from.x), fx(to.x));
  const top = Math.min(fy(from.y), fy(to.y));
  const right = Math.max(fx(from.x), fx(to.x));
  const bottom = Math.max(fy(from.y), fy(to.y));
  return normalizeRegion({ x: left, y: top, width: right - left, height: bottom - top });
}

/** Where a region is drawn over an image whose box is `box`, in the box's pixels. */
export function regionBox(region: RegionRect, box: PixelBox): PixelBox {
  return {
    x: box.x + region.x * box.width,
    y: box.y + region.y * box.height,
    width: region.width * box.width,
    height: region.height * box.height,
  };
}

/** Moves a region by fractions of the image, stopping at its edges. */
export function moveRegion(region: RegionRect, dx: number, dy: number): RegionRect {
  return normalizeRegion({ ...region, x: region.x + dx, y: region.y + dy });
}

/**
 * Resizes a region by fractions of the image from its top left corner, never below the minimum
 * or past the right or bottom edge.
 */
export function resizeRegion(region: RegionRect, dw: number, dh: number): RegionRect {
  return normalizeRegion({
    ...region,
    width: clamp(region.width + dw, MIN, 1 - region.x),
    height: clamp(region.height + dh, MIN, 1 - region.y),
  });
}

/** What one key press does to a region, or null for a key the layer leaves alone. */
export function regionKey(
  region: RegionRect,
  key: string,
  shift: boolean,
  step = REGION_STEP,
): RegionRect | null {
  const direction: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const move = direction[key];
  if (!move) return null;
  const [dx, dy] = move;
  return shift
    ? resizeRegion(region, dx * step, dy * step)
    : moveRegion(region, dx * step, dy * step);
}

/** A region's edges in whole percentages, for announcing and showing it. */
export function regionPercent(region: RegionRect): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const percent = (value: number) => Math.round(value * 100);
  return {
    left: percent(region.x),
    top: percent(region.y),
    right: percent(region.x + region.width),
    bottom: percent(region.y + region.height),
  };
}

/**
 * The file in the version an image shows, from its absolute URL: the path on the artifact's own
 * `origin`, without the leading slash, percent-decoded. Null for any other origin, a `data:` or
 * `blob:` URL, the root, or a path that is not a valid file path.
 */
export function imagePath(url: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || parsed.origin === "null") return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
  return AnchorPath.safeParse(path).success ? path : null;
}
