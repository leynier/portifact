import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { artifact, context, NOW, OWNER, ok, op } from "./harness.ts";

describe("one documents object per artifact, reachable from two Workers", () => {
  it("serves what one Worker wrote to another Worker bound by script_name", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "notes", mode: "read" }));
    ok(await docs.create(op(envelope), context(OWNER), "notes", { text: "hello" }));
    const query = new URLSearchParams({
      artifact: envelope.artifactId,
      collection: "notes",
      envelope: JSON.stringify(envelope),
      now: String(NOW),
    });
    const response = await env.APP.fetch(`https://app.internal/?${query}`);
    const page = (await response.json()) as {
      ok: boolean;
      value: { documents: { text: string }[] };
    };
    expect(page.ok).toBe(true);
    expect(page.value.documents.map((document) => document.text)).toEqual(["hello"]);
  });

  it("stores nothing for a read of an artifact that has no data", async () => {
    const { envelope, docs } = artifact();
    expect(ok(await docs.query(envelope, context(OWNER), { collection: "notes" }))).toEqual({
      documents: [],
      next: null,
    });
    // No table was created: the size is at most SQLite's empty first page.
    expect((await docs.size()).bytes).toBeLessThanOrEqual(4096);
    expect((await docs.size()).seq).toBe(0);
  });
});
