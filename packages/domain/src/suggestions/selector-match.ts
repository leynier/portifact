// Element anchors on the server (decision 0027, "Previews"): the selectors of an element anchor are
// in the restricted grammar of `isSafeSelector` (type, `#id`, `.class`, a stable attribute with a
// quoted value and `:nth-of-type(n)`, joined by descendant or child combinators), so this small
// matcher reads them on a parse5 tree with the browser's meaning: a selector is matched against
// the whole document and a query returns the matching descendants of its root in document order.
// Nothing else is supported, and a selector outside the grammar matches nothing. Matching is
// memoized per element and compound, so a chain of descendant compounds never backtracks, sibling
// indexes are computed once per parent, and every step is counted in `Work.selectorSteps` against
// `SELECTOR_LIMITS.steps` (review of pull request #287): a query over its budget throws
// `SelectorBudgetExceeded`, and callers refuse rather than guess.
import { isSafeSelector } from "@portifact/contracts";
import type { DefaultTreeAdapterMap } from "parse5";
import { newWork, type Work } from "./work.ts";

/** The selector work one preview may do, counted in `Work.selectorSteps`. */
export const SELECTOR_LIMITS = { steps: 2_000_000 } as const;

/** Thrown when a query would pass `SELECTOR_LIMITS.steps`. */
export class SelectorBudgetExceeded extends Error {
  constructor() {
    super("Selector work is over its budget");
    this.name = "SelectorBudgetExceeded";
  }
}

// Its own tree helpers, so `html-dom.ts`, which uses this module, is not imported back.
type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];
const HTML_NS = "http://www.w3.org/1999/xhtml";
const isElement = (node: P5Node): node is P5Element => "tagName" in node;
const childrenOf = (node: P5Node): P5Node[] =>
  "childNodes" in node ? (node.childNodes as P5Node[]) : [];
const parentOf = (node: P5Node): P5Node | null =>
  (node as { parentNode?: P5Node | null }).parentNode ?? null;

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attributes: { name: string; value: string }[];
  nth: number | null;
}

interface Selector {
  /** Left to right. */
  compounds: Compound[];
  /** `combinators[i]` joins `compounds[i]` and `compounds[i + 1]`. */
  combinators: ("child" | "descendant")[];
}

const IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*/;
const TAG = /^[a-z][a-z0-9-]*/;

