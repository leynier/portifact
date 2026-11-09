// Draws the Mermaid blocks of a rendered document in the browser, on the artifact origin. Runs
// after the pinned Mermaid build in the diagram script (`scripts/build-diagrams.ts`).
//
// Each drawing becomes an `<img>` of a `blob:` SVG: an image never runs scripts, loads nothing
// and follows no links, so even a flaw in Mermaid's own sanitizing cannot reach the page. The
// source block stays where it was with the same text, folded behind a control, so annotation
// anchors resolve the same whether the script ran or not; the drawing is marked
// `data-portifact-ignore` and adds no text.

/** The part of Mermaid's API the runner uses. */
export interface Mermaid {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** What the runner needs from the page, injected so tests can pass fakes. */
export interface DiagramHost {
  document: Document;
  mermaid: Mermaid;
  /** The value of a design token on the root element, such as `color-text`. */
  token(name: string): string;
  /** Whether the page shows its dark color scheme now. */
  isDark(): boolean;
  /** Calls `listener` whenever the color scheme may have changed. */
  onSchemeChange(listener: () => void): void;
  /** A URL the page can load the SVG from, and its release. */
  imageUrl(svg: string): string;
  releaseUrl(url: string): void;
}

/** Mermaid configuration keys a diagram's own directives and front matter cannot change. */
const SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
];

/**
 * Mermaid's settings: strict security (labels sanitized, no click handlers or scripts), SVG text
 * labels instead of HTML in `foreignObject`, no error drawings, and the `base` theme painted with
 * the design tokens, so diagrams are monochrome and follow the light and dark schemes. Authors
 * may still choose colors in their diagrams: published content keeps its own colors.
 */
export function mermaidConfig(token: (name: string) => string, dark: boolean) {
  const canvas = token("color-canvas");
  const surface = token("color-surface");
  const raised = token("color-surface-hover");
  const text = token("color-text");
  const muted = token("color-text-muted");
  const border = token("color-border-strong");
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    secure: SECURE_KEYS,
    theme: "base",
    darkMode: dark,
    fontFamily: token("font-sans"),
    themeVariables: {
      darkMode: dark,
      fontFamily: token("font-sans"),
      background: canvas,
      mainBkg: surface,
      primaryColor: surface,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: raised,
      secondaryTextColor: text,
      secondaryBorderColor: border,
      tertiaryColor: canvas,
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      lineColor: muted,
      textColor: text,
      titleColor: text,
      nodeBorder: border,
      clusterBkg: canvas,
      clusterBorder: border,
      edgeLabelBackground: canvas,
      noteBkgColor: raised,
      noteTextColor: text,
      noteBorderColor: border,
      actorBkg: surface,
      actorBorder: border,
      actorTextColor: text,
      signalColor: text,
      signalTextColor: text,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: text,
      critBkgColor: muted,
      critBorderColor: text,
      errorBkgColor: raised,
      errorTextColor: text,
    },
  };
}

/** A drawing ready for an `<img>`: the SVG with an intrinsic size, and its text alternative. */
export interface Drawing {
  svg: string;
  width: number | undefined;
  height: number | undefined;
  /** The diagram's own title and description (Mermaid's `accTitle` and `accDescr`), if any. */
  label: string;
}

/**
 * Reads what the `<img>` needs from Mermaid's SVG. Parsing as XML runs nothing. Mermaid sizes the
 * SVG to its container (`width="100%"`); as an image it needs the size of its `viewBox`.
 */
export function prepareDrawing(svg: string): Drawing | undefined {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length > 0) {
    return undefined;
  }
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [width, height] = [box[2], box[3]];
  const sized = width !== undefined && height !== undefined && width > 0 && height > 0;
  if (sized) {
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
    root.removeAttribute("style");
  }
  const label = [childText(root, "title"), childText(root, "desc")].filter(Boolean).join(". ");
  return {
    svg: new XMLSerializer().serializeToString(parsed),
    width: sized ? width : undefined,
    height: sized ? height : undefined,
    label,
  };
}

