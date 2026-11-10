// The plan card and the plan comparison table of the static pages (the landing's pricing
// section), drawn as HTML at build time, and the classes the dashboard's `PlanCard` shares, so
// both draw one pattern. No script: links and a real table work with the keyboard alone. Every
// value is escaped. Kept free of React and of other modules' runtime code, because the landing's
// build loads it in Node.

export interface PlanCardContent {
  /** A stable key for the plan, used in IDs and `data-plan`. */
  id: string;
  name: string;
  summary: string;
  price: { amount: string; unit: string };
  includedLabel: string;
  included: readonly string[];
  comingSoonLabel: string;
  comingSoon: readonly string[];
  action: {
    label: string;
    href: string;
    /** A fuller name for assistive technology that starts with the visible label. */
    accessibleName?: string | undefined;
    primary?: boolean | undefined;
  };
}

export interface PlanTableContent {
  caption: string;
  /** The header of the first column, which names each row's limit. */
  rowHeader: string;
  plans: readonly { id: string; name: string }[];
  rows: readonly { id: string; label: string; cells: readonly string[] }[];
}

/** Classes of the plan card, shared with the React `PlanCard`. */
export const PLAN_CARD_CLASSES = {
  card: "flex h-full min-w-0 flex-col gap-5 rounded-lg border border-border bg-canvas p-6 shadow-sm",
  header: "flex flex-col gap-1.5",
  nameRow: "flex flex-wrap items-center justify-between gap-2",
  name: "text-lg font-semibold tracking-tight",
  summary: "text-sm text-text-muted",
  price: "flex flex-wrap items-baseline gap-x-2 gap-y-1",
  amount: "text-3xl font-semibold tracking-tight",
  unit: "text-sm text-text-muted",
  listLabel: "text-sm font-medium",
  list: "mt-2 space-y-2 text-sm",
  item: "flex gap-2",
  soonItem: "flex gap-2 text-text-muted",
  icon: "mt-0.5 size-4 shrink-0",
  action: "mt-auto pt-2",
} as const;

/**
 * The classes of `buttonClasses({ intent, size: "md" })` for links on static pages; the UI tests
 * keep them equal.
 */
export const STATIC_BUTTON_CLASSES = {
  primary:
    "inline-flex max-w-full shrink-0 items-center justify-center gap-2 text-center font-medium text-balance no-underline transition duration-150 select-none disabled:opacity-55 motion-safe:active:translate-y-px rounded-sm bg-surface-inverse text-text-inverse shadow-sm hover:opacity-85 disabled:hover:opacity-55 min-h-10 px-4 py-1.5 text-sm",
  secondary:
    "inline-flex max-w-full shrink-0 items-center justify-center gap-2 text-center font-medium text-balance no-underline transition duration-150 select-none disabled:opacity-55 motion-safe:active:translate-y-px rounded-sm border border-border-strong bg-canvas text-text hover:bg-surface-hover disabled:hover:bg-canvas aria-pressed:border-text aria-pressed:bg-surface-hover min-h-10 px-4 py-1.5 text-sm",
} as const;

/** Classes of the comparison table, which follow the framed `Table` of the design system. */
export const PLAN_TABLE_CLASSES = {
  region: "relative overflow-x-auto rounded-lg border border-border bg-canvas",
  table: "w-full border-collapse text-left text-sm",
  caption: "sr-only",
  head: "border-b border-border bg-surface",
  columnHeader:
    "h-10 px-4 text-xs font-medium whitespace-nowrap text-text-muted first:pl-5 last:pr-5",
  body: "divide-y divide-border",
  rowHeader: "px-4 py-3.5 text-left align-middle font-medium first:pl-5",
  cell: "px-4 py-3.5 align-middle whitespace-nowrap last:pr-5",
} as const;

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

/** The check of an included feature (Lucide `Check`). */
export const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="mt-0.5 size-4 shrink-0"><path d="M20 6 9 17l-5-5" /></svg>';
/** The clock of a feature on the way (Lucide `Clock`). */
export const SOON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="mt-0.5 size-4 shrink-0"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>';

function list(label: string, items: readonly string[], icon: string, item: string): string {
  if (items.length === 0) return "";
  const entries = items
    .map((text) => `<li class="${item}">${icon}<span>${escapeHtml(text)}</span></li>`)
    .join("");
  return `<div><p class="${PLAN_CARD_CLASSES.listLabel}">${escapeHtml(label)}</p><ul class="${PLAN_CARD_CLASSES.list}">${entries}</ul></div>`;
}

/** One plan's card: name, summary, price, what it includes, what is on the way and its action. */
export function planCardHtml(card: PlanCardContent, headingLevel: 2 | 3 = 3): string {
  const c = PLAN_CARD_CLASSES;
  const id = escapeHtml(card.id);
  const heading = `h${headingLevel}`;
  const unit = card.price.unit
    ? `<span class="${c.unit}">${escapeHtml(card.price.unit)}</span>`
    : "";
  const label = card.action.accessibleName
    ? ` aria-label="${escapeHtml(card.action.accessibleName)}"`
    : "";
  const button = card.action.primary
    ? STATIC_BUTTON_CLASSES.primary
    : STATIC_BUTTON_CLASSES.secondary;
  return [
    `<article class="${c.card}" aria-labelledby="plan-${id}-name" data-plan="${id}">`,
    `<div class="${c.header}"><${heading} id="plan-${id}-name" class="${c.name}">${escapeHtml(card.name)}</${heading}>`,
    `<p class="${c.summary}">${escapeHtml(card.summary)}</p></div>`,
    `<p class="${c.price}" data-plan-price><span class="${c.amount}">${escapeHtml(card.price.amount)}</span>${unit}</p>`,
    list(card.includedLabel, card.included, CHECK_ICON, c.item),
    list(card.comingSoonLabel, card.comingSoon, SOON_ICON, c.soonItem),
    `<div class="${c.action}"><a href="${escapeHtml(card.action.href)}"${label} class="${button} w-full" data-plan-action>${escapeHtml(card.action.label)}</a></div>`,
    "</article>",
  ].join("");
}

/**
 * The comparison of the plans' limits: a real table with a caption, a header per plan and a
 * header per row, in a focusable region that scrolls on its own on narrow screens, so the page
 * never scrolls sideways.
 */
export function planTableHtml(table: PlanTableContent): string {
  const c = PLAN_TABLE_CLASSES;
  const caption = escapeHtml(table.caption);
  const head = [
    `<th scope="col" class="${c.columnHeader}">${escapeHtml(table.rowHeader)}</th>`,
    ...table.plans.map(
      (plan) =>
        `<th scope="col" class="${c.columnHeader}" data-plan="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</th>`,
    ),
  ].join("");
  const rows = table.rows
    .map((row) => {
      const cells = row.cells
        .map(
          (value, index) =>
            `<td class="${c.cell}" data-plan="${escapeHtml(table.plans[index]?.id ?? "")}" data-limit="${escapeHtml(row.id)}">${escapeHtml(value)}</td>`,
        )
        .join("");
      return `<tr><th scope="row" class="${c.rowHeader}">${escapeHtml(row.label)}</th>${cells}</tr>`;
    })
    .join("");
  return `<section aria-label="${caption}" tabindex="0" class="${c.region}"><table class="${c.table}"><caption class="${c.caption}">${caption}</caption><thead class="${c.head}"><tr>${head}</tr></thead><tbody class="${c.body}">${rows}</tbody></table></section>`;
}
