import { describe, expect, it } from "vitest";
import {
  ANCHOR_LIMITS,
  AnchorPath,
  AnchorRoute,
  AnnotationTarget,
  codePointLength,
  ElementAnchor,
  isSafeSelector,
  TextAnchor,
  TextPosition,
  TextQuote,
} from "./index.ts";

const textAnchor = (exact = "brown fox", start = 10) => ({
  kind: "text" as const,
  quote: { exact, prefix: "the quick ", suffix: " jumps" },
  position: { start, end: start + codePointLength(exact) },
});

const elementAnchor = {
  kind: "element" as const,
  selectors: ["#pricing", "body > main > section:nth-of-type(2)"],
  tagName: "section",
  fingerprint: "Pricing Free and Pro",
  rect: { x: 0, y: 120.5, width: 800, height: 240 },
};

const target = (anchor: unknown, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  path: "docs/index.html",
  anchor,
  ...extra,
});

const issues = (
  schema: { safeParse(value: unknown): { error?: { issues: { message: string }[] } } },
  value: unknown,
) =>
  schema
    .safeParse(value)
    .error?.issues.map((issue) => issue.message)
    .join("; ") ?? "";

describe("AnnotationTarget", () => {
  it("accepts document, text and element targets with their optional context", () => {
    for (const anchor of [{ kind: "document" }, textAnchor(), elementAnchor]) {
      expect(AnnotationTarget.safeParse(target(anchor)).success).toBe(true);
    }
    const full = target(
      { ...textAnchor(), domHint: "#intro > p", source: { block: 3, start: 120, end: 129 } },
      { route: "/app/settings#billing", contentHash: "a".repeat(64), renderer: "render@1.2.0" },
    );
    expect(AnnotationTarget.parse(full)).toEqual(full);
  });

  it("refuses unknown keys anywhere, so a payload cannot smuggle fields such as an author", () => {
    expect(
      AnnotationTarget.safeParse({ ...target({ kind: "document" }), author_id: "u1" }).success,
    ).toBe(false);
    expect(AnnotationTarget.safeParse(target({ kind: "document", author_id: "u1" })).success).toBe(
      false,
    );
    expect(
      AnnotationTarget.safeParse(
        target({ ...textAnchor(), quote: { ...textAnchor().quote, html: "<b>" } }),
      ).success,
    ).toBe(false);
  });

  it("refuses other schema versions and anchor kinds", () => {
    expect(AnnotationTarget.safeParse({ ...target({ kind: "document" }), schema: 2 }).success).toBe(
      false,
    );
    expect(AnnotationTarget.safeParse(target({ kind: "region" })).success).toBe(false);
  });

  it("refuses a target above the serialized size cap, measured in UTF-8 bytes", () => {
    const emoji = (count: number) => "\u{1F600}".repeat(count);
    const context = emoji(ANCHOR_LIMITS.contextMaxCodePoints);
    const exact = emoji(ANCHOR_LIMITS.quoteMaxCodePoints);
    const domHint = `#${"h".repeat(ANCHOR_LIMITS.selectorMaxLength - 1)}`;
    const anchor = {
      kind: "text",
      quote: { exact, prefix: context, suffix: context },
      position: { start: 0, end: ANCHOR_LIMITS.quoteMaxCodePoints },
      domHint,
      source: { block: 1_000, start: 1_000_000, end: 1_001_024 },
    };
    expect(TextAnchor.safeParse(anchor).success).toBe(true);
    const big = target(anchor, {
      path: `${"a/".repeat(500)}x`,
      route: `/${"r".repeat(ANCHOR_LIMITS.routeMaxLength - 1)}`,
      contentHash: "f".repeat(64),
      renderer: `render@${"9".repeat(ANCHOR_LIMITS.rendererMaxLength - 7)}`,
    });
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(
      ANCHOR_LIMITS.targetMaxBytes,
    );
    expect(issues(AnnotationTarget, big)).toContain("larger than 8192 bytes");
  });

  it.each([
    ["contentHash", "A".repeat(64)],
    ["contentHash", "a".repeat(63)],
    ["renderer", "Render 1"],
    ["renderer", "r".repeat(65)],
  ])("refuses an invalid %s", (key, value) => {
    expect(AnnotationTarget.safeParse(target({ kind: "document" }, { [key]: value })).success).toBe(
      false,
    );
  });
});

