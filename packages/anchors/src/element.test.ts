import { AnnotationTarget, ElementAnchor, isSafeSelector } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnchorDocument } from "./document.ts";
import type { AnchorElement } from "./dom.ts";
import { contentHash } from "./hash.ts";
import { isStableIdentifier, query } from "./selectors.ts";
import { page } from "./test-helpers.ts";

const one = (root: AnchorElement, selector: string): AnchorElement => {
  const [element] = query(root, selector);
  if (!element) throw new Error(`nothing matches ${selector}`);
  return element;
};

function elementAnchor(doc: AnchorDocument, element: AnchorElement) {
  const result = doc.createElementAnchor(element);
  if (!result.ok) throw new Error(`expected an anchor: ${result.message}`);
  return result.value;
}

describe("createElementAnchor", () => {
  it("records the ID first, a path fallback, the tag and a text fingerprint", () => {
    const { body } = page(
      '<main><section id="pricing"><h2>Pricing</h2><p>Free  and\nPro</p></section></main>',
    );
    const doc = new AnchorDocument(body);
    const anchor = elementAnchor(doc, one(body, "#pricing"));
    expect(anchor).toEqual({
      kind: "element",
      selectors: ["#pricing", "body > main > section"],
      tagName: "section",
      fingerprint: "Pricing Free and Pro",
    });
    expect(AnnotationTarget.safeParse({ schema: 1, path: "index.html", anchor }).success).toBe(
      true,
    );
  });

  it("uses stable test attributes and skips values outside the selector grammar", () => {
    const { body } = page(
      '<button data-testid="save draft">Save</button><button name="a&quot;b" data-cy="go">Go</button>',
    );
    const doc = new AnchorDocument(body);
    expect(elementAnchor(doc, one(body, "button")).selectors).toEqual([
      'button[data-testid="save draft"]',
      "body > button:nth-of-type(1)",
    ]);
    expect(elementAnchor(doc, query(body, "button")[1] as AnchorElement).selectors).toEqual([
      'button[data-cy="go"]',
      "body > button:nth-of-type(2)",
    ]);
  });

  it("ignores generated IDs and anchors paths on the nearest stable ID", () => {
    const { body } = page(
      '<div id="app"><div id="radix-123456"><p>a</p><p id=":r1:">b</p></div></div>',
    );
    const doc = new AnchorDocument(body);
    const target = query(body, "p")[1] as AnchorElement;
    expect(elementAnchor(doc, target).selectors).toEqual([
      "#app > div > p:nth-of-type(2)",
      "body > div > div > p:nth-of-type(2)",
    ]);
  });

  it("keeps at most four selectors and drops ones that are not unique", () => {
    const { body } = page(
      '<div id="wrap"><input id="email" name="email" data-testid="email" data-qa="email" data-cy="email"></div><input name="email">',
    );
    const anchor = elementAnchor(new AnchorDocument(body), one(body, "#email"));
    expect(anchor.selectors).toEqual([
      "#email",
      'input[data-testid="email"]',
      'input[data-cy="email"]',
      'input[data-qa="email"]',
    ]);
    expect(anchor.fingerprint).toBe("");
  });

  it("passes the visual rect through", () => {
    const { body } = page("<p>x</p>");
    const rect = { x: 1, y: 2, width: 30, height: 40 };
    const result = new AnchorDocument(body).createElementAnchor(one(body, "p"), rect);
    expect(result).toMatchObject({ ok: true, value: { rect } });
  });

  it("caps the fingerprint at its length", () => {
    const { body } = page(`<p>${"word ".repeat(100)}</p>`);
    const anchor = elementAnchor(new AnchorDocument(body), one(body, "p"));
    expect(Array.from(anchor.fingerprint).length).toBeLessThanOrEqual(128);
    expect(anchor.fingerprint.startsWith("word word")).toBe(true);
    expect(ElementAnchor.safeParse(anchor).success).toBe(true);
  });

  it("refuses the root, elements outside it and elements no selector can reach", () => {
    const { document, body } = page(`${"<div>".repeat(40)}<p>deep</p>${"</div>".repeat(40)}`);
    const doc = new AnchorDocument(body);
    expect(doc.createElementAnchor(body)).toMatchObject({ ok: false, reason: "outside_root" });
    expect(doc.createElementAnchor(document.head)).toMatchObject({
      ok: false,
      reason: "outside_root",
    });
    expect(doc.createElementAnchor(one(body, "p"))).toMatchObject({
      ok: false,
      reason: "no_selector",
    });
  });

  it("refuses elements whose tag name is outside the contract", () => {
    const { document, body } = page("");
    const odd = document.createElementNS("urn:x", "x:Odd");
    odd.setAttribute("id", "odd");
    document.body.appendChild(odd);
    expect(new AnchorDocument(body).createElementAnchor(one(body, "#odd"))).toMatchObject({
      ok: false,
      reason: "no_selector",
    });
  });

  it("only produces safe selectors that find exactly their element", () => {
    const element = (children: fc.Arbitrary<string[]>) =>
      fc
        .record({
          tag: fc.constantFrom("div", "p", "span", "ul", "li", "section"),
          id: fc.option(fc.constantFrom("a", "b", "main", "x-1", "id12345", "bad id"), {
            nil: undefined,
          }),
          testid: fc.option(fc.constantFrom("save", 'q"uote', "<x>"), { nil: undefined }),
          text: fc.string({ maxLength: 6 }),
          children,
        })
        .map(({ tag, id, testid, text, children }) => {
          const attributes = `${id ? ` id="${id}"` : ""}${testid ? ` data-testid="${testid.replace(/"/g, "&quot;")}"` : ""}`;
          return `<${tag}${attributes}>${text.replace(/[<&>]/g, "")}${children.join("")}</${tag}>`;
        });
    const tree = fc.letrec<{ node: string }>((tie) => ({
      node: fc.oneof(
        { maxDepth: 3, depthIdentifier: "tree" },
        element(fc.constant([])),
        element(fc.array(tie("node"), { maxLength: 3, depthIdentifier: "tree" })),
      ),
    })).node;
    fc.assert(
      fc.property(fc.array(tree, { minLength: 1, maxLength: 4 }), fc.nat(), (nodes, pick) => {
        const { body } = page(nodes.join(""));
        const elements = query(body, "*");
        const element = elements[pick % elements.length] as AnchorElement;
        const doc = new AnchorDocument(body);
        const result = doc.createElementAnchor(element);
        if (!result.ok) return;
        expect(ElementAnchor.safeParse(result.value).success).toBe(true);
        for (const selector of result.value.selectors) {
          expect(isSafeSelector(selector)).toBe(true);
          expect(query(body, selector)).toEqual([element]);
        }
        const resolved = doc.resolveElement(result.value);
        expect(resolved).toMatchObject({ confidence: "exact" });
        if (resolved.confidence !== "orphaned") expect(resolved.element).toBe(element);
      }),
      { numRuns: 150 },
    );
  });
});

