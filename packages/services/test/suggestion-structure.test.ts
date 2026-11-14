// Structure suggestions (decision 0027, delivery 4): moving, duplicating or removing an element is
// never applied to a file; its plan lists it for the change list, and its preview makes it on the
// built copy of the stored page, with every element found by the element anchor's own rules.
import { env } from "cloudflare:test";
import type { EditOperation } from "@portifact/contracts";
import { regionsFromEnv } from "@portifact/db";
import { describe, expect, it } from "vitest";
import { acceptSuggestion } from "../src/suggestion-accept.ts";
import { planSuggestion } from "../src/suggestion-plans.ts";
import { issuePreviewCode, redeemPreviewCode } from "../src/suggestion-previews.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { db, NOW, session, user, value } from "./fixtures.ts";
import {
  CONTENT_DOMAIN,
  codeOf,
  codeRows,
  elementTarget,
  issue,
  openArtifact,
  person,
  publishFile,
  suggestionWithPlan,
} from "./suggestion-fixtures.ts";
import { DOMAIN, humanCheck, items, publishDoc, runJobs, thread } from "./suggestion-support.ts";

const regions = () => regionsFromEnv(env);
const PAGE =
  '<!doctype html><html><head><title>T</title></head><body><h1 id="top">Title</h1><p id="a">Alpha</p><p id="b">Beta</p></body></html>';
const TOP = elementTarget("html", "#top", "h1", "Title");
const ALPHA = elementTarget("html", "#a", "p", "Alpha");
const BETA = elementTarget("html", "#b", "p", "Beta");

async function structureSuggestion(operations: EditOperation[]) {
  const owner = await person("Owner");
  const sessionId = await session(owner.id);
  const { artifactId, versionId } = await publishFile(owner.id, "html", PAGE);
  await openArtifact(artifactId);
  const { threadId, plan } = await suggestionWithPlan({
    kind: "html",
    source: PAGE,
    artifactId,
    versionId,
    ownerId: owner.id,
    authorId: owner.id,
    viewerId: owner.id,
    operations,
  });
  return { owner, sessionId, artifactId, versionId, threadId, plan };
}