describe("TextQuote", () => {
  it("counts code points, not UTF-16 units, against the quote cap", () => {
    const emoji = "\u{1F600}".repeat(ANCHOR_LIMITS.quoteMaxCodePoints);
    expect(emoji.length).toBe(2 * ANCHOR_LIMITS.quoteMaxCodePoints);
    expect(TextQuote.safeParse({ exact: emoji, prefix: "", suffix: "" }).success).toBe(true);
    expect(TextQuote.safeParse({ exact: `${emoji}x`, prefix: "", suffix: "" }).success).toBe(false);
    expect(TextQuote.safeParse({ exact: "x".repeat(4096), prefix: "", suffix: "" }).success).toBe(
      false,
    );
  });

  it("caps the prefix and suffix at the context length", () => {
    const context = "c".repeat(ANCHOR_LIMITS.contextMaxCodePoints);
    expect(TextQuote.safeParse({ exact: "a", prefix: context, suffix: context }).success).toBe(
      true,
    );
    expect(TextQuote.safeParse({ exact: "a", prefix: `${context}c`, suffix: "" }).success).toBe(
      false,
    );
    expect(TextQuote.safeParse({ exact: "a", prefix: "", suffix: `${context}c` }).success).toBe(
      false,
    );
  });

  it.each([
    ["an empty quote", ""],
    ["a leading space", " fox"],
    ["a trailing space", "fox "],
    ["a double space", "brown  fox"],
    ["a newline", "brown\nfox"],
    ["a tab", "brown\tfox"],
    ["a NUL", "brown\u0000fox"],
    ["a no-break space", "brown\u00a0fox"],
    ["a lone surrogate", "fox\ud800"],
  ])("refuses a quote with %s", (_label, exact) => {
    expect(TextQuote.safeParse({ exact, prefix: "", suffix: "" }).success).toBe(false);
  });

  it("refuses context that is not normalized", () => {
    expect(TextQuote.safeParse({ exact: "a", prefix: "x\n", suffix: "" }).success).toBe(false);
    expect(TextQuote.safeParse({ exact: "a", prefix: "", suffix: "\ud800" }).success).toBe(false);
  });

  it("keeps markup in a quote as plain data", () => {
    const exact = "<script>alert(1)</script>";
    expect(TextQuote.parse({ exact, prefix: "", suffix: "" }).exact).toBe(exact);
  });
});

describe("TextAnchor positions", () => {
  it("requires the position length to equal the quote length in code points", () => {
    expect(TextAnchor.safeParse(textAnchor("\u{1F600} ok", 0)).success).toBe(true);
    const wrong = { ...textAnchor("\u{1F600} ok", 0), position: { start: 0, end: 5 } };
    expect(issues(TextAnchor, wrong)).toContain("Position length must equal the quote length");
  });

  it.each([
    [{ start: 5, end: 5 }],
    [{ start: 6, end: 5 }],
    [{ start: -1, end: 5 }],
    [{ start: 0.5, end: 5 }],
    [{ start: 0, end: ANCHOR_LIMITS.positionMax + 1 }],
  ])("refuses position %j", (position) => {
    expect(TextPosition.safeParse(position).success).toBe(false);
  });

  it("validates the source position the same way", () => {
    const anchor = (source: unknown) => ({ ...textAnchor(), source });
    expect(TextAnchor.safeParse(anchor({ start: 0, end: 9 })).success).toBe(true);
    expect(TextAnchor.safeParse(anchor({ block: -1, start: 0, end: 9 })).success).toBe(false);
    expect(issues(TextAnchor, anchor({ block: 1, start: 9, end: 9 }))).toContain(
      "Source end must follow",
    );
  });
});

