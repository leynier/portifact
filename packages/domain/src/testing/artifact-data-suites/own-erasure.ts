// A person's own erasure (decision 0026, "A person's rights"): `eraseOwnChunk` deletes the
// documents the author created at or before the request's time and unattributes their edits made
// by then, in bounded chunks, as protected work that neither their rights allowance nor the
// artifact's budget stops, refused while held. The cutoff is the object's own: a late, repeated
// or replayed step never touches what was saved or edited after the request. Unlike an author
// erasure it writes no barrier, so the person may save again afterwards. Runs against both
// objects.
import { describe, expect, it } from "vitest";
import type { OwnChunk } from "../../artifact-data/index.ts";
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

export function ownErasureSuite(make: MakeObject): void {
  const ctx = context();
  const later = (ms: number) => context({ now: NOW + ms });

  async function withCollection(mode: "own" | "shared" = "own", name = "items") {
    const object = await make();
    const base = envelope();
    value(await object.declare(op(base), OWNER, { name, mode }, ctx));
    return { object, base };
  }

  describe("a person's own erasure", () => {
    it("deletes only the author's documents in bounded chunks and leaves no barrier", async () => {
      const { object, base } = await withCollection();
      for (let n = 0; n < 5; n++) {
        value(await object.create(op(base), visitor("mine"), "items", { n }, ctx));
      }
      value(await object.create(op(base), visitor("other"), "items", { n: 9 }, ctx));
      const chunk = () => object.eraseOwnChunk(op(base), visitorId("mine"), NOW, null, 3, later(1));
      expect(value<OwnChunk>(await chunk())).toEqual({
        documents: 3,
        edits: 0,
        more: true,
        editsAfter: null,
      });
      expect(value<OwnChunk>(await chunk())).toEqual({
        documents: 2,
        edits: 0,
        more: false,
        editsAfter: null,
      });
      const left = value<{ rows: { by: string }[] }>(
        await object.exportPage(base, OWNER, null, 500, later(2)),
      );
      expect(left.rows.map((row) => row.by)).toEqual([visitorId("other")]);
      // Not terminal: the person saves again.
      value(await object.create(op(base), visitor("mine"), "items", { n: 10 }, later(3)));
    });

    it("never deletes what the author saved after the request's time, whichever step runs late", async () => {
      const { object, base } = await withCollection();
      value(await object.create(op(base), visitor("mine"), "items", { n: 1 }, ctx));
      // Saved after the request at NOW.
      value(await object.create(op(base), visitor("mine"), "items", { n: 2 }, later(5_000)));
      for (let step = 0; step < 3; step++) {
        value(
          await object.eraseOwnChunk(op(base), visitorId("mine"), NOW, null, 500, later(10_000)),
        );
      }
      const left = value<{ rows: { created: number }[] }>(
        await object.exportPage(base, OWNER, null, 500, later(20_000)),
      );
      expect(left.rows.map((row) => row.created)).toEqual([NOW + 5_000]);
    });

    it("works through every collection, oldest first, within one chunk", async () => {
      const { object, base } = await withCollection("own", "a");
      value(await object.declare(op(base), OWNER, { name: "b", mode: "own" }, ctx));
      value(await object.create(op(base), visitor("mine"), "a", { n: 1 }, ctx));
      value(await object.create(op(base), visitor("mine"), "b", { n: 2 }, ctx));
      expect(
        value<OwnChunk>(
          await object.eraseOwnChunk(op(base), visitorId("mine"), NOW, null, 10, later(1)),
        ),
      ).toMatchObject({ documents: 2, more: false });
    });

    it("removes the author's name from edits made by then, keeps later ones, and pages edits by cursor", async () => {
      const { object, base } = await withCollection("shared");
      const docs: string[] = [];
      for (let n = 0; n < 3; n++) {
        docs.push(
          value<{ _id: string }>(
            await object.create(op(base), visitor("other"), "items", { n }, ctx),
          )._id,
        );
      }
      const sorted = [...docs].sort();
      // Two edits before the request, one after it.
      value(await object.replace(op(base), visitor("mine"), "items", sorted[0] as string, {}, ctx));
      value(await object.replace(op(base), visitor("mine"), "items", sorted[1] as string, {}, ctx));
      value(
        await object.replace(
          op(base),
          visitor("mine"),
          "items",
          sorted[2] as string,
          {},
          later(5_000),
        ),
      );
      const first = value<OwnChunk>(
        await object.eraseOwnChunk(op(base), visitorId("mine"), NOW, null, 2, later(6_000)),
      );
      expect(first).toEqual({
        documents: 0,
        edits: 2,
        more: true,
        editsAfter: { collection: "items", id: sorted[1] },
      });
      const second = value<OwnChunk>(
        await object.eraseOwnChunk(
          op(base),
          visitorId("mine"),
          NOW,
          first.editsAfter,
          2,
          later(7_000),
        ),
      );
      expect(second).toEqual({ documents: 0, edits: 0, more: false, editsAfter: null });
      const kept = value<{ rows: { id: string; by: string; editedBy: string | null }[] }>(
        await object.exportPage(base, OWNER, null, 500, later(8_000)),
      );
      const editors = new Map(kept.rows.map((row) => [row.id, row.editedBy]));
      expect(editors.get(sorted[0] as string)).not.toBe(visitorId("mine"));
      expect(editors.get(sorted[1] as string)).not.toBe(visitorId("mine"));
      expect(editors.get(sorted[2] as string)).toBe(visitorId("mine"));
      expect(kept.rows.every((row) => row.by === visitorId("other"))).toBe(true);
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
        value<OwnChunk>(
          await object.eraseOwnChunk(op(base), visitorId("mine"), NOW, null, 500, tight),
        ),
      ).toEqual({ documents: 3, edits: 0, more: false, editsAfter: null });
    });

    it("is refused while the artifact is held, and erases nothing", async () => {
      const { object, base } = await withCollection();
      value(await object.create(op(base), visitor("mine"), "items", { n: 1 }, ctx));
      const held = { ...base, epoch: 1 };
      value(await object.fence(held, { kind: "hold", transition: "t_hold" }, NOW));
      expect(
        await object.eraseOwnChunk(op(held), visitorId("mine"), NOW, null, 10, ctx),
      ).toMatchObject({ ok: false, code: "held" });
      // The operator's export reads a held object: the document is still there.
      const kept = value<{ rows: unknown[] }>(
        await object.exportPage(held, OWNER, null, 500, ctx, true),
      );
      expect(kept.rows).toHaveLength(1);
    });

    it("on an object that holds nothing is refused without binding it", async () => {
      const object = await make();
      expect(
        await object.eraseOwnChunk(op(envelope()), visitorId("mine"), NOW, null, 10, ctx),
      ).toMatchObject({ ok: false });
    });
  });
}
