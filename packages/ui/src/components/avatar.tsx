import { cva, type VariantProps } from "class-variance-authority";

const avatarClasses = cva(
  "inline-flex shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface font-semibold text-text uppercase select-none",
  {
    variants: {
      size: {
        sm: "size-6 text-xs",
        md: "size-8 text-sm",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export interface AvatarProps extends VariantProps<typeof avatarClasses> {
  /** The person's name or email; the avatar shows its first letter. */
  name: string;
}

/** The first letter of the name or email it is given, uppercased, or a dot without one. */
export function initialOf(name: string): string {
  const [first] = Array.from(name.trim());
  return first ? first.toLocaleUpperCase() : "·";
}

/**
 * A person's initial in a circle, next to their name. Decorative: the name beside it, or the
 * accessible name of the control around it, says who it is.
 */
export function Avatar({ name, size }: AvatarProps) {
  return (
    <span aria-hidden="true" className={avatarClasses({ size })}>
      {initialOf(name)}
    </span>
  );
}
