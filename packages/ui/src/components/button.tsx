import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

/** Classes of the button variants, also used by links that look like buttons. */
export const buttonClasses = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 font-medium whitespace-nowrap no-underline transition duration-150 select-none disabled:opacity-55 motion-safe:active:translate-y-px",
  {
    variants: {
      intent: {
        // The one action that moves the screen forward. Inverse, so it leads in both themes.
        primary:
          "rounded-sm bg-surface-inverse text-text-inverse shadow-sm hover:opacity-85 disabled:hover:opacity-55",
        secondary:
          "rounded-sm border border-border-strong bg-canvas text-text hover:bg-surface-hover disabled:hover:bg-canvas",
        // Quiet actions in toolbars, rows and navigation; the label and icon carry them.
        ghost: "rounded-sm text-text hover:bg-surface-hover disabled:hover:bg-transparent",
        link: "text-text underline underline-offset-4 hover:decoration-2",
        // Floats over content, such as the "Comment" control next to a selection in the viewer.
        floating:
          "rounded-sm bg-surface-inverse text-text-inverse shadow-float hover:opacity-85 disabled:hover:opacity-55",
      },
      size: {
        md: "h-10 px-4 text-sm",
        sm: "h-8 px-3 text-sm",
        inline: "text-sm",
      },
    },
    compoundVariants: [
      { intent: "link", class: "h-auto px-0" },
      { intent: "ghost", size: "md", class: "px-3" },
      { intent: "ghost", size: "sm", class: "px-2" },
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
        <span
          aria-hidden="true"
          className={`inline-flex shrink-0 ${busy ? "motion-safe:animate-shimmer" : ""}`}
        >
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}
