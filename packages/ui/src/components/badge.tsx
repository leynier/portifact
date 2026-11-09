import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

const badgeClasses = cva(
  "inline-flex h-6 items-center gap-1.5 rounded-xs px-2 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      emphasis: {
        // States differ by icon, label, weight, fill and border, never by tone alone.
        normal: "border border-border-strong bg-canvas text-text",
        // A state that needs attention, such as suspended: solid and inverse.
        strong: "bg-surface-inverse font-semibold text-text-inverse",
        // A state that is resting or incomplete, such as archived or a draft.
        quiet: "border border-dashed border-border-strong text-text-muted",
        // A plain fact next to the states, such as the access mode.
        subtle: "bg-surface-hover text-text",
      },
    },
    defaultVariants: { emphasis: "normal" },
  },
);

export interface BadgeProps extends VariantProps<typeof badgeClasses> {
  /** Icon shown before the label. Decorative: the label is what is read. */
  icon?: ReactNode;
  children: ReactNode;
}

/** A short status label. It always has text; the icon only repeats it. */
export function Badge({ emphasis, icon, children }: BadgeProps) {
  return (
    <span className={badgeClasses({ emphasis })}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
