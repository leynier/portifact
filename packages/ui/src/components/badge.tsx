import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

const badgeClasses = cva(
  "inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      emphasis: {
        // States differ by icon, label, weight and border, never by tone alone.
        normal: "border border-border-strong text-text",
        strong: "border-2 border-text font-semibold text-text",
        quiet: "border border-dashed border-border-strong text-text-muted",
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
