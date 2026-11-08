// What the bridge draws over the artifact: highlights and numbered markers for threads, the
// element-mode outline and its hint. It lives in a closed shadow root on a host marked
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

const OVERLAY_CSS = `${TOKENS_CSS.replaceAll(":root", ":host")}
:host { all: initial; }
.highlight {
  position: absolute;
  pointer-events: none;
  background: var(--pf-color-selection);
  opacity: 0.55;
  border-bottom: var(--pf-border-width-strong) solid var(--pf-color-text);
}
.element {
  position: absolute;
  pointer-events: none;
  outline: var(--pf-border-width-strong) solid var(--pf-color-text);
  outline-offset: var(--pf-space-1);
  border-radius: var(--pf-radius-xs);
}
.marker {
  position: absolute;
  pointer-events: auto;
  min-width: var(--pf-space-6);
  height: var(--pf-space-6);
  padding: 0 var(--pf-space-1);
  border: var(--pf-border-width) solid var(--pf-color-canvas);
  border-radius: var(--pf-radius-lg);
  background: var(--pf-color-surface-inverse);
  color: var(--pf-color-text-inverse);
  font: var(--pf-weight-semibold, 600) var(--pf-text-sm) / 1 var(--pf-font-sans);
  cursor: pointer;
  box-shadow: var(--pf-shadow-sm);
}
.marker:focus-visible {
  outline: var(--pf-border-width-strong) solid var(--pf-color-focus);
  outline-offset: var(--pf-space-1);
}
.marker[aria-current="true"] {
  outline: var(--pf-border-width-strong) solid var(--pf-color-text);
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

export interface DrawnMarker {
  id: string;
  label: string;
  name: string;
  kind: "text" | "element";
  boxes: Box[];
  active: boolean;
}

export interface Overlay {
  readonly host: HTMLElement;
  /** The closed shadow root; only the bridge holds a reference to it. */
  readonly root: ShadowRoot;
  clearMarkers(): void;
  /** Draws one thread: its boxes, and a marker button on the first one. */
  mark(marker: DrawnMarker): HTMLElement | null;
  /** Shows or hides the element-mode outline and hint. */
  pick(box: Box | null, hint: string | null): void;
  remove(): void;
}

export function createOverlay(document: Document, onActivate: (id: string) => void): Overlay {
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
  const markers = document.createElement("div");
  const picker = document.createElement("div");
  root.append(markers, picker);
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
    clearMarkers() {
      markers.replaceChildren();
    },
    mark({ id, label, name, kind, boxes, active }) {
      const [first] = boxes;
      if (!first) return null;
      for (const box of boxes) {
        const highlight = document.createElement("div");
        highlight.className = kind === "element" ? "element" : "highlight";
        place(highlight, box);
        markers.append(highlight);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "marker";
      button.textContent = label;
      button.setAttribute("aria-label", name);
      if (active) button.setAttribute("aria-current", "true");
      button.style.setProperty("left", `${Math.max(0, first.x - 12)}px`);
      button.style.setProperty("top", `${Math.max(0, first.y - 12)}px`);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate(id);
      });
      markers.append(button);
      return button;
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
