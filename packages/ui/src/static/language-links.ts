// The language switcher of the static pages (the landing and the documents on portifact.com),
// drawn as HTML at build time. Each language is a link to the same page in that language, so it
// works without a script and with the keyboard alone: `menu` is a disclosure for the top bar
// and `list` a row of links for the footer. The names are each language's own, marked with
// `lang` and `hreflang`. The dashboard uses the `LanguageSwitcher` component instead.

export interface LanguageLink {
  code: string;
  name: string;
  href: string;
  current: boolean;
}

export interface LanguageLinksInput {
  variant: "menu" | "list";
  /** The accessible name of the switcher, in the page's language, such as "Language". */
  label: string;
  links: readonly LanguageLink[];
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const GLOBE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4 shrink-0"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>';
const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4 shrink-0"><path d="m5 12 5 5 9-10" /></svg>';

function link(item: LanguageLink, classes: string, mark = ""): string {
  const current = item.current ? ' aria-current="true"' : "";
  const code = escapeHtml(item.code);
  return `<a href="${escapeHtml(item.href)}" hreflang="${code}" lang="${code}" data-locale-link="${code}"${current} class="${classes}">${escapeHtml(item.name)}${item.current ? mark : ""}</a>`;
}

/** The switcher's markup, with every value escaped. */
export function languageLinksHtml({ variant, label, links }: LanguageLinksInput): string {
  const current = links.find((item) => item.current);
  if (variant === "list") {
    const items = links
      .map(
        (item) =>
          `<li>${link(item, "text-text-muted no-underline hover:text-text hover:underline current-item:text-text current-item:underline")}</li>`,
      )
      .join("");
    return `<nav aria-label="${escapeHtml(label)}" class="flex items-center gap-2 text-sm">${GLOBE}<ul class="flex flex-wrap gap-x-4 gap-y-2">${items}</ul></nav>`;
  }
  const items = links
    .map(
      (item) =>
        `<li>${link(item, "flex items-center justify-between gap-3 rounded-xs px-3 py-2 text-sm text-text no-underline hover:bg-surface-hover current-item:font-semibold", CHECK)}</li>`,
    )
    .join("");
  const name = current ? escapeHtml(current.name) : "";
  const lang = current ? ` lang="${escapeHtml(current.code)}"` : "";
  return `<details class="relative" data-language-menu><summary class="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-sm border border-border px-2.5 text-sm text-text-muted marker-none hover:border-border-strong hover:text-text">${GLOBE}<span class="sr-only">${escapeHtml(label)}: </span><span${lang} class="sr-only sm:not-sr-only">${name}</span></summary><nav aria-label="${escapeHtml(label)}" class="absolute right-0 z-50 mt-2 min-w-40 rounded-md border border-border bg-surface-raised p-1 shadow-float"><ul>${items}</ul></nav></details>`;
}
