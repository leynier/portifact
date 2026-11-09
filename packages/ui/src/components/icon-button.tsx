import { cva, type VariantProps } from "class-variance-authority";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Tooltip, type TooltipProps } from "./tooltip.tsx";

/** Square controls that show only an icon; their name is in a tooltip and `aria-label`. */
export const iconButtonClasses = cva(
  "inline-flex shrink-0 items-center justify-center rounded-sm text-text no-underline transition duration-150 select-none hover:bg-surface-hover disabled:opacity-55 disabled:hover:bg-transparent aria-expanded:bg-surface-hover aria-pressed:bg-surface-hover",
  {
    variants: {
      size: {
        md: "size-10",
        sm: "size-8",
        xs: "size-7",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

type Placement = Pick<TooltipProps, "side" | "align">;

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "aria-label">,
    VariantProps<typeof iconButtonClasses>,
    Placement {
  /** The accessible name, also shown as the tooltip. */
  label: string;
  /** The icon, hidden from assistive technology. */
  icon: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  /** Disabled and marked busy while an action runs. */
  busy?: boolean;
  /** Keeps the tooltip hidden, such as while the button's menu is open. */
  hideTooltip?: boolean | undefined;
}

/** A button with only an icon, for secondary actions in bars and cards. */
export function IconButton({
  label,
  icon,
  size,
  side,
  align,
  busy = false,
  disabled,
  hideTooltip,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label} side={side} align={align} hidden={hideTooltip}>
      <button
        {...rest}
        type={type}
        aria-label={label}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        className={iconButtonClasses({ size })}
      >
        <span
          aria-hidden="true"
          className={`inline-flex ${busy ? "motion-safe:animate-shimmer" : ""}`}
        >
          {icon}
        </span>
      </button>
    </Tooltip>
  );
}

export interface IconLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children" | "aria-label">,
    VariantProps<typeof iconButtonClasses>,
    Placement {
  label: string;
  icon: ReactNode;
  href: string;
}

/** A link that looks like an icon button, such as going to the dashboard from the viewer's bar. */
export function IconLink({ label, icon, href, size, side, align, ...rest }: IconLinkProps) {
  return (
    <Tooltip label={label} side={side} align={align}>
      <a {...rest} href={href} aria-label={label} className={iconButtonClasses({ size })}>
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      </a>
    </Tooltip>
  );
}
