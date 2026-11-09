// @vitest-environment happy-dom
import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import { beforeEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown.ts";
import {
  type DiagramHost,
  type Mermaid,
  mermaidConfig,
  pageHost,
  prepareDrawing,
  renderDiagrams,
} from "./diagrams.ts";

const SVG = (title = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 120px;" viewBox="0 0 120.5 80">${title}<g><text>A</text></g></svg>`;

const SOURCE = [
  "# Plan",
  "",
  "```ts",
  "const answer: number = 42; // the answer",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  Write --> Review",
  "```",
  "",
  "```mermaid",
  "broken",
  "```",
  "",
  "The end.",
].join("\n");

interface FakeHost extends DiagramHost {
  configs: Record<string, unknown>[];
  rendered: string[];
  released: string[];
  dark: boolean;
  changeScheme(): Promise<void>;
}

function fakeHost(svg = SVG()): FakeHost {
  let listener: (() => void) | undefined;
  let urls = 0;
  const host: FakeHost = {
    document,
    configs: [],
    rendered: [],
    released: [],
    dark: false,
    mermaid: {
      initialize: (config) => {
        host.configs.push(config);
      },
      render: async (id, text) => {
        host.rendered.push(text);
        if (text.startsWith("broken")) {
          // Like Mermaid after a syntax error: the temporary element stays behind.
          const left = document.createElement("div");
          left.id = `d${id}`;
          document.body.append(left);
          throw new Error("Parse error");
        }
        return { svg };
      },
    },
    token: (name) => `token(${name})`,
    isDark: () => host.dark,
    onSchemeChange: (next) => {
      listener = next;
    },
    imageUrl: () => {
      urls += 1;
      return `blob:diagram-${urls}`;
    },
    releaseUrl: (url) => {
      host.released.push(url);
    },
    changeScheme: async () => {
      listener?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
  return host;
}

function load(source = SOURCE): HTMLElement {
  document.body.innerHTML = `<main class="pf-document pf-markdown">${renderMarkdown(source).html}</main>`;
  return document.body;
}

const blockText = (pre: Element) => pre.textContent;

describe("diagram runner", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("draws each Mermaid block as an image above its source and folds the source", async () => {
    const body = load();
    const host = fakeHost(SVG("<title>Release flow</title><desc>From writing to review</desc>"));
    await renderDiagrams(host);
    const [figure, ...others] = Array.from(body.querySelectorAll("figure"));
    expect(others).toHaveLength(0);
    expect(figure?.getAttribute("data-portifact-ignore")).toBe("");
    expect(figure?.className).toBe("pf-diagram");
    const image = figure?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:diagram-1");
    expect(image?.getAttribute("alt")).toBe("Release flow. From writing to review");
    expect([image?.getAttribute("width"), image?.getAttribute("height")]).toEqual(["121", "80"]);
    const pre = figure?.nextElementSibling;
    expect(pre?.classList.contains("pf-mermaid")).toBe(true);
    expect(pre?.classList.contains("pf-diagram-folded")).toBe(true);
    expect(pre && blockText(pre)).toBe("flowchart LR\n  Write --> Review\n");
    expect(host.rendered).toEqual(["flowchart LR\n  Write --> Review\n", "broken\n"]);
  });

  it("leaves a block it cannot draw as readable source and cleans up after Mermaid", async () => {
    const body = load();
    await renderDiagrams(fakeHost());
    const pres = Array.from(body.querySelectorAll("pre.pf-mermaid"));
    expect(pres[1]?.classList.contains("pf-diagram-folded")).toBe(false);
    expect(pres[1]?.previousElementSibling?.tagName).toBe("PRE");
    expect(body.querySelector("#dpf-diagram-2")).toBeNull();
  });

  it("names the image with the block's label when the diagram has no title", async () => {
    const body = load();
    await renderDiagrams(fakeHost());
    expect(body.querySelector("figure img")?.getAttribute("alt")).toBe("Diagram");
  });

  it("shows and folds the source with a disclosure button", async () => {
    const body = load();
    await renderDiagrams(fakeHost());
    const button = body.querySelector("figure button") as HTMLButtonElement;
    const pre = body.querySelector("pre.pf-mermaid") as HTMLElement;
    expect([button.type, button.textContent, button.getAttribute("aria-expanded")]).toEqual([
      "button",
      "Diagram source",
      "false",
    ]);
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(pre.classList.contains("pf-diagram-folded")).toBe(false);
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(pre.classList.contains("pf-diagram-folded")).toBe(true);
  });

  it("draws again with the other scheme's colors, reusing the image", async () => {
    const body = load();
    const host = fakeHost();
    await renderDiagrams(host);
    const image = body.querySelector("figure img");
    host.dark = true;
    await host.changeScheme();
    expect(host.configs.map((config) => config.darkMode)).toEqual([false, true]);
    expect(body.querySelectorAll("figure")).toHaveLength(1);
    expect(body.querySelector("figure img")).toBe(image);
    expect(image?.getAttribute("src")).toBe("blob:diagram-2");
    expect(host.released).toEqual(["blob:diagram-1"]);
  });

  it("does nothing on a page without Mermaid blocks", async () => {
    load("# Plain\n\n```ts\nlet a\n```");
    const host = fakeHost();
    await renderDiagrams(host);
    expect(host.configs).toEqual([]);
    expect(document.querySelector("figure")).toBeNull();
  });

  it("keeps the source when Mermaid cannot even start", async () => {
    const body = load();
    const host = fakeHost();
    host.mermaid = {
      initialize: () => {
        throw new Error("no");
      },
      render: () => Promise.reject(new Error("unreachable")),
    } satisfies Mermaid;
    await renderDiagrams(host);
    expect(body.querySelector("figure")).toBeNull();
  });

  it("keeps annotation anchors where they were, in code and in diagram sources", async () => {
    const body = load();
    const before = new AnchorDocument(body as unknown as AnchorElement);
    const quotes = ["answer: number = 42", "Write --> Review", "The end"];
    const anchors = quotes.map((quote) => {
      const at = before.text.value.indexOf(quote);
      return { quote, at };
    });
    await renderDiagrams(fakeHost(SVG("<title>Drawn label text</title>")));
    const after = new AnchorDocument(body as unknown as AnchorElement);
    expect(after.text.value).toBe(before.text.value);
    expect(after.text.value).not.toContain("Drawn label text");
    for (const { quote, at } of anchors) {
      expect(at).toBeGreaterThan(-1);
      expect(after.text.value.indexOf(quote)).toBe(at);
    }
  });
});

describe("Mermaid configuration", () => {
  it("is strict, without HTML labels, and the diagram cannot change that", () => {
    const config = mermaidConfig((name) => `t:${name}`, false);
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: "base",
      darkMode: false,
    });
    expect(config.secure).toEqual(
      expect.arrayContaining(["secure", "securityLevel", "htmlLabels", "maxTextSize", "maxEdges"]),
    );
  });

  it("paints the base theme with the design tokens", () => {
    const config = mermaidConfig((name) => `t:${name}`, true);
    expect(config.darkMode).toBe(true);
    expect(config.fontFamily).toBe("t:font-sans");
    expect(config.themeVariables).toMatchObject({
      darkMode: true,
      background: "t:color-canvas",
      primaryColor: "t:color-surface",
      primaryTextColor: "t:color-text",
      primaryBorderColor: "t:color-border-strong",
      lineColor: "t:color-text-muted",
    });
    for (const value of Object.values(config.themeVariables)) {
      if (typeof value === "string") expect(value).toMatch(/^t:(color|font)-/);
    }
  });
});

describe("preparing a drawing", () => {
  it("sizes the SVG by its viewBox and keeps its title and description", () => {
    const drawing = prepareDrawing(SVG("<title>T</title><desc>D</desc>"));
    expect(drawing && [drawing.width, drawing.height, drawing.label]).toEqual([120.5, 80, "T. D"]);
    expect(drawing?.svg).toContain('width="120.5"');
    expect(drawing?.svg).not.toContain("max-width");
  });

  it("leaves the size to the browser without a usable viewBox", () => {
    const drawing = prepareDrawing(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10"></svg>',
    );
    expect(drawing && [drawing.width, drawing.height, drawing.label]).toEqual([
      undefined,
      undefined,
      "",
    ]);
  });

  it("refuses anything that is not an SVG document", () => {
    expect(prepareDrawing('<html xmlns="http://www.w3.org/1999/xhtml"></html>')).toBeUndefined();
    expect(prepareDrawing("<svg")).toBeUndefined();
  });
});

describe("the page host", () => {
  it("reads tokens and the scheme from the root, and makes blob URLs", async () => {
    const root = document.documentElement;
    root.style.setProperty("--pf-color-text", " #000000 ");
    const host = pageHost(window as unknown as Window & typeof globalThis, fakeHost().mermaid);
    expect(host.document).toBe(document);
    expect(host.token("color-text")).toBe("#000000");
    root.style.setProperty("color-scheme", "dark");
    expect(host.isDark()).toBe(true);
    root.style.setProperty("color-scheme", "light");
    expect(host.isDark()).toBe(false);
    let changes = 0;
    host.onSchemeChange(() => {
      changes += 1;
    });
    root.setAttribute("data-theme", "dark");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toBe(1);
    const url = host.imageUrl("<svg/>");
    expect(url).toMatch(/^blob:/);
    host.releaseUrl(url);
  });
});
