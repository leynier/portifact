// Style suggestions (decision 0027, delivery 3): a style operation is never applied to a file; its
// plan lists it for the change list, and its preview sets the change on the built copy of the
// stored page, found by the element anchor's own rules. The same authorization, planning limits
// and code rules as any preview apply.
import { env } from "cloudflare:test";
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
  issue,
  openArtifact,
  person,
  publishFile,
  styleOperation,
  suggestionWithPlan,
  textOperation,
} from "./suggestion-fixtures.ts";
import { DOMAIN, humanCheck, items, publishDoc, runJobs, thread } from "./suggestion-support.ts";

const regions = () => regionsFromEnv(env);
const PAGE =
  '<!doctype html><html><head><title>T</title></head><body><h1 id="top">Title</h1><p style="color:green">Hello there world</p><p>Second</p></body></html>';

async function styleSuggestion(
  operations: Parameters<typeof suggestionWithPlan>[0]["operations"],
  kind: "html" | "markdown" = "html",
  source = PAGE,
) {
  const owner = await person("Owner");
  const sessionId = await session(owner.id);
  const { artifactId, versionId } = await publishFile(owner.id, kind, source);
  await openArtifact(artifactId);
  const { threadId, plan } = await suggestionWithPlan({
    kind,
    source,
    artifactId,
    versionId,
    ownerId: owner.id,
    authorId: owner.id,
    viewerId: owner.id,
    operations,
  });
  return { owner, sessionId, artifactId, versionId, threadId, plan };
}