function childText(root: Element, name: string): string {
  for (const child of Array.from(root.children)) {
    if (child.localName === name) return (child.textContent ?? "").trim();
  }
  return "";
}

/** One Mermaid block of the page and what the runner drew for it. */
interface Block {
  pre: HTMLElement;
  source: string;
  image?: HTMLImageElement;
  url?: string;
}

/** Draws every Mermaid block, and draws them again when the color scheme changes. */
export async function renderDiagrams(host: DiagramHost): Promise<void> {
  const { document } = host;
  const blocks: Block[] = Array.from(
    document.querySelectorAll<HTMLElement>("pre.pf-mermaid"),
    (pre) => ({ pre, source: pre.textContent ?? "" }),
  );
  if (blocks.length === 0) return;
  let pass = Promise.resolve();
  const draw = () => {
    pass = pass.then(() => drawAll(host, blocks));
    return pass;
  };
  host.onSchemeChange(() => void draw());
  await draw();
}

async function drawAll(host: DiagramHost, blocks: Block[]): Promise<void> {
  try {
    host.mermaid.initialize(mermaidConfig(host.token, host.isDark()));
  } catch {
    return;
  }
  for (const [index, block] of blocks.entries()) {
    const drawing = await drawOne(host, block.source, `pf-diagram-${index + 1}`);
    if (drawing) show(host, block, drawing);
  }
}

/** Mermaid's drawing of one source, or undefined when it cannot draw it. */
async function drawOne(
  host: DiagramHost,
  source: string,
  id: string,
): Promise<Drawing | undefined> {
  const { document } = host;
  try {
    const { svg } = await host.mermaid.render(id, source);
    return prepareDrawing(svg);
  } catch {
    return undefined;
  } finally {
    // Mermaid draws in a temporary element; after an error it may leave it behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Puts the drawing above its source block, the first time with the control to fold the source. */
function show(host: DiagramHost, block: Block, drawing: Drawing): void {
  const { document } = host;
  const url = host.imageUrl(drawing.svg);
  if (block.url !== undefined) host.releaseUrl(block.url);
  block.url = url;
  if (block.image) {
    block.image.src = url;
    setSize(block.image, drawing);
    return;
  }
  const { pre } = block;
  const figure = document.createElement("figure");
  figure.className = "pf-diagram";
  figure.setAttribute("data-portifact-ignore", "");
  const image = document.createElement("img");
  image.alt = drawing.label || (pre.dataset.pfDiagram ?? "");
  image.src = url;
  setSize(image, drawing);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "pf-diagram-toggle";
  toggle.textContent = pre.dataset.pfDiagramSource ?? "";
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    pre.classList.toggle("pf-diagram-folded", !expanded);
  });
  figure.append(image, toggle);
  pre.before(figure);
  pre.classList.add("pf-diagram-folded");
  block.image = image;
}

function setSize(image: HTMLImageElement, drawing: Drawing): void {
  for (const name of ["width", "height"] as const) {
    const value = drawing[name];
    if (value === undefined) image.removeAttribute(name);
    else image.setAttribute(name, String(Math.ceil(value)));
  }
}

/** The host of a real page. */
export function pageHost(window: Window & typeof globalThis, mermaid: Mermaid): DiagramHost {
  const root = window.document.documentElement;
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  return {
    document: window.document,
    mermaid,
    token: (name) => window.getComputedStyle(root).getPropertyValue(`--pf-${name}`).trim(),
    isDark: () => {
      const declared = window.getComputedStyle(root).colorScheme;
      return declared === "dark" || (declared !== "light" && scheme.matches);
    },
    onSchemeChange: (listener) => {
      scheme.addEventListener("change", listener);
      new window.MutationObserver(listener).observe(root, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    },
    imageUrl: (svg) =>
      window.URL.createObjectURL(new window.Blob([svg], { type: "image/svg+xml" })),
    releaseUrl: (url) => window.URL.revokeObjectURL(url),
  };
}
