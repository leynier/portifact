import type { FileKind, Proof } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  DOC_URL,
  edit,
  PAGE_URL,
  pageTextOf,
  planOne,
  RENDERER,
  TITLE,
} from "../testing/suggestions/harness.ts";
import { closure } from "./closure.ts";
import type { TextEdit } from "./edit.ts";
import { carryAll } from "./relocate.ts";
import { renderedPage } from "./rendered.ts";
import { newWork } from "./work.ts";

const urlOf = (kind: FileKind) => (kind === "html" ? PAGE_URL : DOC_URL);

/** The proof the planner keeps for an operation, applied or listed. */
async function proofOf(kind: FileKind, source: string, change: TextEdit): Promise<Proof> {
  const planned = await planOne(kind, source, [change]);
  const proof = planned.applied[0]?.proof ?? planned.listed[0]?.proof;
  if (!proof) throw new Error("not located");
  return proof;
}

const carry = (kind: FileKind, old: string, next: string, change: TextEdit, proof: Proof) =>
  carryAll(kind, old, next, [{ edit: change, proof }], {
    title: TITLE,
    pageUrl: urlOf(kind),
    renderer: RENDERER,
  })[0];

const close = (proof: Proof, kind: FileKind, source: string) =>
  closure(
    proof,
    renderedPage(kind, source, {
      title: TITLE,
      pageUrl: urlOf(kind),
      renderer: RENDERER,
      work: newWork(),
    }),
  );