describe("style suggestions", () => {
  it("lists a style operation for the change list and never writes a new file", async () => {
    const s = await styleSuggestion([
      styleOperation("html", "body > p:nth-of-type(1)", "p", "Hello there world", [
        { property: "color", after: "red" },
      ]),
    ]);
    expect(s.plan.output).toBeNull();
    expect(s.plan.applied).toEqual([]);
    expect(s.plan.listed).toHaveLength(1);
    expect(s.plan.listed[0]).toMatchObject({
      status: "listed",
      reason: "not_text",
      operation: {
        kind: "style",
        element: { tag: "p", label: "Hello there world" },
        changes: [{ property: "color", before: null, after: "red" }],
      },
    });
    expect(s.plan.lines).toContain("style: color from unknown to red");
  });

  it("previews the change on the built copy, with the element's other declarations kept", async () => {
    const s = await styleSuggestion([
      styleOperation("html", "body > p:nth-of-type(1)", "p", "Hello there world", [
        { property: "color", after: "red" },
        { property: "font-weight", after: "bold" },
      ]),
    ]);
    const code = codeOf(await issue(s));
    const document = await redeemPreviewCode(regions(), code, NOW + 1_000);
    expect(document).toContain('<p style="color:red!important;font-weight:bold!important">');
    // The first paragraph's own color is replaced; the second paragraph is untouched.
    expect(document).not.toContain("color:green");
    expect(document).toContain("<p>Second</p>");
  });

  it("previews text and style of one edit together", async () => {
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    const { artifactId, versionId } = await publishFile(owner.id, "html", PAGE);
    await openArtifact(artifactId);
    const { plan } = await suggestionWithPlan({
      kind: "html",
      source: PAGE,
      artifactId,
      versionId,
      ownerId: owner.id,
      authorId: owner.id,
      viewerId: owner.id,
      operations: [
        textOperation("html", PAGE, artifactId, "there", "here"),
        styleOperation("html", "#top", "h1", "Title", [
          { property: "font-style", after: "italic" },
        ]),
      ],
    });
    expect(plan.applied).toHaveLength(1);
    expect(plan.listed).toHaveLength(1);
    const document = await redeemPreviewCode(
      regions(),
      codeOf(await issue({ owner, sessionId, artifactId, plan })),
      NOW,
    );
    expect(document).toContain("Hello here world");
    expect(document).toContain('<h1 id="top" style="font-style:italic!important">Title</h1>');
  });

  it("previews a style on a Markdown document's paragraph", async () => {
    const source = "# Notes\n\nThe quick brown cat jumps.\n";
    const s = await styleSuggestion(
      [
        styleOperation("markdown", "main > p", "p", "The quick brown cat jumps.", [
          { property: "text-align", after: "center" },
        ]),
      ],
      "markdown",
      source,
    );
    const document = await redeemPreviewCode(regions(), codeOf(await issue(s)), NOW);
    expect(document).toContain(
      '<p style="text-align:center!important">The quick brown cat jumps.</p>',
    );
  });

  it("answers unavailable, issuing nothing, when the element is not on the stored page", async () => {
    // The live page's script changed the paragraph: its text is not the stored one.
    const s = await styleSuggestion([
      styleOperation("html", "body > p:nth-of-type(1)", "p", "Drawn by a script", [
        { property: "color", after: "red" },
      ]),
    ]);
    expect(await issue(s)).toEqual({
      ok: true,
      value: { state: "unavailable", reasons: ["element_not_found"] },
    });
    expect(await codeRows(s.artifactId)).toEqual([]);
  });

  it("previews an unsaved style edit, creating nothing but the code", async () => {
    const owner = await person("Owner");
    const sessionId = await session(owner.id);
    const { artifactId, versionId } = await publishFile(owner.id, "html", PAGE);
    await openArtifact(artifactId);
    const edit = {
      operations: [
        styleOperation("html", "#top", "h1", "Title", [{ property: "color", after: "navy" }]),
      ],
    };
    const ask = (as: "suggestion" | "draft") =>
      issuePreviewCode(db(), env.ARTIFACTS, {
        userId: owner.id,
        sessionId,
        artifactId,
        now: NOW,
        unsaved: { versionId, as, edit },
        contentDomain: CONTENT_DOMAIN,
      });
    for (const as of ["suggestion", "draft"] as const) {
      const document = await redeemPreviewCode(regions(), codeOf(await ask(as)), NOW);
      expect(document).toContain('<h1 id="top" style="color:navy!important">Title</h1>');
    }
    // A value outside the grammar never reaches the builder: the edit itself is refused.
    const hostile = {
      operations: [
        styleOperation("html", "#top", "h1", "Title", [
          { property: "color", after: "red;background:url(x)" },
        ]),
      ],
    };
    expect(
      await issuePreviewCode(db(), env.ARTIFACTS, {
        userId: owner.id,
        sessionId,
        artifactId,
        now: NOW,
        unsaved: { versionId, as: "suggestion", edit: hostile },
        contentDomain: CONTENT_DOMAIN,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses a stranger's preview of a style suggestion like a missing one", async () => {
    const s = await styleSuggestion([
      styleOperation("html", "#top", "h1", "Title", [{ property: "color", after: "red" }]),
    ]);
    const stranger = await person("Stranger");
    const strangerSession = await session(stranger.id);
    expect(await issue(s, { userId: stranger.id, sessionId: strangerSession })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("accepting a style suggestion", () => {
  it("publishes nothing and lists the style change, exactly as the owner saw it", async () => {
    const owner = await user("Owner");
    const doc = await publishDoc(owner.id, { type: "site" });
    const input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 100 };
    const operation = styleOperation("html", "#t", "h1", "Title", [
      { property: "text-transform", after: "uppercase" },
    ]);
    const view = value(
      await submitSuggestion(db(), {
        ...input,
        now: NOW,
        versionId: doc.versionId,
        edit: { operations: [operation] },
        body: "Louder",
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
    expect(plan.output).toBeNull();
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
    expect(item).toMatchObject({ state: "open", reason: "not_text", proof: null });
    expect(JSON.parse(item?.envelope ?? "{}")).toMatchObject({
      status: "listed",
      operation: {
        kind: "style",
        element: { tag: "h1", label: "Title" },
        changes: [{ property: "text-transform", before: null, after: "uppercase" }],
      },
    });
  });
});
