import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Classes of the button variants, also used by links that look like buttons. */
export const buttonClasses = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-opacity disabled:opacity-60 motion-reduce:transition-none",
  {
    variants: {
      intent: {
        primary:
          "rounded-md bg-surface-inverse text-text-inverse no-underline hover:opacity-85 disabled:hover:opacity-60",
        secondary:
          "rounded-md border border-border-strong bg-canvas text-text no-underline hover:opacity-85 disabled:hover:opacity-60",
        link: "text-text underline underline-offset-4",
      },
      size: {
        md: "h-11 px-5 text-sm",
        sm: "h-9 px-3 text-sm",
        inline: "text-sm",
      },
    },
    compoundVariants: [{ intent: "link", class: "h-auto px-0" }],
    defaultVariants: { intent: "secondary", size: "md" },
  },
);

export type ButtonVariants = VariantProps<typeof buttonClasses>;

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">,
    ButtonVariants {
  /** Leading icon, hidden from assistive technology; the label carries the meaning. */
  icon?: ReactNode;
  /**
   * While true the button is disabled and marked busy. Pair it with a polite announcement:
   * a spinner alone never tells anyone what happens.
   */
  busy?: boolean;
}

export function Button({
  intent,
  size,
  icon,
  busy = false,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={buttonClasses({ intent, size })}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}