describe("structure suggestions", () => {
  it("lists a move with its destination for the change list and writes no file", async () => {
    const s = await structureSuggestion([
      {
        kind: "structure",
        action: "move",
        target: BETA,
        destination: { target: TOP, place: "before" },
      },
    ]);
    expect(s.plan.output).toBeNull();
    expect(s.plan.listed[0]).toMatchObject({
      reason: "not_text",
      operation: {
        kind: "structure",
        action: "move",
        element: { tag: "p", label: "Beta" },
        destination: { element: { tag: "h1", label: "Title" }, place: "before" },
      },
    });
    expect(s.plan.lines).toContain('move: before h1 "Title"');
  });

  it("previews a move, a copy and a removal on the built copy", async () => {
    const s = await structureSuggestion([
      {
        kind: "structure",
        action: "move",
        target: BETA,
        destination: { target: TOP, place: "before" },
      },
      { kind: "structure", action: "duplicate", target: ALPHA },
    ]);
    const document = await redeemPreviewCode(regions(), codeOf(await issue(s)), NOW);
    expect(document).toContain(
      '<p id="b">Beta</p><h1 id="top">Title</h1><p id="a">Alpha</p><p id="a">Alpha</p>',
    );
    const removed = await structureSuggestion([
      { kind: "structure", action: "remove", target: TOP },
    ]);
    const after = await redeemPreviewCode(regions(), codeOf(await issue(removed)), NOW);
    expect(after).not.toContain("Title</h1>");
    expect(after).toContain('<p id="a">Alpha</p><p id="b">Beta</p>');
  });

  it("answers unavailable, issuing nothing, for a move into the element or a missing element", async () => {
    const into = await structureSuggestion([
      {
        kind: "structure",
        action: "move",
        target: ALPHA,
        destination: { target: ALPHA, place: "after" },
      },
    ]);
    expect(await issue(into)).toEqual({
      ok: true,
      value: { state: "unavailable", reasons: ["structure_conflict"] },
    });
    expect(await codeRows(into.artifactId)).toEqual([]);
    const gone = await structureSuggestion([
      {
        kind: "structure",
        action: "remove",
        target: elementTarget("html", "#late", "aside", "Drawn by a script"),
      },
    ]);
    expect(await issue(gone)).toEqual({
      ok: true,
      value: { state: "unavailable", reasons: ["element_not_found"] },
    });
  });

  it("previews an unsaved structure edit and refuses a destination on another page", async () => {
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    const { artifactId, versionId } = await publishFile(owner.id, "html", PAGE);
    await openArtifact(artifactId);
    const ask = (edit: unknown) =>
      issuePreviewCode(db(), env.ARTIFACTS, {
        userId: owner.id,
        sessionId,
        artifactId,
        now: NOW,
        unsaved: { versionId, as: "suggestion", edit },
        contentDomain: CONTENT_DOMAIN,
      });
    const document = await redeemPreviewCode(
      regions(),
      codeOf(await ask({ operations: [{ kind: "structure", action: "remove", target: BETA }] })),
      NOW,
    );
    expect(document).not.toContain("Beta");
    const elsewhere = { ...TOP, path: "other.html" };
    expect(
      await ask({
        operations: [
          {
            kind: "structure",
            action: "move",
            target: ALPHA,
            destination: { target: elsewhere, place: "after" },
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("structure previews are bounded (review of pull request #288)", () => {
  it("refuses duplicates that would copy earlier copies, issuing nothing", async () => {
    // 16 nested sections duplicated from the innermost outward: a 339-byte page would become
    // 131,070 elements and 2.69 MB without the copy budget.
    const page = `<!doctype html><html><head><title>T</title></head><body>${Array.from(
      { length: 16 },
      (_, i) => `<section id="s${i + 1}">`,
    ).join("")}x${"</section>".repeat(16)}</body></html>`;
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    const { artifactId, versionId } = await publishFile(owner.id, "html", page);
    await openArtifact(artifactId);
    const operations: EditOperation[] = Array.from({ length: 16 }, (_, i) => ({
      kind: "structure",
      action: "duplicate",
      target: elementTarget("html", `#s${16 - i}`, "section", "x"),
    }));
    const { plan } = await suggestionWithPlan({
      kind: "html",
      source: page,
      artifactId,
      versionId,
      ownerId: owner.id,
      authorId: owner.id,
      viewerId: owner.id,
      operations,
    });
    expect(await issue({ owner, sessionId, artifactId, plan })).toEqual({
      ok: true,
      value: { state: "unavailable", reasons: ["preview_too_large"] },
    });
    expect(await codeRows(artifactId)).toEqual([]);
  });

  it("refuses a move next to an element inside a removed section", async () => {
    const page =
      '<!doctype html><html><head><title>T</title></head><body><section id="box"><p id="a">Alpha</p></section><p id="b">Beta</p></body></html>';
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    const { artifactId, versionId } = await publishFile(owner.id, "html", page);
    await openArtifact(artifactId);
    const { plan } = await suggestionWithPlan({
      kind: "html",
      source: page,
      artifactId,
      versionId,
      ownerId: owner.id,
      authorId: owner.id,
      viewerId: owner.id,
      operations: [
        {
          kind: "structure",
          action: "remove",
          target: elementTarget("html", "#box", "section", "Alpha"),
        },
        {
          kind: "structure",
          action: "move",
          target: elementTarget("html", "#b", "p", "Beta"),
          destination: { target: elementTarget("html", "#a", "p", "Alpha"), place: "after" },
        },
      ],
    });
    expect(await issue({ owner, sessionId, artifactId, plan })).toEqual({
      ok: true,
      value: { state: "unavailable", reasons: ["structure_conflict"] },
    });
  });
});

describe("accepting a structure suggestion", () => {
  it("publishes nothing and lists the move exactly as the owner saw it", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id, { type: "site" });
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 100 };
    const move: EditOperation = {
      kind: "structure",
      action: "move",
      target: elementTarget("html", "#t", "h1", "Title"),
      destination: {
        target: elementTarget("html", "body > p:nth-of-type(2)", "p", "A linked word."),
        place: "after",
      },
    };
    const view = value(
      await submitSuggestion(db(), {
        ...input,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [move] },
        body: "Title last",
        humanCheck,
      }),
    );
    const plan = value(
      await planSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId: view.id,
        contentDomain: DOMAIN,
      }),
    );
    value(
      await acceptSuggestion(db(), env.ARTIFACTS, {
        ...input,
        threadId: view.id,
        digest: plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    expect(await runJobs("suggestion_accept", doc.artifactId)).toEqual(["done"]);
    expect(await thread(view.id)).toMatchObject({
      suggestionState: "accepted",
      resultVersionId: null,
    });
    const [item] = await items(doc.artifactId);
    expect(JSON.parse(item?.envelope ?? "{}")).toMatchObject({
      operation: {
        kind: "structure",
        action: "move",
        element: { tag: "h1", label: "Title" },
        destination: { element: { tag: "p", label: "A linked word." }, place: "after" },
      },
    });
  });
});
