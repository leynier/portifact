import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

const calloutClasses = cva("flex gap-3 rounded-md p-4 text-sm", {
  variants: {
    tone: {
      error: "border-2 border-text bg-surface",
      info: "border border-border-strong bg-surface",
    },
  },
  defaultVariants: { tone: "info" },
});

export interface CalloutProps extends VariantProps<typeof calloutClasses> {
  title: string;
  icon?: ReactNode;
  /** Optional control, such as a retry button. */
  action?: ReactNode;
  children?: ReactNode;
}

/**
 * A message about the page or a section. Errors are announced as alerts, everything else
 * politely, so assistive technology hears it when it appears.
 */
export function Callout({ tone, title, icon, action, children }: CalloutProps) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={calloutClasses({ tone })}>
      {icon ? (
        <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children ? <div className="mt-1 text-text-muted">{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}
