// The edit model and the shapes of decision 0027: what a person may submit, and what released
// clients must keep parsing as later releases add values.
import { describe, expect, it } from "vitest";
import { ANCHOR_SCHEMA_VERSION, type AnnotationTarget } from "./anchors.ts";
import {
  ChangeItemList,
  ChangeItemView,
  ConfirmPlan,
  checkStyle,
  DRAFT_LIMITS,
  DraftEdit,
  EDIT_LIMITS,
  Edit,
  EditText,
  Envelope,
  MarkChangeItem,
  operationTargets,
  Proof,
  REFUSAL_MESSAGES,
  REFUSAL_REASONS,
  STYLE_PROPERTIES,
  SUGGESTIONS_SWITCH,
  Token,
  textOperationsOverlap,
} from "./suggestions.ts";

const HOSTILE: [string, string][] = [
  ["font-size", "0px"],
  ["font-size", "0.001px"],
  ["font-size", "7px"],
  ["font-size", "97px"],
  ["font-size", "1.25rem"],
  ["font-size", "00"],
  ["color", "transparent"],
  ["color", "rgba(0,0,0,0)"],
  ["color", "rgb(10 20 30 / 0.5)"],
  ["color", "#0000"],
  ["color", "#00000000"],
  ["color", "rgb(1 2,3)"],
  ["color", "currentcolor"],
  ["line-height", "0"],
  ["line-height", "1.5"],
  ["padding-left", "4px"],
  ["margin-bottom", "0"],
  ["letter-spacing", "0.05em"],
  ["border-radius", "50%"],
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
  ["color", "#abc"],
  ["color", "rgb(10, 20, 30)"],
  ["color", "rgb(10 20 30)"],
  ["color", "navy"],
  ["background-color", "white"],
  ["font-size", "18px"],
  ["font-size", "8px"],
  ["font-size", "96px"],
  ["font-weight", "700"],
  ["font-style", "italic"],
  ["text-align", "center"],
  ["text-decoration-line", "underline"],
  ["text-transform", "uppercase"],
  ["letter-spacing", "2px"],
  ["letter-spacing", "normal"],
  ["border-radius", "8px"],
];

const elementTarget = (path = "index.html", route?: string): AnnotationTarget => ({
  schema: ANCHOR_SCHEMA_VERSION,
  path,
  ...(route ? { route } : {}),
  anchor: {
    kind: "element",
    selectors: ["main > p:nth-of-type(2)"],
    tagName: "p",
    fingerprint: "Hello",
  },
});

const textTarget = (exact: string, start = 0): AnnotationTarget => ({
  schema: ANCHOR_SCHEMA_VERSION,
  path: "index.html",
  anchor: {
    kind: "text",
    quote: { exact, prefix: "", suffix: "" },
    position: { start, end: start + Array.from(exact).length },
  },
});

const remove = (path = "index.html", route?: string) => ({
  kind: "structure",
  action: "remove",
  target: elementTarget(path, route),
});

describe("the style allowlist", () => {
  it("refuses every hostile value and property", () => {
    for (const [property, value] of HOSTILE) {
      expect(checkStyle(property, value), `${property}: ${value}`).not.toBe(true);
    }
    expect(checkStyle("color", "")).toBe("too_long");
    expect(checkStyle("color", "x".repeat(33))).toBe("too_long");
    expect(checkStyle("position", "fixed")).toBe("unknown_property");
    expect(checkStyle("color", "chartreuse")).toBe("not_allowed");
  });

  it("accepts the values the style panel offers, on ten properties", () => {
    for (const [property, value] of ALLOWED)
      expect(checkStyle(property, value), `${property}: ${value}`).toBe(true);
    expect(Object.keys(STYLE_PROPERTIES)).toHaveLength(10);
  });
});

