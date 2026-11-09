import { cva } from "class-variance-authority";
import { type ReactNode, useEffect, useState } from "react";

const bubbleClasses = cva(
  "pointer-events-none absolute z-50 rounded-xs bg-surface-inverse px-2 py-1 text-xs font-medium whitespace-nowrap text-text-inverse shadow-raised motion-safe:animate-fade",
  {
    variants: {
      side: {
        right: "top-1/2 left-full ml-2 -translate-y-1/2",
        top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
      },
    },
    defaultVariants: { side: "right" },
  },
);

export interface TooltipProps {
  /** The text shown. It must repeat the control's accessible name, which carries the meaning. */
  label: string;
  side?: "right" | "top";
  /** Renders only the control, for example while the label it repeats is already visible. */
  disabled?: boolean;
  /** Fill the width of the parent, for controls that span a row such as navigation items. */
  block?: boolean;
  children: ReactNode;
}

/**
 * A short label shown next to a control while it is hovered or focused, for icon buttons and
 * the collapsed sidebar. It repeats the control's own name, so it is hidden from assistive
 * technology; Escape hides it without moving focus (WCAG 1.4.13).
 */
export function Tooltip({ label, side, disabled = false, block = false, children }: TooltipProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (disabled) return <>{children}</>;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only watches its control's hover and focus
    <span
      className={block ? "relative flex" : "relative inline-flex"}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? (
        <span aria-hidden="true" data-tooltip="" className={bubbleClasses({ side })}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
