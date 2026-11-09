// What the bridge draws over the artifact: a translucent highlight for each thread, layered so
// text several threads cover is darker, the element-mode outline and its hint. Nothing it draws
// takes pointer events or focus: clicks reach the page, and the bridge hit-tests them itself. It lives in a closed shadow root on a host marked
// `data-portifact-ignore`, so the page's styles do not reach it, anchors skip it and the page's
// scripts cannot read into it through the host. Styles are a constructed stylesheet, which a
// page's own CSP does not block, built only from design tokens.
import { IGNORE_ATTRIBUTE } from "@portifact/anchors";
import { TOKENS_CSS } from "@portifact/ui/tokens-css";

/** A box in page coordinates (CSS pixels from the document's top left). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point in page coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** A thread's highlight as drawn: its ID and the boxes of each line (or the element). */
export interface HitArea {
  id: string;
  boxes: readonly Box[];
}

function contains(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function area(boxes: readonly Box[]): number {
  return boxes.reduce((sum, box) => sum + box.width * box.height, 0);
}

/**
 * The threads whose highlight covers `point`, innermost first: the smallest highlighted area
 * leads, and between equal areas the thread drawn last (the most recent) does.
 */
export function threadsAt(point: Point, drawn: readonly HitArea[]): string[] {
  return drawn
    .map((highlight, order) => ({ highlight, order, size: area(highlight.boxes) }))
    .filter(({ highlight }) => highlight.boxes.some((box) => contains(box, point)))
    .sort((a, b) => a.size - b.size || b.order - a.order)
    .map(({ highlight }) => highlight.id);
}

const OVERLAY_CSS = `${TOKENS_CSS.replaceAll(":root", ":host")}
:host { all: initial; }
.highlight {
  position: absolute;
  pointer-events: none;
  /* Translucent, so where threads overlap the layers add up to a darker band, and light enough
     that the text under it keeps its contrast. */
  background: color-mix(in srgb, var(--pf-color-text) 14%, transparent);
  border-bottom: var(--pf-border-width-strong) solid
    color-mix(in srgb, var(--pf-color-text) 45%, transparent);
}
.highlight[data-state="selected"],
.highlight[data-state="primary"] {
  background: color-mix(in srgb, var(--pf-color-text) 26%, transparent);
  border-bottom-color: var(--pf-color-text);
}
.highlight[data-state="primary"] {
  outline: var(--pf-border-width-strong) solid var(--pf-color-text);
}
.element {
  position: absolute;
  pointer-events: none;
  outline: var(--pf-border-width) solid var(--pf-color-text);
  outline-offset: var(--pf-space-1);
  border-radius: var(--pf-radius-xs);
}
.element[data-state="selected"],
.element[data-state="primary"] {
  outline-width: var(--pf-border-width-strong);
  background: color-mix(in srgb, var(--pf-color-text) 10%, transparent);
}
.highlight[data-hovered],
.element[data-hovered] {
  outline: var(--pf-border-width-strong) dashed var(--pf-color-text);
  outline-offset: var(--pf-space-1);
}
.pick {
  position: absolute;
  pointer-events: none;
  outline: var(--pf-border-width-strong) dashed var(--pf-color-text);
  outline-offset: var(--pf-space-1);
  background: var(--pf-color-selection);
  opacity: 0.4;
}
.hint {
  position: fixed;
  top: var(--pf-space-2);
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
  padding: var(--pf-space-2) var(--pf-space-4);
  border-radius: var(--pf-radius-md);
  background: var(--pf-color-surface-inverse);
  color: var(--pf-color-text-inverse);
  font: var(--pf-text-sm) / var(--pf-leading-tight) var(--pf-font-sans);
  box-shadow: var(--pf-shadow-float);
}
`;

/** How a highlight is emphasized: the first selected thread, another selected one, or not. */
export type HighlightState = "primary" | "selected" | null;

export interface DrawnHighlight {
  id: string;
  kind: "text" | "element";
  boxes: Box[];
  state: HighlightState;
}

export interface Overlay {
  readonly host: HTMLElement;
  /** The closed shadow root; only the bridge holds a reference to it. */
  readonly root: ShadowRoot;
  clearHighlights(): void;
  /** Draws one thread's boxes; returns the first, to scroll to. */
  highlight(highlight: DrawnHighlight): HTMLElement | null;
  /** Outlines the boxes of one thread, the one the reader points at in the sidebar. */
  hover(id: string | null): void;
  /** Shows or hides the element-mode outline and hint. */
  pick(box: Box | null, hint: string | null): void;
  remove(): void;
}

export function createOverlay(document: Document): Overlay {
  const host = document.createElement("portifact-review");
  host.setAttribute(IGNORE_ATTRIBUTE, "");
  // CSSOM writes are allowed under any page CSP, unlike a style attribute.
  host.style.setProperty("position", "absolute");
  host.style.setProperty("top", "0");
  host.style.setProperty("left", "0");
  host.style.setProperty("width", "0");
  host.style.setProperty("height", "0");
  host.style.setProperty("z-index", "2147483647");
  host.style.setProperty("pointer-events", "none");
  const root = host.attachShadow({ mode: "closed" });
  const view = document.defaultView;
  if (view && "CSSStyleSheet" in view && "adoptedStyleSheets" in root) {
    const sheet = new view.CSSStyleSheet();
    sheet.replaceSync(OVERLAY_CSS);
    root.adoptedStyleSheets = [sheet];
  }
  const layer = document.createElement("div");
  const picker = document.createElement("div");
  root.append(layer, picker);
  const drawn = new Map<string, HTMLElement[]>();
  let hovered: string | null = null;
  document.documentElement.append(host);

  const place = (element: HTMLElement, box: Box) => {
    element.style.setProperty("left", `${box.x}px`);
    element.style.setProperty("top", `${box.y}px`);
    element.style.setProperty("width", `${box.width}px`);
    element.style.setProperty("height", `${box.height}px`);
  };

  return {
    host,
    root,
    clearHighlights() {
      layer.replaceChildren();
      drawn.clear();
    },
    highlight({ id, kind, boxes, state }) {
      const elements = boxes.map((box) => {
        const element = document.createElement("div");
        element.className = kind === "element" ? "element" : "highlight";
        if (state) element.dataset.state = state;
        if (id === hovered) element.dataset.hovered = "";
        place(element, box);
        return element;
      });
      layer.append(...elements);
      drawn.set(id, elements);
      return elements[0] ?? null;
    },
    hover(id) {
      for (const element of drawn.get(hovered ?? "") ?? []) delete element.dataset.hovered;
      hovered = id;
      for (const element of drawn.get(id ?? "") ?? []) element.dataset.hovered = "";
    },
    pick(box, hint) {
      picker.replaceChildren();
      if (box) {
        const outline = document.createElement("div");
        outline.className = "pick";
        place(outline, box);
        picker.append(outline);
      }
      if (hint) {
        const text = document.createElement("div");
        text.className = "hint";
        text.setAttribute("role", "status");
        text.textContent = hint;
        picker.append(text);
      }
    },
    remove() {
      host.remove();
    },
  };
}
