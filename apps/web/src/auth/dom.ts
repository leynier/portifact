// Small DOM helpers shared by the auth pages. They keep errors linked to their fields and
// announced, as docs/accessibility.md requires.

export function byId<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from the page`);
  return element as T;
}

/** Shows or clears the error under a field and links it with aria-describedby. */
export function setFieldError(
  input: HTMLInputElement,
  error: HTMLElement,
  message: string | undefined,
): void {
  const describedBy = new Set((input.getAttribute("aria-describedby") ?? "").split(" "));
  describedBy.delete("");
  if (message) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    describedBy.add(error.id);
  } else {
    error.textContent = "";
    error.hidden = true;
    input.removeAttribute("aria-invalid");
    describedBy.delete(error.id);
  }
  if (describedBy.size > 0) input.setAttribute("aria-describedby", [...describedBy].join(" "));
  else input.removeAttribute("aria-describedby");
}

/** Where a summary's text goes: its `[data-message]` child, next to the icon, or itself. */
function messageOf(summary: HTMLElement): HTMLElement {
  return summary.querySelector<HTMLElement>("[data-message]") ?? summary;
}

/** Shows the error summary at the top of the page and moves focus to it. */
export function showSummary(summary: HTMLElement, message: string): void {
  messageOf(summary).textContent = message;
  summary.hidden = false;
  summary.focus();
}

export function hideSummary(summary: HTMLElement): void {
  messageOf(summary).textContent = "";
  summary.hidden = true;
}

/** Announces progress through a polite live region. */
export function announce(status: HTMLElement, message: string): void {
  status.textContent = message;
}

/** Disables a button while its request runs, so it cannot be sent twice. */
export async function whileBusy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

/** Replaces a list's items with one text item per line. Text only, never HTML. */
export function fillList(list: HTMLElement, lines: readonly string[]): void {
  list.replaceChildren(
    ...lines.map((line) => {
      const item = list.ownerDocument.createElement("li");
      item.textContent = line;
      return item;
    }),
  );
}
