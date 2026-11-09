import { cva } from "class-variance-authority";
import { type ReactNode, useEffect, useRef, useState } from "react";

const tooltipClasses = cva("pointer-events-auto absolute z-50 flex", {
  variants: {
    side: {
      // Padding, not margin, bridges the gap, so the pointer can move onto the tooltip.
      bottom: "top-full pt-1.5",
      top: "bottom-full pb-1.5",
      right: "top-1/2 left-full -translate-y-1/2 pl-2",
    },
    align: {
      center: "",
      start: "",
      end: "",
    },
  },
  // Above and below, `align` lines the tooltip up with the control; beside it, it is centered.
  compoundVariants: [
    { side: ["top", "bottom"], align: "center", class: "left-1/2 -translate-x-1/2" },
    { side: ["top", "bottom"], align: "start", class: "left-0" },
    { side: ["top", "bottom"], align: "end", class: "right-0" },
  ],
  defaultVariants: { side: "bottom", align: "center" },
});

/** Hides the tooltip shown now, so a focused control and a hovered one never show two at once. */
let hideShown: (() => void) | null = null;

export interface TooltipProps {
  /** The text shown. For icon buttons it repeats their accessible name. */
  label: string;
  /** The control it describes: one focusable element. */
  children: ReactNode;
  side?: "top" | "bottom" | "right" | undefined;
  /** Which edge of the control the tooltip lines up with, above or below it; `end` near the right of the screen. */
  align?: "center" | "start" | "end" | undefined;
  /** Keeps it hidden, such as while the control's menu is open. */
  hidden?: boolean | undefined;
  /** Renders only the control, for example while the label it repeats is already visible. */
  disabled?: boolean | undefined;
  /** Fill the width of the parent, for controls that span a row such as navigation items. */
  block?: boolean | undefined;
}

/**
 * A short label shown while the pointer is over the control or keyboard focus is on it. It can be
 * hovered itself and Escape hides it (WCAG 1.4.13); only one shows at a time. The control carries
 * its own accessible name, so the tooltip is hidden from assistive technology rather than read
 * twice.
 */
export function Tooltip({
  label,
  children,
  side,
  align,
  hidden = false,
  disabled = false,
  block = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  // Focus that follows a press came from the pointer, which already showed the tooltip.
  const pressed = useRef(false);

  useEffect(() => {
    if (!open) return;
    const hide = () => setOpen(false);
    if (hideShown && hideShown !== hide) hideShown();
    hideShown = hide;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (hideShown === hide) hideShown = null;
    };
  }, [open]);

  if (disabled) return <>{children}</>;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only watches its control's hover and focus.
    <span
      className={block ? "relative flex" : "relative inline-flex"}
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
        <span aria-hidden="true" data-tooltip="" className={tooltipClasses({ side, align })}>
          <span className="rounded-xs bg-surface-inverse px-2 py-1 text-xs font-medium whitespace-nowrap text-text-inverse shadow-raised">
            {label}
          </span>
        </span>
      ) : null}
    </span>
  );
}
