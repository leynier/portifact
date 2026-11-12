import { describe, expect, it } from "vitest";
import { artifact, context, OWNER, ok, op } from "./harness.ts";

// The spike's erase steps now admit through the production validator (`@portifact/domain`):
// refusals from another artifact, an older generation and a missing intent.
describe("erase steps through the production validator", () => {
  it("refuses another artifact, answers an older generation as done and a missing intent as nothing", async () => {
    const { envelope, docs } = artifact();
    ok(await docs.declareCollection(op(envelope), context(OWNER), { name: "items", mode: "read" }));
    const other = { ...envelope, artifactId: "zzzzzzzz22" };
    expect(await docs.prepareErase(other, "e1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await docs.commitErase(other, "e1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await docs.commitErase(envelope, "never")).toMatchObject({
      ok: false,
      error: "conflict",
    });
    ok(await docs.prepareErase(envelope, "e1"));
    ok(await docs.commitErase(envelope, "e1"));
    expect(ok(await docs.prepareErase(envelope, "e2"))).toEqual({ prepared: false });
    expect(await docs.cancelErase(envelope, "e2")).toBe(false);
  });
});

import { buildQuery, DataError, mode } from "../src/model.ts";

describe("the spike's remaining query rules", () => {
  it("refuses an unknown mode and a malformed range, and pages backwards with a cursor", () => {
    expect(() => mode("private")).toThrow(DataError);
    expect(() =>
      buildQuery({ collection: "c", created: { op: "eq" as "gt", value: 1 } }, "all", null, []),
    ).toThrow(DataError);
    const { sql } = buildQuery(
      { collection: "c", order: "-created", after: btoa(JSON.stringify([1, "a"])) },
      "all",
      null,
      [],
    );
    expect(sql).toContain("< (?, ?)");
  });
});
