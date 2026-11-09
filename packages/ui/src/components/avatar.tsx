import { cva } from "class-variance-authority";
import { useState } from "react";

const avatarClasses = cva(
  "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold uppercase select-none",
  {
    variants: {
      size: { sm: "size-6 text-xs", md: "size-8 text-sm", lg: "size-10 text-sm" },
      /**
       * `outline` sits quietly next to a name, such as a comment's author; `solid` stands for the
       * signed-in account, such as in the sidebar and on the profile.
       */
      tone: {
        outline: "border border-border-strong bg-surface text-text",
        solid: "bg-surface-inverse text-text-inverse",
      },
    },
    // Two initials need the smaller type in the middle size.
    compoundVariants: [{ size: "md", tone: "solid", class: "text-xs" }],
    defaultVariants: { size: "sm", tone: "outline" },
  },
);

export interface AvatarProps {
  /** The person's name, or their email when that is all there is. */
  name: string;
  /** The person's email; the initial comes from it when `name` is empty. */
  email?: string | undefined;
  /** A picture of the person. While it fails to load, the initials show instead. */
  image?: string | null | undefined;
  size?: "sm" | "md" | "lg" | undefined;
  tone?: "outline" | "solid" | undefined;
  /** One letter (the default), or the initials of the first and last names. */
  letters?: 1 | 2 | undefined;
}

/** The first letter of the name or email it is given, uppercased, or a dot without one. */
export function initialOf(name: string): string {
  const [first] = Array.from(name.trim());
  return first ? first.toLocaleUpperCase() : "·";
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
 * A person's picture or initials in a circle, next to their name. Decorative: the name beside
 * it, or the accessible name of the control around it, says who it is.
 */
export function Avatar({ name, email, image, size, tone, letters = 1 }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = Boolean(image) && failed !== image;
  const text = letters === 2 ? initials(name, email) : initialOf(name || email || "");
  return (
    <span aria-hidden="true" className={avatarClasses({ size, tone })}>
      {showImage ? (
        <img
          src={image ?? undefined}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(image ?? null)}
        />
      ) : (
        text
      )}
    </span>
  );
}