describe("resolveElement", () => {
  const anchorIn = (html: string, selector: string) => {
    const { body } = page(html);
    return elementAnchor(new AnchorDocument(body), one(body, selector));
  };
  const resolveIn = (html: string, anchor: ElementAnchor) => {
    const { body } = page(html);
    const result = new AnchorDocument(body).resolveElement(anchor);
    return { body, result };
  };

  it("is exact when the primary selector finds the same element", () => {
    const anchor = anchorIn('<section id="s"><h2>Plans</h2></section>', "#s");
    const { body, result } = resolveIn(
      '<p>new intro</p><section id="s"><h2>Plans</h2></section>',
      anchor,
    );
    expect(result).toEqual({ confidence: "exact", element: one(body, "#s") });
  });

  it("is exact through a fallback when the ID is gone but the element is the same", () => {
    const anchor = anchorIn('<main><section id="s"><h2>Plans</h2></section></main>', "#s");
    const { body, result } = resolveIn("<main><section><h2>Plans</h2></section></main>", anchor);
    expect(result).toEqual({ confidence: "exact", element: one(body, "section") });
  });

  it("is fuzzy when the selector finds an element whose text changed", () => {
    const anchor = anchorIn('<section id="s"><h2>Plans</h2></section>', "#s");
    const { body, result } = resolveIn('<section id="s"><h2>Pricing plans</h2></section>', anchor);
    expect(result).toEqual({ confidence: "fuzzy", element: one(body, "#s") });
  });

  it("prefers the one element with the same text over a selector that finds changed text", () => {
    const anchor = anchorIn("<main><p>first</p><p>target</p></main>", "p:nth-of-type(2)");
    const { body, result } = resolveIn("<main><p>target</p><p>other</p></main>", anchor);
    expect(result).toEqual({ confidence: "fuzzy", element: one(body, "p") });
  });

  it("orphans an element when selectors and text both match several, or nothing matches", () => {
    const anchor = anchorIn('<p class="x">same</p>', "p");
    expect(resolveIn("<div><p>same</p></div><div><p>same</p></div>", anchor).result).toEqual({
      confidence: "orphaned",
      reason: "ambiguous",
    });
    expect(resolveIn("<p>a</p><p>b</p>", anchor).result).toEqual({
      confidence: "orphaned",
      reason: "ambiguous",
    });
    expect(resolveIn("<div>same</div>", anchor).result).toEqual({
      confidence: "orphaned",
      reason: "not_found",
    });
  });

  it("never matches an element with another tag", () => {
    const anchor = anchorIn('<h2 id="t">Title</h2>', "#t");
    expect(resolveIn('<h3 id="t">Title</h3>', anchor).result).toEqual({
      confidence: "orphaned",
      reason: "not_found",
    });
  });

  it("does not search by an empty fingerprint", () => {
    const anchor = anchorIn('<img id="logo" alt="">', "#logo");
    expect(resolveIn('<img id="logo" alt="">', anchor).result).toMatchObject({
      confidence: "exact",
    });
    expect(resolveIn('<span><img alt=""></span><span><img alt=""></span>', anchor).result).toEqual({
      confidence: "orphaned",
      reason: "not_found",
    });
  });
});