describe("isSafeSelector", () => {
  it.each([
    "#pricing",
    "section",
    "body > main > p:nth-of-type(2)",
    "#app > div:nth-of-type(3) li",
    'button[data-testid="save draft"]',
    "nav.primary-menu > a.active",
    "my-element > span",
  ])("accepts %j", (selector) => {
    expect(isSafeSelector(selector)).toBe(true);
  });

  it.each([
    ["an empty selector", ""],
    ["a closing style tag", "</style><script>alert(1)</script>"],
    ["a CSS block", "a{background:url(https://evil.example)}"],
    ["a url function", "a:url(x)"],
    ["an at-rule", "@import 'x'"],
    ["an escape", "#a\\31"],
    ["a semicolon", "a;b"],
    ["an unlisted attribute", 'a[onclick="x"]'],
    ["an unquoted attribute value", "a[name=x]"],
    ["markup in an attribute value", 'a[name="<img src=x>"]'],
    ["a backslash in an attribute value", 'a[name="\\"]'],
    ["a newline in an attribute value", 'a[name="a\nb"]'],
    ["a pseudo-class outside the grammar", "a:hover"],
    ["nth-of-type zero", "p:nth-of-type(0)"],
    ["a comma list", "a, b"],
    ["a sibling combinator", "a + b"],
    ["a leading combinator", "> a"],
    ["an uppercase tag", "DIV"],
    ["a universal selector", "*"],
  ])("refuses %s", (_label, selector) => {
    expect(isSafeSelector(selector)).toBe(false);
  });

  it("caps the length and the number of compound selectors", () => {
    const deep = (count: number) => Array.from({ length: count }, () => "div").join(" > ");
    expect(isSafeSelector(deep(ANCHOR_LIMITS.selectorMaxCompounds))).toBe(true);
    expect(isSafeSelector(deep(ANCHOR_LIMITS.selectorMaxCompounds + 1))).toBe(false);
    expect(isSafeSelector(`#${"a".repeat(ANCHOR_LIMITS.selectorMaxLength - 1)}`)).toBe(true);
    expect(isSafeSelector(`#${"a".repeat(ANCHOR_LIMITS.selectorMaxLength)}`)).toBe(false);
  });

  it("does not count spaces inside attribute values as compounds", () => {
    const value = "a ".repeat(60).trim();
    expect(isSafeSelector(`div[data-testid="${value}"]`)).toBe(true);
  });
});

describe("ElementAnchor", () => {
  it("accepts up to four selectors and refuses none or more", () => {
    expect(ElementAnchor.safeParse({ ...elementAnchor, selectors: [] }).success).toBe(false);
    const five = ["#a", "#b", "#c", "#d", "#e"];
    expect(ElementAnchor.safeParse({ ...elementAnchor, selectors: five.slice(0, 4) }).success).toBe(
      true,
    );
    expect(ElementAnchor.safeParse({ ...elementAnchor, selectors: five }).success).toBe(false);
    expect(ElementAnchor.safeParse({ ...elementAnchor, selectors: ["</style>"] }).success).toBe(
      false,
    );
  });

  it.each(["DIV", "x:y", "1h", "a".repeat(33), "<script>"])("refuses tag name %j", (tagName) => {
    expect(ElementAnchor.safeParse({ ...elementAnchor, tagName }).success).toBe(false);
  });

  it("allows an empty fingerprint and caps it at the fingerprint length", () => {
    expect(ElementAnchor.safeParse({ ...elementAnchor, fingerprint: "" }).success).toBe(true);
    const long = "f".repeat(ANCHOR_LIMITS.fingerprintMaxCodePoints + 1);
    expect(ElementAnchor.safeParse({ ...elementAnchor, fingerprint: long }).success).toBe(false);
  });

  it.each([
    { x: Number.NaN, y: 0, width: 1, height: 1 },
    { x: Number.POSITIVE_INFINITY, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: -1, height: 1 },
    { x: 0, y: ANCHOR_LIMITS.rectMaxCoordinate + 1, width: 1, height: 1 },
    { x: 0, y: 0, width: 1 },
  ])("refuses rect %j", (rect) => {
    expect(ElementAnchor.safeParse({ ...elementAnchor, rect }).success).toBe(false);
  });
});

describe("AnchorPath and AnchorRoute", () => {
  it.each(["index.html", "docs/guide/intro.md", "caf\u00e9/\u{1F600}.html"])(
    "accepts path %j",
    (path) => {
      expect(AnchorPath.safeParse(path).success).toBe(true);
    },
  );

  it.each([
    "",
    "/etc/passwd",
    "../x",
    "docs/../x",
    "a//b",
    "./a",
    "a\\b",
    "a\nb",
    "a\ud800",
    "a".repeat(1025),
  ])("refuses path %j", (path) => {
    expect(AnchorPath.safeParse(path).success).toBe(false);
  });

  it.each(["/", "/app/settings", "/app#/billing?tab=2", "/caf%C3%A9"])(
    "accepts route %j",
    (route) => {
      expect(AnchorRoute.safeParse(route).success).toBe(true);
    },
  );

  it.each([
    "javascript:alert(1)",
    "https://evil.example/",
    "//evil.example/x",
    "/\\evil.example",
    "app",
    "/a b",
    "/a\u0000",
    "/a\ud800",
    `/${"a".repeat(ANCHOR_LIMITS.routeMaxLength)}`,
  ])("refuses route %j", (route) => {
    expect(AnchorRoute.safeParse(route).success).toBe(false);
  });
});
