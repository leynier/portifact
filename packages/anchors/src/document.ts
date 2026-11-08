// Anchors against a live DOM: create them from a selection or an element, and resolve stored
// targets back to a range or an element. Used by the review bridge in the browser.
import {
  ANCHOR_LIMITS,
  type Anchor,
  type AnchorRect,
  type AnnotationTarget,
  type ElementAnchor,
  type TextAnchor,
} from "@portifact/contracts";
import {
  type AnchorElement,
  type AnchorNode,
  type DomRange,
  elementText,
  isElement,
  RawText,
  tagOf,
} from "./dom.ts";
import { countAtMost, countBelow, type NormalizedText, normalizeWithMap } from "./normalize.ts";
import { type CreateResult, created, type Orphaned, orphaned, refused } from "./result.ts";
import { isInside, query, selectorsFor } from "./selectors.ts";
import { createTextAnchor, type LocatedText, resolveTextAnchor, type TextSpan } from "./text.ts";

export interface LocatedRange extends LocatedText {
  readonly range: DomRange;
}

export interface LocatedElement {
  readonly confidence: "exact" | "fuzzy";
  readonly element: AnchorElement;
}

export type RangeResolution = LocatedRange | Orphaned;
export type ElementResolution = LocatedElement | Orphaned;
export type TargetResolution =
  | { readonly confidence: "exact"; readonly kind: "document" }
  | (LocatedRange & { readonly kind: "text" })
  | (LocatedElement & { readonly kind: "element" })
  | (Orphaned & { readonly kind: Anchor["kind"] });

export interface ResolveContext {
  /** The page's current SPA route; a target recorded on another route is orphaned. */
  readonly route?: string;
}

const TAG_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * A snapshot of the text under `root` (normally `document.body`). Build a new one after the page
 * changes: positions refer to the text as it was when the snapshot was taken.
 */
export class AnchorDocument {
  readonly root: AnchorElement;
  private readonly raw: RawText;
  private readonly rawStart: Uint32Array;
  private readonly rawEnd: Uint32Array;
  /** The normalized text that text anchors' quotes and positions refer to. */
  readonly text: NormalizedText;

  constructor(root: AnchorElement) {
    this.root = root;
    this.raw = new RawText(root);
    const map = normalizeWithMap(this.raw.value);
    this.text = map.text;
    this.rawStart = map.rawStart;
    this.rawEnd = map.rawEnd;
  }

  /** Creates a text anchor from a DOM range, such as the bridge's current selection. */
  createTextAnchor(range: DomRange): CreateResult<TextAnchor> {
    for (const point of [range.start, range.end]) {
      if (!Number.isInteger(point.offset) || point.offset < 0) {
        return refused("invalid_range", "The selection has an invalid offset");
      }
    }
    const from = this.raw.offsetOf(range.start);
    const to = this.raw.offsetOf(range.end);
    if (from === undefined || to === undefined) {
      return refused("outside_root", "The selection is outside the document");
    }
    if (from === to) return refused("empty_selection", "The selection holds no text");
    // A code point is selected when the range overlaps any of its raw units.
    const start = countAtMost(this.rawEnd, Math.min(from, to));
    const end = countBelow(this.rawStart, Math.max(from, to));
    const result = createTextAnchor(this.text, start, end);
    if (!result.ok) return result;
    const hint = this.hintFor(range.start.node);
    return created(hint === undefined ? result.value : { ...result.value, domHint: hint });
  }

  /** Creates an element anchor; `rect` is the element's box, which only the browser knows. */
  createElementAnchor(element: AnchorElement, rect?: AnchorRect): CreateResult<ElementAnchor> {
    if (!isInside(this.root, element)) {
      return refused("outside_root", "The element is outside the document");
    }
    const tagName = tagOf(element);
    const selectors = TAG_NAME.test(tagName) ? selectorsFor(this.root, element) : [];
    const [primary, ...fallbacks] = selectors;
    if (primary === undefined) {
      return refused("no_selector", "No stable selector finds this element");
    }
    const anchor: ElementAnchor = {
      kind: "element",
      selectors: [primary, ...fallbacks],
      tagName,
      fingerprint: elementText(element, ANCHOR_LIMITS.fingerprintMaxCodePoints),
    };
    return created(rect === undefined ? anchor : { ...anchor, rect });
  }

