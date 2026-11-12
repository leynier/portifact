import { bridgeEnvelope } from "@portifact/bridge";
import { ANCHOR_SCHEMA_VERSION, type AnnotationTarget } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { closure } from "../src/closure.ts";
import { EditSession } from "../src/edit-session.ts";
import { planMarkdown, RENDER_BUDGET, renderPage } from "../src/markdown-resolver.ts";
import { codePoints } from "../src/page.ts";
import {
  admitItems,
  buildPlan,
  confirmPlan,
  inertPreview,
  PREVIEW_POLICY,
  visible,
} from "../src/plan.ts";
import { carry } from "../src/relocate.ts";

const BINDING = {
  artifactId: "k7d2qm4xab",
  versionId: "ver_1",
  path: "index.md",
  renderer: "portifact-render@3",
  suggestionId: "th_1",
  suggestionRevision: 1,
};
const PEOPLE = { submittedBy: "u_reviewer", acceptedBy: "u_owner" };

/** An edit at the `occurrence`-th place `before` appears in the rendered page text. */
function at(source: string, before: string, after: string, occurrence = 0) {
  const text = renderPage(source).text;
  let index = -1;
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(before, index + 1);
  const start = codePoints(text.slice(0, index)).length;
  return { start, end: start + codePoints(before).length, before, after };
}

describe("the patch plan (rules 3 and 10)", () => {
  const source = "Read [the terms](https://example.com/terms) first.\n\nThen sign here.";

  it("shows the source line, the link's destination and invisible characters", () => {
    const plan = buildPlan({
      binding: BINDING,
      provenance: PEOPLE,
      kind: "markdown",
      source,
      edits: [at(source, "terms", "te‮rmsrules​")],
    });
    expect(plan.applied).toHaveLength(1);
    expect(plan.lines).toEqual([
      "line 1: Read [the terms](https://example.com/terms) first.",
      "- terms",
      "+ te⟦U+202E⟧rmsrules⟦U+200B⟧",
      "link to https://example.com/terms",
    ]);
    expect(visible("a⁦b­c﻿")).toBe("a⟦U+2066⟧b⟦U+00AD⟧c⟦U+FEFF⟧");
  });

  it("is confirmed only by its digest and only while its binding is current", () => {
    const plan = buildPlan({
      binding: BINDING,
      provenance: PEOPLE,
      kind: "markdown",
      source,
      edits: [at(source, "sign", "initial")],
    });
    expect(confirmPlan(plan, plan.digest, plan.binding)).toBe(true);
    expect(confirmPlan(plan, "0".repeat(64), plan.binding)).toBe(false);
    // Finding 10: a dry run on version 1, then a publish: the confirmation fails, it is not re-read.
    expect(confirmPlan(plan, plan.digest, { ...plan.binding, versionId: "ver_2" })).toBe(false);
    expect(confirmPlan(plan, plan.digest, { ...plan.binding, suggestionRevision: 2 })).toBe(false);
    // Finding 3: the same text in another file, or the same file with other bytes, is another plan.
    expect(confirmPlan(plan, plan.digest, { ...plan.binding, path: "other.md" })).toBe(false);
    const other = buildPlan({
      binding: BINDING,
      provenance: PEOPLE,
      kind: "markdown",
      source: `${source}\n`,
      edits: [at(source, "sign", "initial")],
    });
    expect(other.binding.fileSha256).not.toBe(plan.binding.fileSha256);
    expect(confirmPlan(plan, plan.digest, other.binding)).toBe(false);
  });

  it("hands the agent only what the plan showed, with server-derived coordinates and provenance", () => {
    const html = "<!doctype html><p>Pay now</p><script>1</script>";
    const plan = buildPlan({
      binding: { ...BINDING, path: "index.html" },
      provenance: PEOPLE,
      kind: "html",
      source: html,
      edits: [{ start: 0, end: 7, before: "Pay now", after: "Pay later" }],
    });
    expect(plan.applied).toEqual([]);
    const [item] = plan.listed;
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "binding",
      "location",
      "operation",
      "provenance",
      "reason",
    ]);
    expect(item).toMatchObject({
      operation: { kind: "text", before: "Pay now", after: "Pay later" },
      provenance: PEOPLE,
      location: { line: 1, context: html },
      reason: "not_inert",
    });
    expect(plan.lines).toContain("for the change list (not_inert): - Pay now + Pay later");
    const ambiguous = buildPlan({
      binding: BINDING,
      provenance: PEOPLE,
      kind: "text",
      source: "tick\ntick",
      edits: [{ start: 0, end: 9, before: "tick tick", after: "tock" }],
    });
    expect(ambiguous.listed[0]?.location).toEqual({ unresolved: true });
  });

  it("plans a text document and an inert HTML page the same way", () => {
    const text = buildPlan({
      binding: BINDING,
      provenance: PEOPLE,
      kind: "text",
      source: "alpha beta",
      edits: [{ start: 0, end: 5, before: "alpha", after: "gamma" }],
    });
    expect(text.newSource).toBe("gamma beta");
    const html = buildPlan({
      binding: BINDING,
      provenance: PEOPLE,
      kind: "html",
      source: '<!doctype html><p><a href="https://example.com">Docs</a></p>',
      edits: [{ start: 0, end: 4, before: "Docs", after: "Guide" }],
    });
    expect(html.lines).toContain("link to https://example.com");
  });

  it("adds every listed item or none (rule 9)", () => {
    expect(admitItems(999, 1, 1_000)).toBe(true);
    expect(admitItems(999, 20, 1_000)).toBe(false);
  });
});

