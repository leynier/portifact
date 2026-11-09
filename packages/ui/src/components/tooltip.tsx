import { cva } from "class-variance-authority";
import { type ReactNode, useEffect, useRef, useState } from "react";

const tooltipClasses = cva("pointer-events-auto absolute z-50 flex", {
  variants: {
    side: {
      // Padding, not margin, bridges the gap, so the pointer can move onto the tooltip.
      bottom: "top-full pt-1.5",
      top: "bottom-full pb-1.5",
    },
    align: {
      center: "left-1/2 -translate-x-1/2",
      start: "left-0",
      end: "right-0",
    },
  },
  defaultVariants: { side: "bottom", align: "center" },
});

export interface TooltipProps {
  /** The text shown. For icon buttons it repeats their accessible name. */
  label: string;
  /** The control it describes: one focusable element. */
  children: ReactNode;
  side?: "top" | "bottom" | undefined;
  /** Which edge of the control the tooltip lines up with; `end` near the right of the screen. */
  align?: "center" | "start" | "end" | undefined;
  /** Keeps it hidden, such as while the control's menu is open. */
  hidden?: boolean | undefined;
}

/**
 * A short label shown while the pointer is over the control or keyboard focus is on it. It can be
 * hovered itself and Escape hides it (WCAG 1.4.13). The control carries its own accessible name,
 * so the tooltip is hidden from assistive technology rather than read twice.
 */
export function Tooltip({ label, children, side, align, hidden = false }: TooltipProps) {
  const [open, setOpen] = useState(false);
  // Focus that follows a press came from the pointer, which already showed the tooltip.
  const pressed = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only watches its control's hover and focus.
    <span
      className="relative inline-flex"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onPointerDown={() => {
        pressed.current = true;
        setOpen(false);
      }}
      onFocus={() => {
        setOpen(!pressed.current);
        pressed.current = false;
      }}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && !hidden ? (
        <span aria-hidden="true" className={tooltipClasses({ side, align })}>
          <span className="rounded-xs bg-surface-inverse px-2 py-1 text-xs font-medium whitespace-nowrap text-text-inverse shadow-raised">
            {label}
          </span>
        </span>
      ) : null}
    </span>
  );
}
