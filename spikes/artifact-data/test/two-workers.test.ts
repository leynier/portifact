import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { artifact, FREE, NOW, OWNER, ok } from "./harness.ts";

describe("one object per artifact, reachable from two Workers", () => {
  it("serves what the data Worker's binding wrote to another Worker bound by script_name", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "notes", mode: "read" }, FREE));
    ok(await stub.create(ref, OWNER, "notes", { text: "hello" }, FREE, NOW));
    const response = await env.APP.fetch(
      `https://app.internal/?artifact=${ref.artifactId}&collection=notes`,
    );
    const page = (await response.json()) as {
      ok: boolean;
      value: { documents: { text: string }[] };
    };
    expect(page.ok).toBe(true);
    expect(page.value.documents.map((document) => document.text)).toEqual(["hello"]);
  });

  it("names one object per artifact: another ID is another, empty database", async () => {
    const first = artifact();
    const second = artifact();
    ok(await first.stub.declareCollection(first.ref, { name: "notes", mode: "read" }, FREE));
    ok(await first.stub.create(first.ref, OWNER, "notes", { text: "only here" }, FREE, NOW));
    const response = await env.APP.fetch(
      `https://app.internal/?artifact=${second.ref.artifactId}&collection=notes`,
    );
    expect(await response.json()).toMatchObject({ ok: true, value: { documents: [] } });
  });

  it("stores nothing for a read of an artifact that has no data", async () => {
    const { ref, stub } = artifact();
    expect(ok(await stub.query(ref, OWNER, { collection: "notes" }))).toEqual({
      documents: [],
      next: null,
    });
    // An object nobody wrote has no tables: the read created no schema.
    const created = ok(
      await stub.sql(
        ref,
        "select count(*) from sqlite_schema where name like 'pf_%'",
        [],
        false,
        FREE,
      ),
    );
    expect(created.rows).toEqual([[0]]);
  });

  it("refuses a call that names another artifact than the one the object holds", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "notes", mode: "read" }, FREE));
    expect(
      await stub.create({ ...ref, region: "eu" }, OWNER, "notes", { text: "x" }, FREE, NOW),
    ).toMatchObject({ ok: false, error: "forbidden", message: "artifact reference mismatch" });
    expect(
      await stub.query({ ...ref, artifactId: "other" }, OWNER, { collection: "notes" }),
    ).toMatchObject({ ok: false, error: "forbidden" });
  });
});