describe("multi-operation plans (rule 9, finding 14)", () => {
  const source = "One cat sat.\n\nTwo dogs ran.\n\nThree birds flew.";

  it("applies operations in base coordinates as one patch with one verification", () => {
    const planned = planMarkdown(source, [
      at(source, "birds", "owls"),
      at(source, "cat", "lion"),
      at(source, "dogs", "foxes"),
    ]);
    expect(planned.listed).toEqual([]);
    expect(planned.source).toBe("One lion sat.\n\nTwo foxes ran.\n\nThree owls flew.");
    expect(planned.renders).toBe(2);
  });

  it("refuses overlapping operations instead of ordering them", () => {
    const planned = planMarkdown(source, [at(source, "cat sat", "x"), at(source, "sat", "y")]);
    expect(planned.applied).toEqual([]);
    expect(planned.listed.map((item) => item.reason)).toEqual(["overlap", "overlap"]);
  });

  it("applies nothing when the combined result fails, so the confirmed split never changes", () => {
    const planned = planMarkdown("# Title\n\nBody text.", [
      at("# Title\n\nBody text.", "Body", "Main"),
      at("# Title\n\nBody text.", "Title", "Name"),
    ]);
    expect(planned.applied).toEqual([]);
    expect(planned.listed.map((item) => item.reason)).toEqual([
      "would_change_page",
      "would_change_page",
    ]);
    expect(planned.renders).toBeLessThanOrEqual(RENDER_BUDGET);
  });
});

describe("inert previews (rules 1 and 4)", () => {
  it("previews documents with the renderer's output, running nothing", () => {
    const html = inertPreview("markdown", "# Hi\n\n```mermaid\nA-->B\n```");
    expect(html).not.toContain("<script");
    expect(html).toContain("default-src 'none'");
  });

  it("previews an inert HTML page with a policy first in its head", () => {
    const html = inertPreview(
      "html",
      '<!doctype html><html><head><title>x</title></head><body><img src="/a.png"></body></html>',
    );
    expect(html.indexOf(PREVIEW_POLICY)).toBeGreaterThan(0);
    expect(html.indexOf(PREVIEW_POLICY)).toBeLessThan(html.indexOf("<title>"));
    expect(inertPreview("html", "<p>x</p>")).toContain(PREVIEW_POLICY);
    expect(inertPreview("text", "<b>x</b>")).toContain("&lt;b&gt;");
  });
});

describe("carrying a suggestion (rule 11, finding 12)", () => {
  const old = "First paragraph.\n\nSecond paragraph here.";
  const edit = at(old, "Second", "Next");
  const range = { start: old.indexOf("Second"), end: old.indexOf("Second") + 6 };

  it("carries a suggestion whose text did not change, where exact anchoring said fuzzy", () => {
    const next = "First paragraph, now much longer than before.\n\nSecond paragraph here.";
    const carried = carry("markdown", old, next, edit, range);
    expect(carried).toMatchObject({
      status: "carried",
      sourceRange: { start: next.indexOf("Second"), end: next.indexOf("Second") + 6 },
    });
    if (carried.status !== "carried") return;
    expect(
      codePoints(renderPage(next).text).slice(carried.edit.start, carried.edit.end).join(""),
    ).toBe("Second");
  });

  it("carries unchanged files as they are and outdates changed targets", () => {
    expect(carry("markdown", old, old, edit, range)).toMatchObject({ status: "carried", edit });
    expect(
      carry("markdown", old, "First paragraph.\n\nSecond line here.", edit, range),
    ).toMatchObject({ status: "carried" });
    expect(
      carry("markdown", old, "First paragraph.\n\nThe second paragraph here.", edit, range),
    ).toEqual({
      status: "outdated",
      reason: "changed",
    });
    expect(carry("markdown", old, `${old}`, edit, range)).toEqual({
      status: "outdated",
      reason: "marker_in_source",
    });
    const linked = "[Second](https://x.example/Second)\n\ntail";
    const linkRange = { start: linked.indexOf("Second", 2), end: linked.indexOf("Second", 2) + 6 };
    expect(
      carry("markdown", linked, `${linked} more`, at(linked, "Second", "Next"), linkRange),
    ).toEqual({
      status: "outdated",
      reason: "not_on_page",
    });
  });

  it("carries in text documents through the same verified relocation", () => {
    const text = "alpha\nbeta gamma";
    const moved = carry(
      "text",
      text,
      `intro\n${text}`,
      { start: 6, end: 10, before: "beta", after: "BETA" },
      { start: 6, end: 10 },
    );
    expect(moved).toMatchObject({ status: "carried", edit: { start: 12, end: 16 } });
  });
});

