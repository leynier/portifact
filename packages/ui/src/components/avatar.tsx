import { cva } from "class-variance-authority";
import { useState } from "react";

const avatarClasses = cva(
  "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-inverse font-semibold text-text-inverse select-none",
  {
    variants: {
      size: { sm: "size-8 text-xs", md: "size-10 text-sm" },
    },
    defaultVariants: { size: "sm" },
  },
);

export interface AvatarProps {
  /** The person's name; the initials come from it, or from `email` without one. */
  name: string;
  email?: string;
  /** A picture of the person. While it fails to load, the initials show instead. */
  image?: string | null | undefined;
  size?: "sm" | "md";
}

/** Up to two initials: the first letters of the first and last words, or of the address. */
export function initials(name: string, email = ""): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  if (first) return `${[...first][0] ?? ""}${last ? ([...last][0] ?? "") : ""}`.toUpperCase();
  const local = email.split("@")[0] ?? "";
  return ([...local][0] ?? "?").toUpperCase();
}

/**
 * A person's picture or initials in a circle. Decorative: the name next to it carries the
 * meaning, so the avatar is hidden from assistive technology.
 */
export function Avatar({ name, email, image, size }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = Boolean(image) && failed !== image;
  return (
    <span aria-hidden="true" className={avatarClasses({ size })}>
      {showImage ? (
        <img
          src={image ?? undefined}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(image ?? null)}
        />
      ) : (
        initials(name, email)
      )}
    </span>
  );
}
