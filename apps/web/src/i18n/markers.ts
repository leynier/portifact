// Translation markers in static HTML. The English page is the source: an element with
// `data-i18n="key"` has its content replaced by the key's message, and `data-i18n-<attribute>`
// does the same for one attribute (`data-i18n-alt`, `data-i18n-aria-label`, ...). The build
// prerenders the site's pages with it (src/i18n/site.ts) and the auth pages apply it at runtime
// (src/auth/i18n/i18n.ts), so both read one convention. Messages come from catalogs in the
// repository, never from input, so they may hold inline markup (`<code>`, `<a href>`).

/** Attributes a marker may translate. */
export const MARKED_ATTRIBUTES = ["alt", "aria-label", "title", "content", "placeholder"] as const;

/** Messages of static pages: the key of each marker and its text in one language. */
export type PageMessages = Readonly<Record<string, string>>;

const CONTENT_MARKER = "data-i18n";
const attributeMarker = (attribute: string) => `data-i18n-${attribute}`;

/** Every marker of a document with its English text: content as HTML, attributes as text. */
export function collectMessages(root: ParentNode): Map<string, string> {
  const found = new Map<string, string>();
  const add = (key: string, text: string) => {
    const known = found.get(key);
    if (known !== undefined && known !== text) {
      throw new Error(`The marker "${key}" has two different texts: "${known}" and "${text}"`);
    }
    found.set(key, text);
  };
  for (const element of root.querySelectorAll(`[${CONTENT_MARKER}]`)) {
    add(element.getAttribute(CONTENT_MARKER) ?? "", contentOf(element));
  }
  for (const attribute of MARKED_ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${attributeMarker(attribute)}]`)) {
      add(
        element.getAttribute(attributeMarker(attribute)) ?? "",
        element.getAttribute(attribute) ?? "",
      );
    }
  }
  return found;
}

function contentOf(element: Element): string {
  return element.tagName === "TITLE"
    ? (element.textContent ?? "").trim()
    : element.innerHTML.trim();
}

/**
 * Replaces every marked text with its message. Returns the keys that have no message, which
 * keep their English text; the catalog tests make sure there are none.
 */
export function localizeDocument(root: ParentNode, messages: PageMessages): string[] {
  const missing = new Set<string>();
  const message = (key: string): string | undefined => {
    const text = Object.hasOwn(messages, key) ? messages[key] : undefined;
    if (text === undefined) missing.add(key);
    return text;
  };
  for (const element of root.querySelectorAll(`[${CONTENT_MARKER}]`)) {
    const text = message(element.getAttribute(CONTENT_MARKER) ?? "");
    if (text === undefined) continue;
    if (element.tagName === "TITLE") element.textContent = text;
    else element.innerHTML = text;
  }
  for (const attribute of MARKED_ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${attributeMarker(attribute)}]`)) {
      const text = message(element.getAttribute(attributeMarker(attribute)) ?? "");
      if (text !== undefined) element.setAttribute(attribute, text);
    }
  }
  return [...missing];
}

/** Removes the markers, so a prerendered page carries only what it shows. */
export function stripMarkers(root: ParentNode): void {
  const names = [CONTENT_MARKER, ...MARKED_ATTRIBUTES.map(attributeMarker)];
  for (const element of root.querySelectorAll(names.map((name) => `[${name}]`).join(","))) {
    for (const name of names) element.removeAttribute(name);
  }
}

/**
 * The element names in a message, in order, so a translation can be checked to keep the
 * English markup (the same links, code and emphasis).
 */
export function markupOf(html: string): string[] {
  return [...html.matchAll(/<\s*([a-zA-Z][\w-]*)/g)].map((match) => (match[1] ?? "").toLowerCase());
}