describe("closing change-list items (rule 11, finding 13)", () => {
  const left = "The budget ";
  const right = " in March.";

  it("closes a replacement, an insertion and a deletion only with a proof", () => {
    expect(
      closure({ left, right, deleted: "grew", inserted: "shrank" }, `x ${left}shrank${right}`),
    ).toEqual({
      state: "closed",
      kind: "replacement",
    });
    expect(
      closure(
        { left: "The budget", right: " in March.", deleted: "", inserted: " fell" },
        "The budget fell in March.",
      ),
    ).toEqual({
      state: "closed",
      kind: "insertion",
    });
    expect(closure({ left, right, deleted: "grew", inserted: "" }, `${left}${right}`)).toEqual({
      state: "closed",
      kind: "deletion",
    });
  });

  it("keeps ambiguous, unshown and short-context items open", () => {
    expect(closure({ left, right, deleted: "grew", inserted: "" }, `${left}grew${right}`)).toEqual({
      state: "open",
      why: "not_shown",
    });
    expect(
      closure(
        { left, right, deleted: "grew", inserted: "fell" },
        `${left}fell${right} ${left}fell${right}`,
      ),
    ).toEqual({
      state: "open",
      why: "ambiguous",
    });
    expect(closure({ left: "a ", right: " b", deleted: "x", inserted: "y" }, "a y b")).toEqual({
      state: "open",
      why: "short_context",
    });
    expect(
      closure(
        { left, right, deleted: "grew", inserted: "\\*", spellings: ["\\\\\\*"] },
        `${left}\\\\\\*${right}`,
      ),
    ).toEqual({
      state: "closed",
      kind: "replacement",
    });
  });
});

describe("a move's destination is its own pick (rule 2)", () => {
  const NONCE = "abcdefghijklmnopqrstuv";
  const origin = "https://k7d2qm4xab.portifact.dev";
  const frame = { name: "frame" };
  const element = (fingerprint: string): AnnotationTarget => ({
    schema: ANCHOR_SCHEMA_VERSION,
    path: "index.html",
    anchor: { kind: "element", selectors: ["#x"], tagName: "p", fingerprint },
  });
  const pick = (fingerprint: string) =>
    bridgeEnvelope(NONCE, { type: "element", target: element(fingerprint) });

  it("takes a destination only while picking it, and never from the frame on its own", () => {
    const saved: unknown[] = [];
    const session = new EditSession({ origin, source: frame, nonce: NONCE }, (edit) =>
      saved.push(edit),
    );
    session.start("move");
    session.receive({ data: pick("Moved"), origin, source: frame });
    expect(session.mode).toBe("editing");
    // The page offers a destination unasked: dropped.
    session.receive({ data: pick("Forged destination"), origin, source: frame });
    expect(session.review()).toBeNull();
    session.start("move");
    session.receive({ data: pick("Moved"), origin, source: frame });
    session.pickDestination("after");
    expect(session.mode).toBe("picking-destination");
    session.receive({ data: pick("Destination"), origin, source: frame });
    session.receive({ data: pick("Late forgery"), origin, source: frame });
    const shown = session.review();
    expect(shown?.lines).toEqual(["move after the chosen element"]);
    expect(shown?.operations[0]).toMatchObject({
      destination: { place: "after", target: { anchor: { fingerprint: "Destination" } } },
    });
    expect(session.confirm(shown as NonNullable<typeof shown>)).toBe(true);
    expect(session.framePosts.every((post) => post.type === "pick")).toBe(true);
  });

  it("moves the editor only with the viewer's own viewport events", () => {
    const session = new EditSession({ origin, source: frame, nonce: NONCE }, () => {});
    session.viewportChanged({ x: 1, y: 1, width: 1, height: 1 });
    expect(session.placement).toBeNull();
    session.start("style");
    session.receive({
      data: bridgeEnvelope(NONCE, {
        type: "element",
        target: element("x"),
        rect: { x: 5, y: 5, width: 5, height: 5 },
      }),
      origin,
      source: frame,
    });
    session.viewportChanged({ x: 9, y: 9, width: 5, height: 5 });
    expect(session.placement).toEqual({ x: 9, y: 9, width: 5, height: 5 });
  });
});
