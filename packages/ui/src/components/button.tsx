import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

/** Classes of the button variants, also used by links that look like buttons. */
export const buttonClasses = cva(
  // Labels stay on one line while they fit; a label longer than its container (a long
  // translation on a narrow screen) wraps inside the button instead of overflowing the page.
  "inline-flex max-w-full shrink-0 items-center justify-center gap-2 text-center font-medium text-balance no-underline transition duration-150 select-none disabled:opacity-55 motion-safe:active:translate-y-px",
  {
    variants: {
      intent: {
        // The one action that moves the screen forward. Inverse, so it leads in both themes.
        primary:
          "rounded-sm bg-surface-inverse text-text-inverse shadow-sm hover:opacity-85 disabled:hover:opacity-55",
        secondary:
          "rounded-sm border border-border-strong bg-canvas text-text hover:bg-surface-hover disabled:hover:bg-canvas aria-pressed:border-text aria-pressed:bg-surface-hover",
        // A secondary action that ends or removes something, such as disconnecting an app: a
        // dashed border at rest and the inverse fill on hover, never a hue. Pair it with an icon
        // and a confirmation.
        danger:
          "rounded-sm border border-dashed border-border-strong bg-canvas text-text hover:border-solid hover:border-text hover:bg-surface-inverse hover:text-text-inverse disabled:hover:border-dashed disabled:hover:border-border-strong disabled:hover:bg-canvas disabled:hover:text-text",
        // Quiet actions in toolbars, rows and navigation; the label and icon carry them.
        ghost: "rounded-sm text-text hover:bg-surface-hover disabled:hover:bg-transparent",
        link: "text-text underline underline-offset-4 hover:decoration-2",
        // Floats over content, such as the "Comment" control next to a selection in the viewer.
        floating:
          "rounded-sm bg-surface-inverse text-text-inverse shadow-float hover:opacity-85 disabled:hover:opacity-55",
        // Looks like an empty field and opens a form in place, such as a thread's reply box.
        field:
          "w-full justify-start rounded-sm border border-border bg-canvas text-left font-normal text-text-muted hover:border-border-strong hover:text-text",
      },
      size: {
        md: "min-h-10 px-4 py-1.5 text-sm",
        sm: "min-h-8 px-3 py-1 text-sm",
        inline: "text-sm",
      },
    },
    compoundVariants: [
      { intent: "link", class: "min-h-0 px-0 py-0" },
      { intent: "ghost", size: "md", class: "px-3" },
      { intent: "ghost", size: "sm", class: "px-2" },
      { intent: "field", size: "sm", class: "px-2.5" },
    ],
    defaultVariants: { intent: "secondary", size: "md" },
  },
);

export type ButtonVariants = VariantProps<typeof buttonClasses>;

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">,
    ButtonVariants {
  /** The button element, for moving focus back to it. */
  ref?: Ref<HTMLButtonElement>;
  /** Leading icon, hidden from assistive technology; the label carries the meaning. */
  icon?: ReactNode;
  /**
   * While true the button is disabled and marked busy. Pair it with a polite announcement:
   * a spinner alone never tells anyone what happens.
   */
  busy?: boolean;
  /**
   * A count shown after the label, such as open threads. `label` is what screen readers hear
   * instead of the bare number, for example "(3 open)".
   */
  count?: { value: number; label: string } | undefined;
}

export function Button({
  intent,
  size,
  icon,
  busy = false,
  disabled,
  type = "button",
  count,
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
        <span
          aria-hidden="true"
          className={`inline-flex shrink-0 ${busy ? "motion-safe:animate-shimmer" : ""}`}
        >
          {icon}
        </span>
      ) : null}
      {children}
      {count ? (
        <>
          <span
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs bg-surface-inverse px-1 text-xs font-semibold text-text-inverse tabular-nums"
          >
            {count.value}
          </span>
          <span className="sr-only"> {count.label}</span>
        </>
      ) : null}
    </button>
  );
}
