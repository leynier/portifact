import { describe, expect, it } from "vitest";
import { artifact, FREE, NOW, OWNER, ok, visitor } from "./harness.ts";

describe("bounds enforced inside the object", () => {
  it("refuses a document over the plan's document size, and accepts one at it", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    // {"text":"…"} is 11 bytes of JSON around the text.
    const fits = { text: "x".repeat(FREE.documentBytes - 11) };
    ok(await stub.create(ref, visitor("v_a"), "items", fits, FREE, NOW));
    const over = { text: "x".repeat(FREE.documentBytes - 10) };
    expect(await stub.create(ref, visitor("v_a"), "items", over, FREE, NOW)).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
  });

  it("refuses the document past the collection's count, whoever writes it", async () => {
    const { ref, stub } = artifact();
    const limits = { ...FREE, documentsPerCollection: 3, writesPerAuthorPerMinute: 100 };
    ok(await stub.declareCollection(ref, { name: "items", mode: "append" }, limits));
    for (let index = 0; index < 3; index++) {
      ok(await stub.create(ref, visitor(`v_${index}`), "items", { index }, limits, NOW));
    }
    expect(
      await stub.create(ref, visitor("v_x"), "items", { index: 3 }, limits, NOW),
    ).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
    expect(await stub.create(ref, OWNER, "items", { index: 3 }, limits, NOW)).toMatchObject({
      ok: false,
      error: "quota_exceeded",
    });
  });

  it("refuses a burst past the per-author rate, exactly, and opens again next minute", async () => {
    const { ref, stub } = artifact();
    ok(await stub.declareCollection(ref, { name: "items", mode: "own" }, FREE));
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        stub.create(ref, visitor("v_a"), "items", { index }, FREE, NOW),
      ),
    );
    expect(burst.filter((outcome) => outcome.ok)).toHaveLength(FREE.writesPerAuthorPerMinute);
    expect(burst.filter((outcome) => !outcome.ok && outcome.error === "rate_limited")).toHaveLength(
      10,
    );
    // Another author is not affected; the same author is again after the minute.
    ok(await stub.create(ref, visitor("v_b"), "items", { n: 1 }, FREE, NOW));
    ok(await stub.create(ref, visitor("v_a"), "items", { n: 1 }, FREE, NOW + 60_000));
  });

  it("refuses a write that takes the database past the artifact's size and keeps nothing of it", async () => {
    const { ref, stub } = artifact();
    const limits = {
      ...FREE,
      bytesPerArtifact: 64 * 1024,
      documentBytes: 16 * 1024,
      writesPerAuthorPerMinute: 1000,
    };
    ok(await stub.declareCollection(ref, { name: "items", mode: "read" }, limits));
    let accepted = 0;
    let refused = 0;
    for (let index = 0; index < 20; index++) {
      const outcome = await stub.create(
        ref,
        OWNER,
        "items",
        { text: "y".repeat(12_000), index },
        limits,
        NOW,
      );
      if (outcome.ok) accepted += 1;
      else if (outcome.error === "quota_exceeded") refused += 1;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(await stub.size()).toBeLessThanOrEqual(limits.bytesPerArtifact);
    const page = ok(await stub.query(ref, OWNER, { collection: "items", limit: 100 }));
    expect(page.documents).toHaveLength(accepted);
  });

  it("caps the collections an artifact may declare", async () => {
    const { ref, stub } = artifact();
    const limits = { ...FREE, collections: 2 };
    ok(await stub.declareCollection(ref, { name: "one", mode: "own" }, limits));
    ok(await stub.declareCollection(ref, { name: "two", mode: "own" }, limits));
    // Changing an existing collection's mode is not a new collection.
    ok(await stub.declareCollection(ref, { name: "two", mode: "append" }, limits));
    expect(await stub.declareCollection(ref, { name: "three", mode: "own" }, limits)).toMatchObject(
      {
        ok: false,
        error: "quota_exceeded",
      },
    );
    expect(
      await stub.declareCollection(ref, { name: "Bad-Name", mode: "own" }, limits),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    expect(
      await stub.declareCollection(ref, { name: "four", mode: "public" }, limits),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });
});