describe("carrying suggestions by verified relocation", () => {
  const old = "First paragraph.\n\nSecond paragraph here.";

  it("carries a suggestion whose target did not change, with its new coordinates", async () => {
    const change = await edit("markdown", old, "Second", "Next");
    const proof = await proofOf("markdown", old, change);
    const next = "First paragraph, now much longer than before.\n\nSecond paragraph here.";
    const carried = carry("markdown", old, next, change, proof);
    expect(carried?.status).toBe("carried");
    if (carried?.status !== "carried") return;
    const text = Array.from(await pageTextOf("markdown", next));
    expect(text.slice(carried.edit.start, carried.edit.end).join("")).toBe("Second");
    expect(next.slice(carried.proof.start, carried.proof.end)).toBe("Second");
    expect(carry("markdown", old, old, change, proof)).toMatchObject({
      status: "carried",
      edit: change,
    });
  });

  it("outdates changed targets, changed elements or links, and markers in the source", async () => {
    const change = await edit("markdown", old, "Second", "Next");
    const proof = await proofOf("markdown", old, change);
    expect(
      carry("markdown", old, "First paragraph.\n\nThe second paragraph here.", change, proof),
    ).toEqual({
      status: "outdated",
      reason: "changed",
    });
    expect(
      carry("markdown", old, "First paragraph.\n\n> Second paragraph here.", change, proof)?.status,
    ).toBe("outdated");
    expect(carry("markdown", old, `${old}`, change, proof)).toEqual({
      status: "outdated",
      reason: "marker_in_source",
    });
    const linked = "Read [Second][r] now.\n\n[r]: https://a.example";
    const linkEdit = await edit("markdown", linked, "Second", "Next");
    const linkProof = await proofOf("markdown", linked, linkEdit);
    expect(carry("markdown", linked, `${linked}\n\nMore.`, linkEdit, linkProof)?.status).toBe(
      "carried",
    );
    expect(
      carry("markdown", linked, linked.replace("a.example", "b.example"), linkEdit, linkProof),
    ).toEqual({
      status: "outdated",
      reason: "target_changed",
    });
  });

  it("outdates a target the new page no longer shows as text", async () => {
    // The range is unchanged, but a new code fence above turns it into code: the identity changes.
    const source = "Intro.\n\nKeep this sentence.";
    const change = await edit("markdown", source, "this", "that");
    const proof = await proofOf("markdown", source, change);
    const hidden = carry("markdown", source, `Intro.\n\n<!--\nKeep this sentence.`, change, proof);
    expect(hidden?.status).toBe("outdated");
    const fenced = carry("markdown", source, "```\nIntro.\n\nKeep this sentence.", change, proof);
    expect(fenced?.status).toBe("outdated");
  });

  it("carries a text document's suggestion and an HTML page's", async () => {
    const text = "alpha\nbeta gamma";
    const change = { start: 6, end: 10, before: "beta", after: "BETA" };
    const proof = await proofOf("text", text, change);
    expect(carry("text", text, `intro\n${text}`, change, proof)).toMatchObject({
      status: "carried",
      edit: { start: 12, end: 16 },
    });
    const html =
      "<!doctype html><html><head><title>t</title></head><body><p>One</p><p>Two words</p></body></html>";
    const htmlEdit = await edit("html", html, "words", "terms");
    const htmlProof = await proofOf("html", html, htmlEdit);
    const next = html.replace("<p>One</p>", "<p>One, longer</p>");
    expect(carry("html", html, next, htmlEdit, htmlProof)?.status).toBe("carried");
  });

  it("carries a batch together, and outdates beyond the marker budget", async () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i} says hello.`);
    const source = paragraphs.join("\n\n");
    const text = await pageTextOf("markdown", source);
    const items = await Promise.all(
      paragraphs.map(async (_, i) => {
        const before = `number ${i} says`;
        const start = Array.from(text.slice(0, text.indexOf(before))).length;
        const change = {
          start,
          end: start + Array.from(before).length,
          before,
          after: `number ${i} said`,
        };
        return { edit: change, proof: await proofOf("markdown", source, change) };
      }),
    );
    const next = `A new first paragraph.\n\n${source}`;
    const work = newWork();
    const results = carryAll("markdown", source, next, items, {
      title: TITLE,
      pageUrl: DOC_URL,
      renderer: RENDERER,
      work,
    });
    expect(results.every((result) => result.status === "carried")).toBe(true);
    expect(work.renders).toBe(2);
    const tooMany = Array.from({ length: 6_401 }, () => items[0] as (typeof items)[number]);
    expect(
      carryAll("markdown", source, next, tooMany, {
        title: TITLE,
        pageUrl: DOC_URL,
        renderer: RENDERER,
      })[0],
    ).toEqual({
      status: "outdated",
      reason: "marker_in_source",
    });
  });
});

describe("closing change items on the rendered page", () => {
  const source = "The budget grew in March.";

  it("closes a replacement, an insertion and a deletion only on the rendered page", async () => {
    const replaced = await proofOf(
      "markdown",
      source,
      await edit("markdown", source, "grew", "fell"),
    );
    const inserted = await proofOf(
      "markdown",
      source,
      await edit("markdown", source, "budget grew", "budget slowly grew"),
    );
    const deleted = await proofOf(
      "markdown",
      source,
      await edit("markdown", source, "budget grew in", "budget in"),
    );
    expect(close(replaced, "markdown", "Intro.\n\nThe budget fell in March.")).toEqual({
      state: "closed",
      kind: "replacement",
    });
    expect(close(inserted, "markdown", "The budget slowly grew in March.")).toMatchObject({
      kind: "insertion",
    });
    expect(close(deleted, "markdown", "The budget in March.")).toMatchObject({ kind: "deletion" });
  });

  it("keeps items open when the result is hidden, ambiguous, absent, moved or too short to prove", async () => {
    const replaced = await proofOf(
      "markdown",
      source,
      await edit("markdown", source, "grew", "fell"),
    );
    expect(close(replaced, "markdown", "Old.\n\n<!-- The budget fell in March. -->").state).toBe(
      "open",
    );
    expect(
      close(replaced, "markdown", 'Old.\n\n[x]: https://example.com "The budget fell in March."')
        .state,
    ).toBe("open");
    expect(
      close(replaced, "markdown", "The budget fell in March.\n\nThe budget fell in March."),
    ).toEqual({
      state: "open",
      why: "ambiguous",
    });
    expect(close(replaced, "markdown", "The budget grew in March.")).toEqual({
      state: "open",
      why: "not_shown",
    });
    expect(close(replaced, "markdown", "Nothing here.")).toEqual({
      state: "open",
      why: "not_shown",
    });
    expect(close(replaced, "markdown", "> The budget fell in March.")).toEqual({
      state: "open",
      why: "target_changed",
    });
    expect(close({ ...replaced, nodeLeft: "a ", nodeRight: " b" }, "markdown", "a fell b")).toEqual(
      {
        state: "open",
        why: "short_context",
      },
    );
    const html =
      "<!doctype html><html><head><title>t</title></head><body><p>The budget grew in March.</p></body></html>";
    const htmlProof = await proofOf("html", html, await edit("html", html, "grew", "fell"));
    expect(close(htmlProof, "html", html.replace("grew", "fell")).state).toBe("closed");
    expect(
      close(htmlProof, "html", html.replace("budget grew", "<em>budget</em> fell")).state,
    ).toBe("open");
    expect(
      close(htmlProof, "html", "<!doctype html><p>Old text.</p><!-- The budget fell in March. -->")
        .state,
    ).toBe("open");
  });

  it("closes in a text document, whose one node has no meaningful edges", async () => {
    const text = "Line one.\nThe budget grew in March.\nLine three.";
    const proof = await proofOf("text", text, {
      start: 21,
      end: 25,
      before: "grew",
      after: "fell",
    });
    expect(close(proof, "text", text.replace("grew", "fell"))).toMatchObject({ state: "closed" });
  });
});
