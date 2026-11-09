import { type ReactNode, useLayoutEffect, useRef } from "react";

export interface OverlaySize {
  width: number;
  height: number;
}

export interface OverlayPoint {
  x: number;
  y: number;
}

export interface FrameOverlayProps {
  /** The frame the layer covers, such as the artifact iframe. */
  children: ReactNode;
  /** What floats over the frame; it is clipped to the frame's box and never leaves it. */
  layer?: ReactNode;
}

/**
 * A frame with a layer over it for controls drawn by the page that holds the frame, such as the
 * viewer's "Comment" control next to a selection in the artifact. The layer has exactly the
 * frame's box and clips what it holds, so nothing in it can cover anything outside the frame.
 * The layer lets pointer events through to the frame; only the floating controls take them.
 */
export function FrameOverlay({ children, layer }: FrameOverlayProps) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children}
      {layer ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">{layer}</div>
      ) : null}
    </div>
  );
}

export interface FloatingProps {
  /**
   * Where the floating content's top left corner goes, given its size and the layer's size, or
   * null to hide it. Called after every render and whenever the layer is resized.
   */
  place(size: OverlaySize, area: OverlaySize): OverlayPoint | null;
  /** Called with whether it could be placed, for example to fall back to another layout. */
  onPlaced?(placed: boolean): void;
  /**
   * Fixed across the bottom of the screen instead of placed, for a bottom sheet. Switching keeps
   * the content mounted, so nothing typed into it is lost.
   */
  sheet?: boolean;
  children: ReactNode;
}

/**
 * Content positioned inside a `FrameOverlay` layer. Its coordinates are the only styles set at
 * runtime (through the CSSOM, which the strict page policy allows), the dynamic-geometry exception
 * of the design rules.
 */
export function Floating({ place, onPlaced, sheet = false, children }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ place, onPlaced, sheet });
  latest.current = { place, onPlaced, sheet };
  const placed = useRef<boolean | null>(null);

  const position = () => {
    const element = ref.current;
    const area = element?.parentElement;
    if (!element || !area) return;
    if (latest.current.sheet) {
      element.style.visibility = "visible";
      element.style.transform = "";
      return;
    }
    const point = latest.current.place(
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: area.clientWidth, height: area.clientHeight },
    );
    element.style.visibility = point ? "visible" : "hidden";
    if (point) element.style.transform = `translate(${point.x}px, ${point.y}px)`;
    if (placed.current !== (point !== null)) {
      placed.current = point !== null;
      latest.current.onPlaced?.(point !== null);
    }
  };

  // After every render: the anchor or the content may have changed.
  useLayoutEffect(position);
  useLayoutEffect(() => {
    const area = ref.current?.parentElement;
    if (!area || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => position());
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={
        sheet
          ? "pointer-events-auto fixed inset-x-0 bottom-0 z-40"
          : "pointer-events-auto invisible absolute top-0 left-0"
      }
    >
      {children}
    </div>
  );
}

export interface FloatingPanelProps {
  /** Accessible name of the panel, such as "Comment on the selection". */
  label: string;
  /**
   * A bottom sheet across the screen instead of a compact panel beside its anchor, for narrow
   * screens or when the panel does not fit in the frame.
   */
  sheet?: boolean;
  children: ReactNode;
}

/**
 * A compact non-modal panel, such as the viewer's inline comment composer, inside a `Floating`:
 * beside its anchor, or as a bottom sheet across the screen. It does not trap focus; the content
 * moves focus into it and closes it with Escape.
 */
export function FloatingPanel({ label, sheet = false, children }: FloatingPanelProps) {
  return (
    <section
      aria-label={label}
      className={
        sheet
          ? "flex max-h-dvh flex-col gap-3 overflow-y-auto rounded-t-lg border-t border-border-strong bg-canvas p-4 text-text shadow-float motion-safe:animate-pop"
          : "flex w-80 max-w-full flex-col gap-3 rounded-lg border border-border-strong bg-canvas p-3 text-text shadow-float motion-safe:animate-pop"
      }
    >
      {children}
    </section>
  );
}
