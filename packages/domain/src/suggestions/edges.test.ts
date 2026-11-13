// Edges the plan-level tests reach only in passing, asserted directly: the CSS nesting count that
// guards the preview's parser, which properties count as motion, stale edits on the page index,
// the text-only comparison of two parsed pages, and a Markdown result over the size limit.
import { PLAN_LIMITS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { bodyText, editAt, plan, RENDERER } from "../testing/suggestions/harness.ts";
import { find, type P5Element, parseHtml, textNodesOf } from "./html-dom.ts";
import { subsetRefusal } from "./html-subset.ts";
import { onlyChangedText, PageIndex } from "./locate.ts";
import { previewOfPlan } from "./plan.ts";
import { cssDepth, PREVIEW_CSS_LIMITS, withoutMotion } from "./preview.ts";
import { newWork } from "./work.ts";

const parsed = (html: string) => parseHtml(html, newWork()).document;

describe("the nesting count of a preview's CSS", () => {
  it("counts blocks, parentheses and brackets, and comes back down at each close", () => {
    expect(cssDepth("")).toBe(0);
    expect(cssDepth("a{b{c{}}}")).toBe(3);
    expect(cssDepth("a{}b{}c{}")).toBe(1);
    expect(cssDepth("a(b)c[d]e{f}")).toBe(1);
    expect(cssDepth("a{b(c[d])}")).toBe(3);
    expect(cssDepth("({[")).toBe(3);
    expect(cssDepth("a{b{}}c{}")).toBe(2);
    // Each kind of close ends a level.
    expect(cssDepth("(a)(b)")).toBe(1);
    expect(cssDepth("[a][b]")).toBe(1);
    expect(cssDepth("{a}{b}")).toBe(1);
  });

  it("never goes below zero on stray closes", () => {
    expect(cssDepth("}}}a{}")).toBe(1);
    expect(cssDepth(")))a(b)")).toBe(1);
    expect(cssDepth("]]]a[b]")).toBe(1);
    expect(cssDepth("}a{b{}}")).toBe(2);
  });

  it("skips escapes, comments and strings", () => {
    expect(cssDepth("a\\{b\\(c\\[")).toBe(0);
    expect(cssDepth("\\{{")).toBe(1);
    expect(cssDepth("/* {{{ ((( [[[ */ a{}")).toBe(1);
    expect(cssDepth("a{/* }}} */b{}}")).toBe(2);
    // An unclosed comment runs to the end.
    expect(cssDepth("a{} /* {{{{")).toBe(1);
    expect(cssDepth("/ * {")).toBe(1);
    expect(cssDepth('a{content:"{{{((("}')).toBe(1);
    expect(cssDepth("a{content:'[[[{{{'}")).toBe(1);
    // A quote of the other kind does not end a string, and an escaped quote does not either.
    expect(cssDepth("a{content:\"'{{{'\"}")).toBe(1);
    expect(cssDepth('a{content:"\\"{{{"}')).toBe(1);
    expect(cssDepth("a{content:'\\'{{{'}")).toBe(1);
    // A string ends at a line break when it was never closed, so what follows counts again.
    expect(cssDepth('a{content:"{{\n{b{}}')).toBe(3);
    expect(cssDepth('"{\\\n{"{')).toBe(1);
  });

  it("is the bound the parser is given", () => {
    const nested = (depth: number) => `${"a{".repeat(depth)}${"}".repeat(depth)}`;
    expect(cssDepth(nested(PREVIEW_CSS_LIMITS.depth))).toBe(PREVIEW_CSS_LIMITS.depth);
    expect(() => withoutMotion(nested(PREVIEW_CSS_LIMITS.depth), "stylesheet")).not.toThrow();
    expect(() => withoutMotion(nested(PREVIEW_CSS_LIMITS.depth + 1), "stylesheet")).toThrow();
  });
});

describe("which declarations a preview drops", () => {
  it("drops animation and transition, prefixed or not, shorthand or longhand, and nothing else", () => {
    const kept = (declaration: string) =>
      withoutMotion(`p{color:red;${declaration}}`, "stylesheet").includes(
        declaration.split(":")[0] as string,
      );
    for (const dropped of [
      "animation:spin 1s",
      "animation-name:spin",
      "transition:all 1s",
      "transition-duration:1s",
      "-webkit-animation:spin 1s",
      "-moz-transition-property:all",
      "ANIMATION:spin 1s",
    ]) {
      expect(kept(dropped), dropped).toBe(false);
    }
    for (const stays of [
      "animations:x",
      "transitional:x",
      "my-animation:x",
      "x-transition-y:x",
      "--animation:x",
      "webkit-animation:x",
      "-9-animation:x",
    ]) {
      expect(kept(stays), stays).toBe(true);
    }
    expect(withoutMotion("color:red;animation:spin 1s;top:0", "declarationList")).toBe(
      "color:red;top:0",
    );
  });
});

describe("the page index on stale edits", () => {
  const index = () => {
    const body = find(parsed("<!doctype html><p>one two three</p>"), "body") as P5Element;
    return new PageIndex(body, newWork());
  };

  it("refuses an edit that is not the text at its place", () => {
    const stale = { ok: false, reason: "stale", covered: null };
    expect(index().locate({ start: -1, end: 3, before: "one", after: "uno" })).toEqual(stale);
    expect(index().locate({ start: 3, end: 0, before: "", after: "x" })).toEqual(stale);
    expect(index().locate({ start: 0, end: 3, before: "two", after: "dos" })).toEqual(stale);
    expect(index().locate({ start: 4, end: 7, before: "one", after: "uno" })).toEqual(stale);
  });

  it("places an edit at its units in the text node", () => {
    const placed = index().locate({ start: 4, end: 7, before: "two", after: "dos" });
    expect(placed).toMatchObject({
      ok: true,
      located: { start: 4, end: 7, deleted: "two", inserted: "dos" },
    });
    // Only the changed part is placed: the shared prefix and suffix stay.
    const inner = index().locate({ start: 0, end: 7, before: "one two", after: "one 2wo" });
    expect(inner).toMatchObject({
      ok: true,
      located: { start: 4, end: 5, deleted: "t", inserted: "2" },
    });
  });
});

describe("the text-only comparison of two pages", () => {
  const texts = (document: ReturnType<typeof parsed>) => textNodesOf(document);

  it("accepts exactly the changes it is given and refuses anything else", () => {
    const old = parsed("<!doctype html><p>one two</p><p>three</p>");
    const next = parsed("<!doctype html><p>one dos</p><p>three</p>");
    const node = texts(old).find((text) => text.value === "one two");
    if (!node) throw new Error("no text node");
    const change = { node, start: 4, end: 7, deleted: "two", inserted: "dos" };
    expect(onlyChangedText(old, next, [change])).toBe(true);
    // No change given: the pages differ.
    expect(onlyChangedText(old, next, [])).toBe(false);
    // A change whose deleted text is not what the old page holds there.
    expect(onlyChangedText(old, next, [{ ...change, deleted: "TWO" }])).toBe(false);
    expect(onlyChangedText(old, next, [{ ...change, start: 3, end: 6 }])).toBe(false);
    // A different inserted text.
    expect(onlyChangedText(old, next, [{ ...change, inserted: "tres" }])).toBe(false);
  });

  it("refuses another number of text nodes and another skeleton", () => {
    const old = parsed("<!doctype html><p>one</p>");
    expect(onlyChangedText(old, parsed("<!doctype html><p>one</p>"), [])).toBe(true);
    expect(onlyChangedText(old, parsed("<!doctype html><p>one</p>x"), [])).toBe(false);
    expect(onlyChangedText(old, parsed("<!doctype html><p id=a>one</p>"), [])).toBe(false);
    expect(onlyChangedText(old, parsed("<!doctype html><div>one</div>"), [])).toBe(false);
  });
});

describe("size limits at the edges", () => {
  it("refuses an HTML file over its byte limit before reading its nodes", () => {
    const html = `<!doctype html><p>${"a".repeat(PLAN_LIMITS.htmlBytes)}</p>`;
    expect(subsetRefusal(html, parseHtml("<!doctype html><p>a</p>", newWork()))).toBe("too_large");
    const at = `<!doctype html><p>${"a".repeat(PLAN_LIMITS.htmlBytes - 22)}</p>`;
    expect(new TextEncoder().encode(at).length).toBe(PLAN_LIMITS.htmlBytes);
    expect(subsetRefusal(at, parseHtml(at, newWork()))).toBeNull();
  });

  it("lists a Markdown edit whose result would pass the document limit, and previews nothing", async () => {
    const source = `${"a".repeat(PLAN_LIMITS.documentBytes - 3)} x`;
    expect(new TextEncoder().encode(source).length).toBe(PLAN_LIMITS.documentBytes - 1);
    const built = await plan("markdown", source, [editAt(bodyText(source), "x", "longer")]);
    expect(built.applied).toEqual([]);
    expect(built.listed.map((item) => item.reason)).toEqual(["too_large"]);
    expect(built.newSource).toBeUndefined();
    expect(previewOfPlan(built, RENDERER)).toEqual({
      state: "unavailable",
      reasons: ["too_large"],
    });
    // One byte of room: the same edit to one letter fits.
    const fits = await plan("markdown", source, [editAt(bodyText(source), "x", "y")]);
    expect(fits.applied).toHaveLength(1);
  });
});
