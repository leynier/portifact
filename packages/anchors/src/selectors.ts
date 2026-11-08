// CSS selectors for element anchors. Every selector produced here is in the restricted grammar of
// `isSafeSelector` in `packages/contracts`, and is kept only if it finds exactly its element.
import { ANCHOR_LIMITS, isSafeSelector, STABLE_SELECTOR_ATTRIBUTES } from "@portifact/contracts";
import { type AnchorElement, type AnchorNode, isElement, tagOf } from "./dom.ts";

const IDENTIFIER = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Whether an ID or class looks written by a person rather than generated per build or render:
 * a plain identifier with no long digit runs or hex hashes, which frameworks put in generated IDs.
 */
export function isStableIdentifier(value: string): boolean {
  return (
    value.length <= 64 &&
    IDENTIFIER.test(value) &&
    !/\d{4,}/.test(value) &&
    !/[0-9a-f]{8,}/i.test(value)
  );
}

/** Elements under `root` that match `selector`; none when the DOM refuses the selector. */
export function query(root: AnchorElement, selector: string): AnchorElement[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

const findsOnly = (root: AnchorElement, selector: string, element: AnchorElement): boolean => {
  const matches = query(root, selector);
  return matches.length === 1 && matches[0] === element;
};

/** Whether `element` is a strict descendant of `root`. */
export function isInside(root: AnchorNode, element: AnchorNode): boolean {
  for (let node = element.parentNode; node; node = node.parentNode) {
    if (node === root) return true;
  }
  return false;
}

/**
 * Selectors that find `element` under `root`, most stable first: its ID, a stable attribute,
 * a path from the nearest ancestor with a stable ID, and a path from the root. At most
 * `ANCHOR_LIMITS.selectorsMax`, each valid and unique when generated.
 */
export function selectorsFor(root: AnchorElement, element: AnchorElement): string[] {
  const tag = tagOf(element);
  const candidates: string[] = [];
  const id = element.getAttribute("id");
  if (id !== null && isStableIdentifier(id)) candidates.push(`#${id}`);
  for (const attribute of STABLE_SELECTOR_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value !== null) candidates.push(`${tag}[${attribute}="${value}"]`);
  }
  candidates.push(...paths(root, element));

  const selectors: string[] = [];
  for (const selector of candidates) {
    if (selectors.length === ANCHOR_LIMITS.selectorsMax) break;
    if (selectors.includes(selector) || !isSafeSelector(selector)) continue;
    if (findsOnly(root, selector, element)) selectors.push(selector);
  }
  return selectors;
}

/** A path anchored on the nearest ancestor with a stable ID, then one anchored on the root. */
function paths(root: AnchorElement, element: AnchorElement): string[] {
  const steps: string[] = [];
  const found: string[] = [];
  let node: AnchorElement = element;
  while (node !== root) {
    steps.unshift(step(node));
    const parent = node.parentNode as AnchorElement;
    const id = parent.getAttribute("id");
    if (parent !== root && id !== null && isStableIdentifier(id) && found.length === 0) {
      found.push([`#${id}`, ...steps].join(" > "));
    }
    node = parent;
  }
  found.push([tagOf(root), ...steps].join(" > "));
  return found;
}

/** The element's tag, with `:nth-of-type` only when a sibling shares the tag. */
function step(element: AnchorElement): string {
  const tag = tagOf(element);
  const siblings = Array.from((element.parentNode as AnchorNode).childNodes).filter(
    (node): node is AnchorElement => isElement(node) && tagOf(node) === tag,
  );
  return siblings.length === 1 ? tag : `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
}
