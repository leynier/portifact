import { ANCHOR_SCHEMA_VERSION, type AnnotationTarget } from "@portifact/contracts";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { EDIT_LIMITS, Edit } from "../src/operations.ts";
import { checkStyle, STYLE_PROPERTIES } from "../src/style.ts";

const HOSTILE: [string, string][] = [
  ["background-color", "url(https://evil.example/p.png)"],
  ["color", "url(x)"],
  ["color", "expression(alert(1))"],
  ["color", "red;position:fixed"],
  ["color", "red; background-image: url(x)"],
  ["color", "red !important"],
  ["color", "var(--x)"],
  ["color", "attr(title)"],
  ["color", "rgb(0 0 0) url(x)"],
  ["color", "\\72 ed"],
  ["color", "r\\65 d"],
  ["color", "red/**/"],
  ["color", "red}body{background:url(x)"],
  ["color", "RED"],
  ["color", " red"],
  ["color", "image-set(url(x) 1x)"],
  ["color", "rgb(999, 0, 0)"],
  ["color", "light-dark(red, url(x))"],
  ["color", "color-mix(in srgb, red, blue)"],
  ["color", "\u0000red"],
  ["font-size", "99999px"],
  ["font-size", "calc(100vh + 1px)"],
  ["font-size", "100vw"],
  ["font-size", "-1px"],
  ["font-size", "0"],
  ["margin-top", "-500px"],
  ["margin-top", "1e9px"],
  ["margin-left", "calc(-100vw)"],
  ["line-height", "999"],
  ["letter-spacing", "-50px"],
  ["font-weight", "bold;"],
  ["text-align", "center\nposition: fixed"],
  ["position", "fixed"],
  ["position", "absolute"],
  ["z-index", "99999"],
  ["inset", "0"],
  ["top", "0"],
  ["transform", "translate(-100px)"],
  ["display", "none"],
  ["visibility", "hidden"],
  ["opacity", "0"],
  ["content", '"Sign in"'],
  ["background", "url(x)"],
  ["background-image", "url(x)"],
  ["list-style-image", "url(x)"],
  ["cursor", "url(x), auto"],
  ["font-family", "x; src: url(x)"],
  ["behavior", "url(x.htc)"],
  ["-moz-binding", "url(x.xml#x)"],
  ["mask", "url(x)"],
  ["filter", "url(#x)"],
  ["clip-path", "url(#x)"],
  ["width", "100vw"],
  ["--x", "url(x)"],
  ["constructor", "x"],
  ["__proto__", "x"],
  ["Color", "red"],
];

const ALLOWED: [string, string][] = [
  ["color", "#1a2b3c"],
  ["color", "rgb(10, 20, 30)"],
  ["color", "rgb(10 20 30 / 0.5)"],
  ["color", "navy"],
  ["background-color", "#fff8"],
  ["font-size", "18px"],
  ["font-size", "1.25rem"],
  ["font-weight", "700"],
  ["font-style", "italic"],
  ["text-align", "center"],
  ["text-decoration-line", "underline"],
  ["text-transform", "uppercase"],
  ["line-height", "1.5"],
  ["letter-spacing", "0.05em"],
  ["margin-top", "24px"],
  ["margin-bottom", "0"],
  ["margin-left", "2rem"],
  ["margin-right", "10%"],
  ["padding-top", "4px"],
  ["padding-bottom", "0.5em"],
  ["padding-left", "1em"],
  ["padding-right", "12px"],
  ["line-height", "normal"],
  ["letter-spacing", "normal"],
  ["border-radius", "8px"],
];

describe("style allowlist", () => {
  it("refuses every hostile value and property", () => {
    for (const [property, value] of HOSTILE) {
      expect(checkStyle(property, value), `${property}: ${value}`).not.toBe(true);
    }
    console.log(
      "style",
      JSON.stringify({
        hostile: HOSTILE.length,
        refused: HOSTILE.length,
        properties: Object.keys(STYLE_PROPERTIES).length,
      }),
    );
  });

  it("accepts the values the viewer's style panel offers", () => {
    for (const [property, value] of ALLOWED)
      expect(checkStyle(property, value), `${property}: ${value}`).toBe(true);
  });

  it("applies an allowed value through setProperty as at most one declaration that loads nothing", () => {
    const { document } = new Window();
    const element = document.createElement("p");
    for (const [property, value] of ALLOWED) {
      element.removeAttribute("style");
      element.style.setProperty(property, value);
      const declared = element.getAttribute("style") ?? "";
      // At most one: an engine that does not know a value (happy-dom drops a few) sets nothing.
      expect(
        declared.split(";").filter((part) => part.trim().length > 0).length,
      ).toBeLessThanOrEqual(1);
      expect(declared).not.toMatch(/url\(|image|@/i);
    }
  });
});

const elementTarget = (path = "index.html"): AnnotationTarget => ({
  schema: ANCHOR_SCHEMA_VERSION,
  path,
  anchor: {
    kind: "element",
    selectors: ["main > p:nth-of-type(2)"],
    tagName: "p",
    fingerprint: "Hello",
  },
});

const textTarget = (exact: string): AnnotationTarget => ({
  schema: ANCHOR_SCHEMA_VERSION,
  path: "index.html",
  anchor: {
    kind: "text",
    quote: { exact, prefix: "", suffix: "" },
    position: { start: 0, end: Array.from(exact).length },
  },
});

describe("edit model", () => {
  it("accepts inert operations of the three kinds", () => {
    const parsed = Edit.safeParse({
      operations: [
        { kind: "text", target: textTarget("Hello"), after: "Hi there" },
        {
          kind: "style",
          target: elementTarget(),
          changes: [{ property: "color", before: "rgb(0, 0, 0)", after: "navy" }],
        },
        {
          kind: "structure",
          action: "move",
          target: elementTarget(),
          destination: { target: elementTarget(), place: "after" },
        },
        { kind: "structure", action: "duplicate", target: elementTarget() },
        { kind: "structure", action: "remove", target: elementTarget() },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses markup, arbitrary inserts, unknown keys, other pages and oversized edits", () => {
    const refused = [
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "Hello" }] },
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "two\nlines" }] },
      { operations: [{ kind: "text", target: elementTarget(), after: "x" }] },
      {
        operations: [
          {
            kind: "style",
            target: elementTarget(),
            changes: [{ property: "position", before: null, after: "fixed" }],
          },
        ],
      },
      {
        operations: [
          { kind: "structure", action: "insert", target: elementTarget(), html: "<img src=x>" },
        ],
      },
      {
        operations: [{ kind: "structure", action: "remove", target: elementTarget(), html: "<b>" }],
      },
      { operations: [{ kind: "structure", action: "remove", target: textTarget("Hello") }] },
      {
        operations: [
          { kind: "structure", action: "remove", target: elementTarget("a.html") },
          { kind: "structure", action: "remove", target: elementTarget("b.html") },
        ],
      },
      {
        operations: Array.from({ length: EDIT_LIMITS.operationsMax + 1 }, () => ({
          kind: "structure",
          action: "remove",
          target: elementTarget(),
        })),
      },
      { operations: [] },
    ];
    for (const edit of refused)
      expect(Edit.safeParse(edit).success, JSON.stringify(edit).slice(0, 120)).toBe(false);
  });
});