describe("the edit model", () => {
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
        remove(),
      ],
    });
    expect(parsed.success).toBe(true);
    expect(
      Edit.safeParse({ operations: [{ kind: "text", target: textTarget("Hello"), after: "" }] })
        .success,
    ).toBe(true);
  });

  it("refuses markup, arbitrary inserts, unknown keys, other pages and oversized edits", () => {
    const refused = [
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "Hello" }] },
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "two\nlines" }] },
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "two  spaces" }] },
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "cafe\u0301" }] },
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "x".repeat(1_025) }] },
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "\ud800" }] },
      { operations: [{ kind: "text", target: elementTarget(), after: "x" }] },
      { operations: [{ kind: "text", target: textTarget("Hello"), after: "x", extra: 1 }] },
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
          {
            kind: "style",
            target: elementTarget(),
            changes: [{ property: "color", before: "url(x)", after: "red" }],
          },
        ],
      },
      { operations: [{ kind: "style", target: elementTarget(), changes: [] }] },
      {
        operations: [
          { kind: "structure", action: "insert", target: elementTarget(), html: "<img src=x>" },
        ],
      },
      { operations: [{ ...remove(), html: "<b>" }] },
      { operations: [{ kind: "structure", action: "remove", target: textTarget("Hello") }] },
      { operations: [remove("a.html"), remove("b.html")] },
      { operations: [remove("index.html", "/a"), remove("index.html", "/b")] },
      {
        operations: [
          {
            kind: "structure",
            action: "move",
            target: elementTarget(),
            destination: { target: elementTarget("other.html"), place: "after" },
          },
        ],
      },
      { operations: Array.from({ length: EDIT_LIMITS.operationsMax + 1 }, () => remove()) },
      { operations: [] },
      {
        operations: [
          { kind: "text", target: textTarget("Hello", 0), after: "Hi" },
          { kind: "text", target: textTarget("o w", 4), after: "x" },
        ],
      },
    ];
    for (const edit of refused)
      expect(Edit.safeParse(edit).success, JSON.stringify(edit).slice(0, 120)).toBe(false);
  });

  it("refuses an edit over 32 KiB, and lets a draft hold 100 operations up to 128 KiB", () => {
    const long = (n: number, quote: number, after: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "text",
        target: textTarget("a".repeat(quote), i * 2_000),
        after: "b".repeat(after),
      }));
    expect(Edit.safeParse({ operations: long(20, 1_000, 1_000) }).error?.issues[0]?.message).toBe(
      "Edit is too large",
    );
    expect(Edit.safeParse({ operations: long(20, 100, 1_000) }).success).toBe(true);
    expect(DraftEdit.safeParse({ operations: long(100, 100, 500) }).success).toBe(true);
    expect(DraftEdit.safeParse({ operations: long(101, 10, 10) }).success).toBe(false);
    expect(DraftEdit.safeParse({ operations: long(80, 1_000, 1_000) }).success).toBe(false);
    expect(DRAFT_LIMITS.editMaxBytes).toBe(128 * 1024);
  });

  it("names every target of an operation and finds touching text operations", () => {
    const move = {
      kind: "structure" as const,
      action: "move" as const,
      target: elementTarget("a.html"),
      destination: { target: elementTarget("b.html"), place: "before" as const },
    };
    expect(operationTargets(move).map((target) => target.path)).toEqual(["a.html", "b.html"]);
    const text = (start: number, exact: string) => ({
      kind: "text" as const,
      target: textTarget(exact, start),
      after: "z",
    });
    expect(textOperationsOverlap([text(0, "ab"), text(2, "cd")])).toBe(true);
    expect(textOperationsOverlap([text(0, "ab"), text(3, "cd")])).toBe(false);
    expect(EditText.safeParse("plain words").success).toBe(true);
  });
});

const envelope = {
  format: 1,
  status: "listed",
  reason: "whitespace",
  operation: { kind: "text", before: "a", after: "b" },
  binding: {
    artifactId: "k7d2qm4xab",
    versionId: "ver_1",
    path: "index.md",
    fileSha256: "0".repeat(64),
    renderer: "portifact-render@3",
    subject: "th_1",
    revision: 1,
  },
  provenance: { submittedBy: "Reviewer", acceptedBy: "Owner" },
  location: { unit: "utf16", start: 0, end: 1, line: 1, column: 1 },
  context: { before: "", after: " c", omittedBefore: 0, omittedAfter: 0 },
  destinations: [],
};