describe("resolve", () => {
  const { body } = page('<div id="app"><p>Hello world</p></div>');
  const doc = new AnchorDocument(body);
  const textResult = doc.createTextAnchor({
    start: { node: one(body, "p").childNodes[0] as AnchorElement, offset: 6 },
    end: { node: one(body, "p").childNodes[0] as AnchorElement, offset: 11 },
  });
  const elementResult = doc.createElementAnchor(one(body, "p"));
  if (!textResult.ok || !elementResult.ok) throw new Error("expected anchors");
  const target = (anchor: AnnotationTarget["anchor"], route?: string): AnnotationTarget =>
    AnnotationTarget.parse({ schema: 1, path: "index.html", anchor, ...(route ? { route } : {}) });

  it("resolves each kind of target", () => {
    expect(doc.resolve(target({ kind: "document" }))).toEqual({
      confidence: "exact",
      kind: "document",
    });
    expect(doc.resolve(target(textResult.value))).toMatchObject({
      confidence: "exact",
      kind: "text",
      text: "world",
    });
    expect(doc.resolve(target(elementResult.value))).toMatchObject({
      confidence: "exact",
      kind: "element",
    });
  });

  it("orphans text and element targets recorded on another SPA route", () => {
    expect(doc.resolve(target(textResult.value, "/a"), { route: "/b" })).toEqual({
      confidence: "orphaned",
      reason: "route_mismatch",
      kind: "text",
    });
    expect(doc.resolve(target(elementResult.value, "/a"), { route: "/b" })).toMatchObject({
      confidence: "orphaned",
      kind: "element",
    });
    expect(doc.resolve(target({ kind: "document" }, "/a"), { route: "/b" })).toMatchObject({
      confidence: "exact",
    });
    expect(doc.resolve(target(textResult.value, "/a"), { route: "/a" })).toMatchObject({
      confidence: "exact",
    });
    expect(doc.resolve(target(textResult.value, "/a"))).toMatchObject({ confidence: "exact" });
  });
});

describe("selectors", () => {
  it.each([
    ["main", true],
    ["pricing-table", true],
    ["_private", true],
    ["radix-123456", false],
    ["a1b2c3d4e5f6", false],
    ["deadbeef", false],
    [":r1:", false],
    ["has space", false],
    ["1abc", false],
    ["a".repeat(65), false],
  ])("isStableIdentifier(%j) is %s", (value, expected) => {
    expect(isStableIdentifier(value)).toBe(expected);
  });

  it("treats a selector the DOM refuses as matching nothing", () => {
    const refusing = {
      nodeType: 1,
      parentNode: null,
      childNodes: [],
      tagName: "BODY",
      getAttribute: () => null,
      querySelectorAll: () => {
        throw new Error("SyntaxError");
      },
    };
    expect(query(refusing, "p")).toEqual([]);
  });
});

describe("contentHash", () => {
  it("hashes the normalized text as lowercase hex SHA-256", async () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(await contentHash(" \n ")).toBe(empty);
    expect(await contentHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await contentHash("  a\r\ne\u0301c ")).toBe(await contentHash("a \u00e9c"));
  });
});
