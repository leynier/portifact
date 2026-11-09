import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

// The left edge is a selection handle: thick for errors and results, thin for information.
const calloutClasses = cva("flex gap-3 rounded-md border bg-canvas p-4 text-sm", {
  variants: {
    tone: {
      error: "border-border-strong border-l-4 border-l-text",
      success: "border-border border-l-4 border-l-text",
      info: "border-border border-l-2 border-l-border-strong",
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