const item = {
  id: "ci_1",
  artifactId: "k7d2qm4xab",
  origin: "suggestion",
  threadId: "th_1",
  versionId: "ver_1",
  path: "index.md",
  route: null,
  envelope,
  reason: "whitespace",
  state: "open",
  createdAt: 1,
  closedAt: null,
  closedVersionId: null,
  revision: 1,
};

describe("shapes released clients parse", () => {
  it("parse a change item, and tolerate states, reasons, fields and envelope formats added later", () => {
    expect(ChangeItemView.parse(item)).toEqual(item);
    const later = {
      ...item,
      state: "superseded",
      reason: "new_reason",
      origin: "import",
      added: true,
      envelope: { format: 2, anything: "new" },
    };
    const parsed = ChangeItemView.parse(later);
    expect(parsed.state).toBe("superseded");
    expect(parsed.envelope).toEqual({ format: 2, anything: "new" });
    expect("added" in parsed).toBe(false);
    expect(
      Envelope.parse({ ...envelope, newField: 1, operation: { ...envelope.operation, extra: 2 } }),
    ).toEqual(envelope);
    expect(ChangeItemList.parse({ items: [item], nextCursor: null }).items).toHaveLength(1);
    expect(ChangeItemView.safeParse({ ...item, state: "Open" }).success).toBe(false);
    expect(ChangeItemView.safeParse({ ...item, envelope: { format: 1 } }).success).toBe(false);
  });

  it("validate the envelope's style, structure and unresolved forms", () => {
    expect(
      Envelope.safeParse({
        ...envelope,
        operation: {
          kind: "style",
          element: { tag: "p", label: "x" },
          changes: [{ property: "color", before: null, after: "navy" }],
        },
        location: { unresolved: true },
        context: null,
      }).success,
    ).toBe(true);
    expect(
      Envelope.safeParse({
        ...envelope,
        operation: {
          kind: "structure",
          action: "remove",
          element: { tag: "p", label: "x" },
          destination: null,
        },
      }).success,
    ).toBe(true);
    expect(
      Envelope.safeParse({ ...envelope, binding: { ...envelope.binding, fileSha256: "x" } })
        .success,
    ).toBe(false);
  });

  it("validate marking, confirming, proofs and tokens strictly", () => {
    expect(MarkChangeItem.parse({ state: "applied", baseRevision: 2 })).toEqual({
      state: "applied",
      baseRevision: 2,
    });
    expect(MarkChangeItem.safeParse({ state: "closed_by_version", baseRevision: 2 }).success).toBe(
      false,
    );
    expect(MarkChangeItem.safeParse({ state: "open", baseRevision: 2, extra: 1 }).success).toBe(
      false,
    );
    expect(ConfirmPlan.safeParse({ digest: "a".repeat(64) }).success).toBe(true);
    expect(ConfirmPlan.safeParse({ digest: "A".repeat(64) }).success).toBe(false);
    const proof = {
      unit: "utf16",
      start: 0,
      end: 1,
      before: "a",
      after: "b",
      shownBefore: "a",
      shownAfter: "b",
      nodeLeft: "",
      nodeRight: " c",
      identity: ["p[]"],
    };
    expect(Proof.parse(proof)).toEqual(proof);
    expect(Proof.safeParse({ ...proof, nodeLeft: "x".repeat(33) }).success).toBe(false);
    expect(Token.safeParse("too_large").success).toBe(true);
    expect(Token.safeParse("Too large").success).toBe(false);
  });

  it("names the switch and gives every reason a token and a message", () => {
    expect(SUGGESTIONS_SWITCH).toBe("SUGGESTIONS_ENABLED");
    for (const reason of REFUSAL_REASONS) {
      expect(Token.safeParse(reason).success).toBe(true);
      expect(REFUSAL_MESSAGES[reason]).toMatch(/\.$/);
    }
  });
});
