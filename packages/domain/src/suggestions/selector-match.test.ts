import { AnchorDocument, type AnchorElement } from "@portifact/anchors";
import type { Element as DomElement } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../testing/suggestions/pages.ts";
import { find, type P5Element, type P5Node, parseHtml, walk } from "./html-dom.ts";
import {
  parseSelector,
  querySelectorAll,
  SELECTOR_LIMITS,
  SelectorBudgetExceeded,
} from "./selector-match.ts";
import { newWork } from "./work.ts";

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
<main id="top"><section class="intro lead"><p>One</p><p data-testid="second thing">Two</p></section>
<section><p>Three</p><div><p>Four</p><span><p>Five</p></span></div></section>
<ul><li>a</li><li class="x">b</li><li>c</li></ul><svg><g><a>not html</a></g></svg>
<table><tr><td>cell</td></tr></table></main></body></html>`;

/** Where an element is, as the indexes of its ancestors' children: the same in both parsers. */
function pathOfP5(node: P5Node): string {
  const parts: number[] = [];
  for (let at = node; (at as { parentNode?: P5Node }).parentNode; ) {
    const parent = (at as { parentNode: P5Node }).parentNode;
    parts.unshift(
      (
        ("childNodes" in parent ? (parent.childNodes as P5Node[]) : []).filter(
          (n) => "tagName" in n,
        ) as P5Node[]
      ).indexOf(at),
    );
    at = parent;
  }
  return parts.join("/");
}

function pathOfDom(node: DomElement): string {
  const parts: number[] = [];
  for (let at: DomElement = node; at.parentElement; at = at.parentElement) {
    parts.unshift(Array.from(at.parentElement.children).indexOf(at));
  }
  parts.unshift(0);
  return parts.join("/");
}

describe("the selector matcher reads the anchors' grammar as browsers do", () => {
  const tree = parseHtml(PAGE, newWork()).document;
  const body = find(tree, "body") as P5Element;
  const dom = parseDocument(PAGE);

  it("finds every element the anchors' own selectors find in a DOM", () => {
    const anchors = new AnchorDocument(dom.body as unknown as AnchorElement);
    let checked = 0;
    for (const element of Array.from(dom.body.querySelectorAll("*"))) {
      const created = anchors.createElementAnchor(element as unknown as AnchorElement);
      if (!created.ok) continue;
      for (const selector of created.value.selectors) {
        const found = querySelectorAll(body, selector);
        // Foreign content is never matched: the anchors' selectors name HTML elements.
        if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
          expect(found).toEqual([]);
          continue;
        }
        expect(found.map(pathOfP5), selector).toEqual([pathOfDom(element)]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("returns what querySelectorAll returns, in document order", () => {
    for (const selector of [
      "p",
      "section p",
      "section > p",
      "body > main > section:nth-of-type(2) p",
      "li:nth-of-type(2)",
      ".intro",
      "section.intro.lead > p",
      'p[data-testid="second thing"]',
      "#top li",
      "div p",
      "div > p",
      "td",
      "main > p",
      "span",
    ]) {
      const expected = Array.from(dom.body.querySelectorAll(selector)).map(pathOfDom);
      expect(querySelectorAll(body, selector).map(pathOfP5), selector).toEqual(expected);
    }
  });

  it("matches nothing outside the grammar or above the root", () => {
    for (const selector of [
      "",
      "p, li",
      "p:hover",
      "p:not(.x)",
      "*",
      "p ~ p",
      "p + p",
      '[onclick="x"]',
      "P",
      "p[data-testid]",
    ]) {
      expect(parseSelector(selector), selector).toBeNull();
      expect(querySelectorAll(body, selector)).toEqual([]);
    }
    // The root itself is never one of its descendants.
    expect(querySelectorAll(body, "body")).toEqual([]);
    expect(querySelectorAll(body, "html")).toEqual([]);
  });

  it("walks a deep page without exhausting the stack", () => {
    const deep = `<body>${"<div>".repeat(20_000)}<p id="end">x</p></body>`;
    const parsed = parseHtml(deep, newWork()).document;
    const root = find(parsed, "body") as P5Element;
    expect(querySelectorAll(root, "#end")).toHaveLength(1);
    expect([...walk(root)].length).toBeGreaterThan(20_000);
  });
});

describe("the selector matcher's work is bounded and metered (review of pull request #287, P1)", () => {
  const nested = (depth: number) =>
    parseHtml(`<body>${"<div>".repeat(depth)}x${"</div>".repeat(depth)}</body>`, newWork())
      .document;
  // Valid in the anchors' grammar: one compound that matches nothing, then 20 descendant ones.
  const ADVERSARIAL = [".absent", ...Array.from({ length: 20 }, () => "div")].join(" ");

  it("matches a selector that would backtrack exponentially in linear, metered work", () => {
    const document = nested(20);
    const work = newWork();
    expect(parseSelector(ADVERSARIAL)).not.toBeNull();
    expect(querySelectorAll(find(document, "body") as P5Element, ADVERSARIAL, work)).toEqual([]);
    // Each (element, compound) pair is decided once: 21 elements by 21 compounds at most, plus
    // the walk; the naive matcher read tags 3,145,726 times here.
    expect(work.selectorSteps).toBeGreaterThan(0);
    expect(work.selectorSteps).toBeLessThan(2_000);
  });

  it("still finds what a descendant chain names, on a deep page", () => {
    const document = nested(5_000);
    const work = newWork();
    const found = querySelectorAll(find(document, "body") as P5Element, "body div div > div", work);
    expect(found).toHaveLength(4_998);
    expect(work.selectorSteps).toBeLessThan(5_000 * 4 * 3);
  });

  it("stops at its budget and says so through the meter", () => {
    const document = nested(200);
    const work = newWork();
    work.selectorSteps = SELECTOR_LIMITS.steps - 10;
    expect(() => querySelectorAll(find(document, "body") as P5Element, "div div", work)).toThrow(
      SelectorBudgetExceeded,
    );
    expect(work.selectorSteps).toBeGreaterThan(SELECTOR_LIMITS.steps);
  });

  it("reads :nth-of-type from sibling indexes computed once per parent", () => {
    const many = parseHtml(
      `<body><ul>${"<li>x</li>".repeat(2_000)}</ul></body>`,
      newWork(),
    ).document;
    const work = newWork();
    const found = querySelectorAll(find(many, "body") as P5Element, "li:nth-of-type(1999)", work);
    expect(found).toHaveLength(1);
    // A per-element sibling scan would cost about two million steps here.
    expect(work.selectorSteps).toBeLessThan(10_000);
  });
});
