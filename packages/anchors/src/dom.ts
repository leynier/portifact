// The DOM surface anchors need, as structural types: the browser's DOM and happy-dom both satisfy
// them, so the bridge passes real nodes and tests pass happy-dom nodes. Nothing here reads form
// values, cookies, storage or computed styles.
import { clamp, normalizeWithMap } from "./normalize.ts";

export interface AnchorNode {
  readonly nodeType: number;
  readonly parentNode: AnchorNode | null;
  readonly childNodes: ArrayLike<AnchorNode>;
}

export interface AnchorText extends AnchorNode {
  readonly data: string;
}

export interface AnchorElement extends AnchorNode {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  querySelectorAll(selectors: string): ArrayLike<AnchorElement>;
}

/** A DOM Range boundary: a text node and a UTF-16 offset, or a node and a child index. */
export interface DomPoint {
  readonly node: AnchorNode;
  readonly offset: number;
}

export interface DomRange {
  readonly start: DomPoint;
  readonly end: DomPoint;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export const isElement = (node: AnchorNode): node is AnchorElement =>
  node.nodeType === ELEMENT_NODE;
export const isText = (node: AnchorNode): node is AnchorText => node.nodeType === TEXT_NODE;
export const tagOf = (element: AnchorElement): string => element.tagName.toLowerCase();

/** Elements whose text is not shown as page text, or holds form values, and is never anchored. */
const SKIPPED_TAGS = new Set([
  "audio",
  "canvas",
  "embed",
  "head",
  "iframe",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "style",
  "template",
  "textarea",
  "title",
  "video",
]);

/** Elements that separate the text before and after them, as a line break does. */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Marks the review UI's own elements, and anything a page wants left out of anchors. */
export const IGNORE_ATTRIBUTE = "data-portifact-ignore";

export function isSkipped(element: AnchorElement): boolean {
  return (
    SKIPPED_TAGS.has(tagOf(element)) ||
    element.getAttribute("hidden") !== null ||
    element.getAttribute(IGNORE_ATTRIBUTE) !== null
  );
}

interface Segment {
  readonly node: AnchorText;
  readonly start: number;
  readonly end: number;
}

/**
 * The raw text of a subtree, in document order, with a separator at block boundaries and where
 * each node starts and ends in it. Iterative, so deep pages cannot overflow the stack.
 */
export class RawText {
  readonly segments: Segment[] = [];
  private readonly segmentOf = new Map<AnchorNode, Segment>();
  readonly before = new Map<AnchorNode, number>();
  readonly after = new Map<AnchorNode, number>();
  /** Elements whose children were walked; for them a child index is a valid point. */
  readonly expanded = new Set<AnchorNode>();
  readonly value: string;

  constructor(root: AnchorElement, limit = Number.POSITIVE_INFINITY) {
    const parts: string[] = [];
    let length = 0;
    let separated = true;
    const separate = () => {
      if (separated) return;
      parts.push("\n");
      length++;
      separated = true;
    };

    this.before.set(root, 0);
    this.expanded.add(root);
    const stack: Array<{ node: AnchorNode; exit: boolean }> = [];
    const pushChildren = (node: AnchorNode) => {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        stack.push({ node: node.childNodes[i] as AnchorNode, exit: false });
      }
    };
    pushChildren(root);

    while (stack.length > 0 && length < limit) {
      const { node, exit } = stack.pop() as { node: AnchorNode; exit: boolean };
      if (exit) {
        if (BLOCK_TAGS.has(tagOf(node as AnchorElement))) separate();
        this.after.set(node, length);
        continue;
      }
      this.before.set(node, length);
      if (isText(node) && node.data.length > 0) {
        const segment = { node, start: length, end: length + node.data.length };
        this.segments.push(segment);
        this.segmentOf.set(node, segment);
        parts.push(node.data);
        length += node.data.length;
        separated = false;
      } else if (isElement(node) && !isSkipped(node)) {
        if (BLOCK_TAGS.has(tagOf(node))) separate();
        this.expanded.add(node);
        stack.push({ node, exit: true });
        pushChildren(node);
        continue;
      }
      this.after.set(node, length);
    }
    this.after.set(root, length);
    this.value = parts.join("");
  }

  /** The raw offset of a DOM point, or `undefined` when the point is outside the root. */
  offsetOf(point: DomPoint): number | undefined {
    const { node, offset } = point;
    const segment = this.segmentOf.get(node);
    if (segment) return segment.start + Math.min(offset, segment.end - segment.start);
    if (this.expanded.has(node)) {
      const child = node.childNodes[offset];
      return child ? this.before.get(child) : this.after.get(node);
    }
    for (let ancestor: AnchorNode | null = node; ancestor; ancestor = ancestor.parentNode) {
      const position = this.before.get(ancestor);
      if (position !== undefined) return position;
    }
    return undefined;
  }

  /** The DOM point of a raw offset that starts a range: in the first text node ending after it. */
  startPoint(offset: number): DomPoint {
    const index = this.countWhere((segment) => segment.end <= offset);
    return this.pointIn((this.segments[index] ?? this.segments.at(-1)) as Segment, offset);
  }

  /** The DOM point of a raw offset that ends a range: in the last text node starting before it. */
  endPoint(offset: number): DomPoint {
    const index = this.countWhere((segment) => segment.start < offset) - 1;
    return this.pointIn((this.segments[index] ?? this.segments[0]) as Segment, offset);
  }

  private pointIn(segment: Segment, offset: number): DomPoint {
    return {
      node: segment.node,
      offset: clamp(offset - segment.start, 0, segment.end - segment.start),
    };
  }

  /** Number of leading segments that satisfy a predicate that holds for a prefix of them. */
  private countWhere(predicate: (segment: Segment) => boolean): number {
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (predicate(this.segments[middle] as Segment)) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/** The normalized text of an element, truncated to `maxCodePoints`, read lazily. */
export function elementText(element: AnchorElement, maxCodePoints: number): string {
  const raw = new RawText(element, maxCodePoints * 8).value;
  return Array.from(normalizeWithMap(raw).text.value).slice(0, maxCodePoints).join("").trimEnd();
}
