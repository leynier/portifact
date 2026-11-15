// The text of a page for "Suggest a text change" (decision 0027, "Suggesting"): what the served
// page shows, as the anchors read it, for whoever may suggest; nothing of the file beyond it.
import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { placeLegalHold } from "../src/legal-holds.ts";
import { suspendArtifact } from "../src/moderation.ts";
import { suggestionPageText } from "../src/page-text.ts";
import { db, NOW, value } from "./fixtures.ts";
import { person } from "./suggestion-fixtures.ts";
import { DOC, DOMAIN, publishDoc, textOp } from "./suggestion-support.ts";

const HIDDEN_PAGE =
  '<!doctype html><html><head><title>Page title</title><style>p{color:red}</style></head><body><h1>Title</h1><!-- a private note --><p title="an attribute">Second paragraph here.</p><p hidden>Hidden words</p><script>var secret = 1;</script><p>A <a href="/x">linked</a> word.</p></body></html>';

async function setup(options: { type?: "markdown" | "site"; body?: string } = {}) {
  const owner = await person("Owner");
  const reader = await person("Reader");
  const doc = await publishDoc(owner.id, options);
  await db()
    .insert(schema.artifactReaders)
    .values({ artifactId: doc.artifactId, email: reader.email });
  const ask = (userId: string, path = doc.path, now = NOW + 10) =>
    suggestionPageText(db(), env.ARTIFACTS, {
      userId,
      artifactId: doc.artifactId,
      now,
      path,
      contentDomain: DOMAIN,
    });
  return { owner, reader, doc, ask };
}

/** The R2 key of a stored file of the version, by its kind. */
async function keyOf(versionId: string, kind: "published" | "rendered") {
  const [row] = await db()
    .select({ key: schema.objects.r2Key })
    .from(schema.versionFiles)
    .innerJoin(
      schema.objects,
      and(
        eq(schema.objects.ownerId, schema.versionFiles.ownerId),
        eq(schema.objects.sha256, schema.versionFiles.sha256),
      ),
    )
    .where(and(eq(schema.versionFiles.versionId, versionId), eq(schema.versionFiles.kind, kind)));
  if (!row) throw new Error(`no ${kind} file`);
  return row.key;
}

describe("the text of a page", () => {
  it("gives a reader the document's shown text, where a selection counts its positions", async () => {
    const s = await setup();
    const page = value(await s.ask(s.reader.id));
    if (page.state !== "ready") throw new Error(page.state);
    expect(page).toMatchObject({ versionId: s.doc.versionId, path: "index.md" });
    expect(page.text).toContain("Second paragraph here.");
    expect(page.text).not.toContain("](https://x.test)");
    // The same code point positions a selection in the frame gives (the planners' own index).
    const op = textOp(s.doc, DOC, "Second", "Next");
    if (op.kind !== "text" || op.target.anchor.kind !== "text") throw new Error("not text");
    const { start, end } = op.target.anchor.position;
    expect(Array.from(page.text).slice(start, end).join("")).toBe("Second");
  });

  it("gives a site's page only what it shows: no markup, comment, attribute, hidden or script text", async () => {
    const s = await setup({ type: "site", body: HIDDEN_PAGE });
    const page = value(await s.ask(s.reader.id, "index.html"));
    if (page.state !== "ready") throw new Error(page.state);
    expect(page.text).toContain("Second paragraph here.");
    expect(page.text).toContain("A linked word.");
    for (const unseen of [
      "<p",
      "private note",
      "an attribute",
      "Hidden words",
      "secret",
      "color:red",
      "/x",
    ]) {
      expect(page.text, unseen).not.toContain(unseen);
    }
  });

  it("answers like a missing artifact to a stranger and a token, and refuses a file that is no page", async () => {
    const s = await setup();
    const stranger = await person("Stranger");
    expect(await s.ask(stranger.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await s.ask("st_00000000000000000000")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await s.ask(s.reader.id, "missing.md")).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("is refused where comments are off, and on suspended and held artifacts", async () => {
    const s = await setup();
    await db()
      .update(schema.artifacts)
      .set({ annotations: "off" })
      .where(eq(schema.artifacts.id, s.doc.artifactId));
    expect((await s.ask(s.reader.id)).ok).toBe(false);
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, s.doc.artifactId));
    value(await suspendArtifact(db(), { artifactId: s.doc.artifactId, reason: "spam", now: NOW }));
    expect((await s.ask(s.reader.id)).ok).toBe(false);
    expect((await s.ask(s.owner.id)).ok).toBe(false);
    value(
      await placeLegalHold(db(), {
        artifactId: s.doc.artifactId,
        ground: "Evidence",
        releaseAt: null,
        now: NOW + 1,
      }),
    );
    expect((await s.ask(s.owner.id)).ok).toBe(false);
  });

  it("counts in the planning windows and says when a page is over the planning limits", async () => {
    const s = await setup();
    for (let i = 0; i < 10; i++) expect((await s.ask(s.reader.id)).ok).toBe(true);
    expect(await s.ask(s.reader.id)).toMatchObject({ ok: false, code: "rate_limited" });
    const big = await setup({
      type: "site",
      body: `<!doctype html><html><body><p>${"word ".repeat(220_000)}</p></body></html>`,
    });
    expect(value(await big.ask(big.reader.id, "index.html"))).toEqual({
      state: "unavailable",
      reason: "too_large",
    });
  });

  it("says when the page is missing from storage, is not text, or has no stored rendering", async () => {
    const missing = await setup({ type: "site" });
    await env.ARTIFACTS.delete(await keyOf(missing.doc.versionId, "published"));
    expect(await missing.ask(missing.reader.id, "index.html")).toMatchObject({
      ok: false,
      code: "not_found",
    });

    const binary = await setup({ type: "site" });
    const key = await keyOf(binary.doc.versionId, "published");
    const size = (await env.ARTIFACTS.head(key))?.size ?? 0;
    await env.ARTIFACTS.put(key, new Uint8Array(size).fill(0xff));
    expect(value(await binary.ask(binary.reader.id, "index.html"))).toEqual({
      state: "unavailable",
      reason: "not_eligible",
    });

    const unrendered = await setup();
    await env.ARTIFACTS.delete(await keyOf(unrendered.doc.versionId, "rendered"));
    expect(value(await unrendered.ask(unrendered.reader.id))).toEqual({
      state: "unavailable",
      reason: "renderer_changed",
    });
  });
});