  /** Resolves a text anchor to a range in this document. */
  resolveText(anchor: TextAnchor): RangeResolution {
    const prefer = this.preferenceFor(anchor.domHint);
    const result = resolveTextAnchor(this.text, anchor, prefer ? { prefer } : {});
    if (result.confidence === "orphaned") return result;
    return { ...result, range: this.rangeOf(result) };
  }

  /**
   * Resolves an element anchor. Exact when a selector finds one element with the recorded tag and
   * fingerprint. Fuzzy when only one element under the root has that tag and fingerprint, or
   * else when a selector finds one element with the tag but changed text. Selectors that find
   * several elements are never trusted.
   */
  resolveElement(anchor: ElementAnchor): ElementResolution {
    let changed: AnchorElement | undefined;
    let ambiguous = false;
    for (const selector of anchor.selectors) {
      const matches = query(this.root, selector);
      if (matches.length > 1) ambiguous = true;
      const [element] = matches;
      if (matches.length !== 1 || element === undefined || tagOf(element) !== anchor.tagName) {
        continue;
      }
      if (this.fingerprintOf(element) === anchor.fingerprint) {
        return { confidence: "exact", element };
      }
      changed ??= element;
    }
    if (anchor.fingerprint !== "") {
      const same = query(this.root, anchor.tagName).filter(
        (element) => this.fingerprintOf(element) === anchor.fingerprint,
      );
      const [element] = same;
      if (same.length === 1 && element) return { confidence: "fuzzy", element };
      if (same.length > 1) ambiguous = true;
    }
    if (changed) return { confidence: "fuzzy", element: changed };
    return orphaned(ambiguous ? "ambiguous" : "not_found");
  }

  /** Resolves a whole thread target, checking the SPA route first. */
  resolve(target: AnnotationTarget, context: ResolveContext = {}): TargetResolution {
    const { anchor } = target;
    if (
      anchor.kind !== "document" &&
      target.route !== undefined &&
      context.route !== undefined &&
      target.route !== context.route
    ) {
      return { ...orphaned("route_mismatch"), kind: anchor.kind };
    }
    switch (anchor.kind) {
      case "document":
        return { confidence: "exact", kind: "document" };
      case "text":
        return { ...this.resolveText(anchor), kind: "text" };
      case "element":
        return { ...this.resolveElement(anchor), kind: "element" };
    }
  }

  private fingerprintOf(element: AnchorElement): string {
    return elementText(element, ANCHOR_LIMITS.fingerprintMaxCodePoints);
  }

  private rangeOf(span: TextSpan): DomRange {
    const start = this.rawStart[span.start] as number;
    const end = this.rawEnd[span.end - 1] as number;
    return { start: this.raw.startPoint(start), end: this.raw.endPoint(end) };
  }

  /** The first selector of the nearest element around a node, if it has one. */
  private hintFor(node: AnchorNode): string | undefined {
    for (let current: AnchorNode | null = node; current; current = current.parentNode) {
      if (current === this.root) return undefined;
      if (isElement(current)) {
        const [selector] = selectorsFor(this.root, current);
        if (selector !== undefined) return selector;
      }
    }
    return undefined;
  }

  /** Prefers spans that start inside the element the DOM hint finds, when it finds exactly one. */
  private preferenceFor(hint: string | undefined): ((span: TextSpan) => boolean) | undefined {
    if (hint === undefined) return undefined;
    const matches = query(this.root, hint);
    const [element] = matches;
    if (matches.length !== 1 || element === undefined) return undefined;
    const from = this.raw.before.get(element) as number;
    const to = this.raw.after.get(element) as number;
    return (span) => {
      const start = this.rawStart[span.start] as number;
      return start >= from && start < to;
    };
  }
}
