// A person's own erasure (decision 0026, "A person's rights"): `eraseOwnChunk` deletes the
// documents the author created and unattributes their edits in bounded chunks, as protected work
// that neither their rights allowance nor the artifact's budget stops, refused while held, and
// unlike an author erasure it writes no barrier, so the person may save again afterwards. Runs
// against both objects.
import { describe, expect, it } from "vitest";
import type { MakeObject } from "../artifact-data-driver.ts";
import {
  context,
  envelope,
  NOW,
  OWNER,
  op,
  ROOMY,
  value,
  visitor,
  visitorId,
} from "../artifact-data-fixtures.ts";

type Chunk = { documents: number; edits: number; more: boolean };

export function ownErasureSuite(make: MakeObject): void {
  const ctx = context();

  async function withCollection(mode: "own" | "shared" = "own") {
    const object = await make();
    const base = envelope();
    value(await object.declare(op(base), OWNER, { name: "items", mode }, ctx));
    return { object, base };
  }

  describe("a person's own erasure", () => {
    it("deletes only the author's documents in bounded chunks and leaves no barrier", async () => {
      const { object, base } = await withCollection();
      for (let n = 0; n < 5; n++) {
        value(await object.create(op(base), visitor("mine"), "items", { n }, ctx));
      }
      value(await object.create(op(base), visitor("other"), "items", { n: 9 }, ctx));
      const first = value<Chunk>(await object.eraseOwnChunk(op(base), visitorId("mine"), 3, ctx));
      expect(first).toEqual({ documents: 3, edits: 0, more: true });
      const last = value<Chunk>(await object.eraseOwnChunk(op(base), visitorId("mine"), 3, ctx));
      expect(last).toEqual({ documents: 2, edits: 0, more: false });
      const left = value<{ rows: { by: string }[] }>(
        await object.exportPage(base, OWNER, null, 500, ctx),
      );
      expect(left.rows.map((row) => row.by)).toEqual([visitorId("other")]);
      // Not terminal: the person saves again.
      value(await object.create(op(base), visitor("mine"), "items", { n: 10 }, ctx));
    });

    it("removes the author's name from their edits of other people's documents", async () => {
      const { object, base } = await withCollection("shared");
      const doc = value<{ _id: string }>(
        await object.create(op(base), visitor("other"), "items", { n: 1 }, ctx),
      );
      value(await object.replace(op(base), visitor("mine"), "items", doc._id, { n: 2 }, ctx));
      const chunk = value<Chunk>(await object.eraseOwnChunk(op(base), visitorId("mine"), 10, ctx));
      expect(chunk).toEqual({ documents: 0, edits: 1, more: false });
      const kept = value<{ rows: { by: string; editedBy: string | null; body: unknown }[] }>(
        await object.exportPage(base, OWNER, null, 500, ctx),
      );
      expect(kept.rows).toHaveLength(1);
      expect(kept.rows[0]?.by).toBe(visitorId("other"));
      expect(kept.rows[0]?.editedBy).not.toBe(visitorId("mine"));
    });

    it("goes on when the person's rights allowance is spent", async () => {
      const tight = context({ limits: { ...ROOMY, rightsRowsPerDay: 1 } });
      const { object, base } = await withCollection();
      const docs: string[] = [];
      for (let n = 0; n < 3; n++) {
        docs.push(
          value<{ _id: string }>(
            await object.create(op(base), visitor("mine"), "items", { n }, tight),
          )._id,
        );
      }
      value(await object.exportMine(base, visitor("mine", false), null, tight));
      expect(
        await object.remove(op(base), visitor("mine", false), "items", docs[0] as string, tight),
      ).toMatchObject({ ok: false, code: "rate_limited" });
      expect(
        value<Chunk>(await object.eraseOwnChunk(op(base), visitorId("mine"), 500, tight)),
      ).toEqual({ documents: 3, edits: 0, more: false });
    });

    it("is refused while the artifact is held, and erases nothing", async () => {
      const { object, base } = await withCollection();
      value(await object.create(op(base), visitor("mine"), "items", { n: 1 }, ctx));
      const held = { ...base, epoch: 1 };
      value(await object.fence(held, { kind: "hold", transition: "t_hold" }, NOW));
      expect(await object.eraseOwnChunk(op(held), visitorId("mine"), 10, ctx)).toMatchObject({
        ok: false,
        code: "held",
      });
      // The operator's export reads a held object: the document is still there.
      const kept = value<{ rows: unknown[] }>(
        await object.exportPage(held, OWNER, null, 500, ctx, true),
      );
      expect(kept.rows).toHaveLength(1);
    });

    it("on an object that holds nothing is refused without binding it", async () => {
      const object = await make();
      expect(await object.eraseOwnChunk(op(envelope()), visitorId("mine"), 10, ctx)).toMatchObject({
        ok: false,
      });
    });
  });
}