/** Splits a selector at its combinators, never inside a quoted attribute value. */
function split(selector: string): { parts: string[]; combinators: Selector["combinators"] } {
  const parts: string[] = [];
  const combinators: Selector["combinators"] = [];
  let current = "";
  let quoted = false;
  for (let at = 0; at < selector.length; at++) {
    const char = selector[at] as string;
    if (char === '"') quoted = !quoted;
    if (!quoted && char === " ") {
      parts.push(current);
      current = "";
      if (selector.slice(at, at + 3) === " > ") {
        combinators.push("child");
        at += 2;
      } else {
        combinators.push("descendant");
      }
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { parts, combinators };
}

function compound(text: string): Compound | null {
  const result: Compound = { tag: null, ids: [], classes: [], attributes: [], nth: null };
  let rest = text;
  const tag = TAG.exec(rest);
  if (tag) {
    result.tag = tag[0];
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    if (rest[0] === "#" || rest[0] === ".") {
      const ident = IDENT.exec(rest.slice(1));
      if (!ident) return null;
      (rest[0] === "#" ? result.ids : result.classes).push(ident[0]);
      rest = rest.slice(1 + ident[0].length);
    } else if (rest[0] === "[") {
      const match = /^\[([a-z-]+)="([^"]*)"\]/.exec(rest);
      if (!match) return null;
      result.attributes.push({ name: match[1] as string, value: match[2] as string });
      rest = rest.slice(match[0].length);
    } else {
      const match = /^:nth-of-type\(([1-9][0-9]*)\)/.exec(rest);
      if (!match || result.nth !== null) return null;
      result.nth = Number(match[1]);
      rest = rest.slice(match[0].length);
    }
  }
  return result;
}

/** A selector of the anchors' grammar, read; null for anything else. */
export function parseSelector(selector: string): Selector | null {
  if (!isSafeSelector(selector)) return null;
  const { parts, combinators } = split(selector);
  const compounds: Compound[] = [];
  for (const part of parts) {
    const read = compound(part);
    if (!read) return null;
    compounds.push(read);
  }
  return { compounds, combinators };
}

const attributeOf = (element: P5Element, name: string): string | null =>
  element.attrs.find((attr) => attr.name === name && !attr.namespace)?.value ?? null;

/** Counts one step of selector work, throwing past the budget. */
function step(work: Work, count = 1): void {
  work.selectorSteps += count;
  if (work.selectorSteps > SELECTOR_LIMITS.steps) throw new SelectorBudgetExceeded();
}

/** `:nth-of-type` indexes, computed for all of a parent's children at once. */
class TypeIndexes {
  private readonly known = new WeakMap<P5Element, number>();
  constructor(private readonly work: Work) {}

  of(element: P5Element): number {
    const cached = this.known.get(element);
    if (cached !== undefined) return cached;
    const parent = parentOf(element);
    if (!parent) return 1;
    const counts = new Map<string, number>();
    const siblings = childrenOf(parent);
    step(this.work, siblings.length);
    for (const sibling of siblings) {
      if (!isElement(sibling)) continue;
      const index = (counts.get(sibling.tagName) ?? 0) + 1;
      counts.set(sibling.tagName, index);
      this.known.set(sibling, index);
    }
    return this.known.get(element) ?? 1;
  }
}

function matchesCompound(element: P5Element, part: Compound, types: TypeIndexes): boolean {
  // Only HTML elements: the anchors' type selectors are lowercase HTML names.
  if (element.namespaceURI !== HTML_NS) return false;
  if (part.tag !== null && element.tagName !== part.tag) return false;
  if (part.ids.length > 0 && part.ids.some((id) => attributeOf(element, "id") !== id)) {
    return false;
  }
  if (part.classes.length > 0) {
    const classes = (attributeOf(element, "class") ?? "").split(/[\t\n\f\r ]+/);
    if (part.classes.some((name) => !classes.includes(name))) return false;
  }
  for (const { name, value } of part.attributes) {
    if (attributeOf(element, name) !== value) return false;
  }
  return part.nth === null || types.of(element) === part.nth;
}

const parentElement = (node: P5Node): P5Element | null => {
  const parent = parentOf(node);
  return parent && isElement(parent) ? parent : null;
};

const UNKNOWN = 0;
const YES = 1;
const NO = 2;

/**
 * One selector over one tree, memoized: `full(e, j)` says whether `e` matches compounds `0..j`
 * with `e` as compound `j`, and `under(e, j)` whether `e` or one of its ancestors does. Each pair
 * is decided once, and `under` walks ancestors in a loop, so the work is at most the elements
 * times the compounds, never exponential, and the stack depth is bounded by the compounds.
 */
class Matcher {
  private readonly fullMemo = new Map<P5Element, Uint8Array>();
  private readonly underMemo = new Map<P5Element, Uint8Array>();
  private readonly types: TypeIndexes;

  constructor(
    private readonly selector: Selector,
    private readonly work: Work,
  ) {
    this.types = new TypeIndexes(work);
  }

  private memoOf(memo: Map<P5Element, Uint8Array>, element: P5Element): Uint8Array {
    let row = memo.get(element);
    if (!row) {
      row = new Uint8Array(this.selector.compounds.length);
      memo.set(element, row);
    }
    return row;
  }

  full(element: P5Element, index: number): boolean {
    const row = this.memoOf(this.fullMemo, element);
    if (row[index] !== UNKNOWN) return row[index] === YES;
    step(this.work);
    let result = matchesCompound(element, this.selector.compounds[index] as Compound, this.types);
    if (result && index > 0) {
      const parent = parentElement(element);
      result =
        parent !== null &&
        (this.selector.combinators[index - 1] === "child"
          ? this.full(parent, index - 1)
          : this.under(parent, index - 1));
    }
    row[index] = result ? YES : NO;
    return result;
  }

  /** Whether `element` or an ancestor matches compounds `0..index`, ending at `index`. */
  under(element: P5Element, index: number): boolean {
    // The ancestors whose answer is not known yet, nearest first, up to a known one or the top.
    const chain: P5Element[] = [];
    let known = false;
    for (let at: P5Element | null = element; at; at = parentElement(at)) {
      const value = this.memoOf(this.underMemo, at)[index];
      if (value !== UNKNOWN) {
        known = value === YES;
        break;
      }
      chain.push(at);
    }
    // Decided from the top down: an element is under a match when its parent is, or it matches.
    for (let at = chain.length - 1; at >= 0; at--) {
      const node = chain[at] as P5Element;
      known = known || this.full(node, index);
      this.memoOf(this.underMemo, node)[index] = known ? YES : NO;
    }
    return known;
  }

  matches(element: P5Element): boolean {
    return this.full(element, this.selector.compounds.length - 1);
  }
}

/** Whether `element` matches `selector`, as `querySelectorAll` would decide it. */
export function matches(element: P5Element, selector: Selector, work: Work = newWork()): boolean {
  return new Matcher(selector, work).matches(element);
}

/** The meter of the element resolution running now (`metered`), if any. */
let activeWork: Work | null = null;

/**
 * Runs `resolve` with every query metered in `work`: the anchors call `querySelectorAll` through
 * the DOM surface, which has no place for a meter. Synchronous, so no other resolution runs in
 * between.
 */
export function metered<T>(work: Work, resolve: () => T): T {
  const previous = activeWork;
  activeWork = work;
  try {
    return resolve();
  } finally {
    activeWork = previous;
  }
}

/**
 * The descendants of `root` that match `selector`, in document order, as `querySelectorAll` gives
 * them: the selector is read against the whole document, so a path that starts above the root
 * still matches. Iterative, so a deep page cannot exhaust the stack. Every node walked and every
 * decision counts in `work` (the running `metered` resolution's, or the caller's).
 */
export function querySelectorAll(
  root: P5Node,
  selector: string,
  work: Work = activeWork ?? newWork(),
): P5Element[] {
  const parsed = parseSelector(selector);
  if (!parsed) return [];
  const matcher = new Matcher(parsed, work);
  const found: P5Element[] = [];
  const stack: P5Node[] = [...childrenOf(root)].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as P5Node;
    if (!isElement(node)) continue;
    step(work);
    if (matcher.matches(node)) found.push(node);
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index] as P5Node);
    }
  }
  return found;
}
