// The owner's brand on a branded viewer bar (premium plan P9): the logo and the name in a chip
// filled with the owner's accent, linking to the owner's site in a new tab. Everything in it is
// the owner's data, so it is only ever rendered as text, an image and a link.
import { useLayoutEffect, useRef, useState } from "react";
import { brandPalette, brandProperties } from "../tokens/brand.ts";

export interface BrandMarkProps {
  /** The brand's name, shown as text. */
  name: string;
  /** The brand's home (`https`), opened in a new tab; omit for a mark that is not a link. */
  href?: string | null | undefined;
  /** Said after the name to assistive technology when the mark is a link. */
  newTabLabel: string;
  /** The logo, decorative next to the name. A logo that fails to load is left out. */
  logo?: { src: string; width: number; height: number } | null | undefined;
  /** One `#rrggbb` color; the chip is a neutral surface without it. */
  accent?: string | null | undefined;
}

const CHIP =
  "inline-flex h-8 min-w-0 max-w-40 items-center gap-2 rounded-sm border border-border bg-brand px-2 text-sm font-semibold text-brand-ink no-underline sm:max-w-64";

/**
 * The brand chip. The accent is set as `--pf-brand-accent` (and the ink derived from it as
 * `--pf-brand-ink`) through the CSSOM on this element only, the one runtime color in the product;
 * the accent is never used for text.
 */
export function BrandMark({ name, href, newTabLabel, logo, accent }: BrandMarkProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const palette = brandPalette(accent);
    for (const property of ["--pf-brand-accent", "--pf-brand-ink"]) {
      element.style.removeProperty(property);
    }
    if (!palette) return;
    for (const [property, value] of Object.entries(brandProperties(palette))) {
      element.style.setProperty(property, value);
    }
  }, [accent, href]);
  const content = (
    <>
      {logo && failed !== logo.src ? (
        <img
          src={logo.src}
          alt=""
          width={logo.width}
          height={logo.height}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(logo.src)}
          className="h-6 w-auto max-w-24 shrink-0 object-contain"
        />
      ) : null}
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
  if (!href) {
    return (
      <span
        ref={(node) => {
          ref.current = node;
        }}
        className={CHIP}
        title={name}
      >
        {content}
      </span>
    );
  }
  return (
    <a
      ref={(node) => {
        ref.current = node;
      }}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={name}
      className={CHIP}
    >
      {content}
      <span className="sr-only"> {newTabLabel}</span>
    </a>
  );
}
