import { schema } from "@portifact/db";
import { controlEnvelope, inventoryEntry, inventoryKey } from "@portifact/domain/artifact-data";
import {
  createWorkspace,
  deleteArtifactData,
  placeLegalHold,
  reconcileObject,
  registerDataObject,
  releaseLegalHold,
  transferArtifact,
} from "@portifact/services";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  grantPlan,
  publishSite,
  racing,
  user,
  value,
} from "../../../packages/services/test/fixtures.ts";
import {
  bucketOf,
  controlOf,
  D1_NOW,
  dataRowOf,
  db,
  jobsOf,
  DATA_NOW as NOW,
  objectsFor,
  stubOf,
  withData,
} from "./lifecycle.ts";

it("M10: repeated registration preserves the first inventory record", async () => {
  const { id } = await withData();
  const first = await (await bucketOf().get(inventoryKey(id)))!.json();
  await registerDataObject(db(), bucketOf(), "default", id, NOW + 1000);
  expect(await (await bucketOf().get(inventoryKey(id)))!.json()).toEqual(first);
});
it("M11: a purge that lost its old-state condition queues no data erase", async () => {
  const { id } = await withData();
  await deleteArtifactData(db(), bucketOf(), id, NOW);
  expect(await jobsOf(db(), ["data_erase"], id)).toEqual([]);
});
it("M13: a repeated release never raises the data epoch or appends another fence", async () => {
  const { id } = await withData({ state: "suspended" });
  await placeLegalHold(db(), { artifactId: id, ground: "Order", releaseAt: null, now: D1_NOW });
  await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 1 });
  const before = await jobsOf(db(), ["data_fence"], id);
  await releaseLegalHold(db(), { artifactId: id, now: D1_NOW + 2 });
  expect((await dataRowOf(id))?.epoch).toBe(2);
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual(before);
});
it("M16: a concurrent epoch change survives the reconciliation raise", async () => {
  const { id } = await withData();
  const c = (await controlOf(id))!;
  await stubOf(id).lifecycleFence(
    { ...controlEnvelope(c), epoch: 2 },
    { kind: "epoch", transition: "raise" },
    NOW,
  );
  const objects = objectsFor();
  let raced = false;
  // Reconciliation reads its D1 row, then asks for the hold. Interpose the later guarded update.
  const database = new Proxy(db(), {
    get(target, property) {
      if (property === "update")
        return (...args: Parameters<typeof target.update>) => {
          const builder = target.update(...args);
          const set = builder.set.bind(builder);
          return new Proxy(builder, {
            get(t, p) {
              if (p === "set")
                return (...values: Parameters<typeof set>) => {
                  const query = set(...values);
                  const where = query.where.bind(query);
                  return new Proxy(query, {
                    get(q, k) {
                      if (k === "where")
                        return async (...conditions: Parameters<typeof where>) => {
                          if (!raced) {
                            raced = true;
                            await db()
                              .update(schema.artifactData)
                              .set({ epoch: 9 })
                              .where(eq(schema.artifactData.artifactId, id));
                          }
                          return where(...conditions);
                        };
                      return Reflect.get(q, k, q);
                    },
                  });
                };
              return Reflect.get(t, p, t);
            },
          });
        };
      const v = Reflect.get(target, property, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await reconcileObject(database, objects, inventoryEntry(id, "default", NOW), NOW);
  expect((await dataRowOf(id))?.epoch).toBe(9);
});
it("M12: a transfer losing its guard creates no data fence", async () => {
  const owner = await user("Owner");
  const id = (await publishSite(owner.id)).artifactId;
  const ws = value(
    await createWorkspace(db().global, {
      slug: `w-${crypto.randomUUID().slice(0, 8)}`,
      name: "Team",
      adminUserId: owner.id,
      now: D1_NOW,
    }),
  );
  await grantPlan(ws.id, "team", { seats: 5 });
  await registerDataObject(db(), bucketOf(), "default", id, NOW);
  const raced = racing(() =>
    db()
      .update(schema.artifacts)
      .set({ lifecycleGeneration: 99 })
      .where(eq(schema.artifacts.id, id)),
  );
  const result = await transferArtifact(raced, bucketOf(), {
    userId: owner.id,
    artifactId: id,
    workspace: ws.slug,
    now: D1_NOW,
  });
  expect(result.ok).toBe(false);
  expect(await jobsOf(db(), ["data_fence"], id)).toEqual([]);
  expect((await dataRowOf(id))?.epoch).toBe(0);
});
