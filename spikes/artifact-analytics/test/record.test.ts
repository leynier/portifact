import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ViewDelta } from "../src/meter.ts";
import {
  DELETE_BATCH,
  eraseArtifactViews,
  pruneExpired,
  RECORD_CHUNK,
  recordViews,
  setOwnerRetention,
  viewsExpireAt,
} from "../src/record.ts";
import { DAY_MS } from "../src/views.ts";
import { daysAgo, NOW, randomId, seedOpening, TODAY, viewRows } from "./harness.ts";

const delta = (artifactId: string, overrides: Partial<ViewDelta> = {}): ViewDelta => ({
  artifactId,
  ownerId: "owner",
  day: TODAY,
  views: 1,
  signedInViews: 0,
  retentionDays: 365,
  ...overrides,
});

const count = async (query: string, ...params: unknown[]) =>
  (
    await env.ACCESS.prepare(query)
      .bind(...params)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("recordViews", () => {
  it("adds to an existing row instead of overwriting it, and keeps its first expiry", async () => {
    const id = randomId();
    await recordViews(env.ACCESS, [delta(id, { views: 5, signedInViews: 2 })]);
    await recordViews(env.ACCESS, [delta(id, { views: 3, signedInViews: 1, retentionDays: 30 })]);
    expect(await viewRows(id)).toEqual([
      { day: TODAY, views: 8, signed_in_views: 3, expires_at: viewsExpireAt(TODAY, 365) },
    ]);
  });

  it("keeps a row for the whole retention after its day ends", () => {
    expect(viewsExpireAt(TODAY, 365)).toBe(TODAY + 366 * DAY_MS);
  });

  it("skips empty deltas and writes nothing for an empty batch", async () => {
    const id = randomId();
    await recordViews(env.ACCESS, []);
    await recordViews(env.ACCESS, [delta(id, { views: 0 })]);
    expect(await viewRows(id)).toEqual([]);
  });

  it("splits a large flush into batches under the per-invocation query limit", async () => {
    const owner = `owner-${randomId()}`;
    const deltas = Array.from({ length: RECORD_CHUNK * 2 + 5 }, () =>
      delta(randomId(), { ownerId: owner }),
    );
    await recordViews(env.ACCESS, deltas);
    expect(await count("select count(*) as n from artifact_views where owner_id = ?", owner)).toBe(
      deltas.length,
    );
  });

  it("refuses more signed-in views than views", async () => {
    await expect(
      recordViews(env.ACCESS, [delta(randomId(), { views: 1, signedInViews: 2 })]),
    ).rejects.toThrow(/CHECK/);
  });

  it("an update that only adds writes one row; the first insert also writes the two indexes", async () => {
    // Local D1 reports rows written as SQLite counts them, indexes included, which is what D1
    // bills. Measured, not assumed: this is the cost per flush that the decision record uses.
    const id = randomId();
    const insert = await env.ACCESS.prepare(
      `insert into artifact_views values (?, ?, 'owner', 1, 0, ?)
       on conflict (artifact_id, day) do update set views = views + excluded.views,
       signed_in_views = signed_in_views + excluded.signed_in_views`,
    )
      .bind(id, TODAY, viewsExpireAt(TODAY, 365))
      .run();
    const update = await env.ACCESS.prepare(
      `insert into artifact_views values (?, ?, 'owner', 1, 0, ?)
       on conflict (artifact_id, day) do update set views = views + excluded.views,
       signed_in_views = signed_in_views + excluded.signed_in_views`,
    )
      .bind(id, TODAY, viewsExpireAt(TODAY, 365))
      .run();
    expect(insert.meta.rows_written).toBe(3);
    expect(update.meta.rows_written).toBe(1);
  });
});

describe("access log write cost", () => {
  it("one opening writes the table, its key and its three indexes (five rows)", async () => {
    // With the owner index the design adds; today's table has two indexes, so four rows.
    const result = await env.ACCESS.prepare(
      "insert into access_events values (?, 0, 'u', 'o', 'e', 0, 1)",
    )
      .bind(randomId())
      .run();
    expect(result.meta.rows_written).toBe(5);
  });
});

describe("pruneExpired", () => {
  it("deletes view rows and openings past their expiry and keeps the rest", async () => {
    const old = randomId();
    const kept = randomId();
    await recordViews(env.ACCESS, [
      delta(old, { day: daysAgo(400) }),
      delta(kept, { day: daysAgo(10) }),
    ]);
    await seedOpening(old, "owner", "reader", daysAgo(400));
    await seedOpening(kept, "owner", "reader", daysAgo(10));
    await pruneExpired(env.ACCESS, NOW);
    expect(await viewRows(old)).toEqual([]);
    expect(await viewRows(kept)).toHaveLength(1);
    expect(await count("select count(*) as n from access_events where artifact_id = ?", old)).toBe(
      0,
    );
    expect(await count("select count(*) as n from access_events where artifact_id = ?", kept)).toBe(
      1,
    );
  });

  it("deletes in bounded statements and goes on in the next run", async () => {
    const owner = `owner-${randomId()}`;
    const deltas = Array.from({ length: DELETE_BATCH + 10 }, () =>
      delta(randomId(), { ownerId: owner, day: daysAgo(500) }),
    );
    await recordViews(env.ACCESS, deltas);
    const remaining = () =>
      count("select count(*) as n from artifact_views where owner_id = ?", owner);
    // A long-expired backlog from other tests may sit in front; one round deletes at most a batch.
    await pruneExpired(env.ACCESS, NOW, 1);
    expect(await remaining()).toBeGreaterThanOrEqual(10);
    await pruneExpired(env.ACCESS, NOW);
    expect(await remaining()).toBe(0);
  });
});

describe("setOwnerRetention", () => {
  it("a downgrade shortens the owner's rows, so the next prune removes what the new plan does not keep", async () => {
    const owner = `owner-${randomId()}`;
    const other = `owner-${randomId()}`;
    const id = randomId();
    const otherId = randomId();
    await recordViews(env.ACCESS, [
      delta(id, { ownerId: owner, day: daysAgo(60) }),
      delta(id, { ownerId: owner, day: daysAgo(5) }),
      delta(otherId, { ownerId: other, day: daysAgo(60) }),
    ]);
    await seedOpening(id, owner, "reader", daysAgo(60));
    await seedOpening(id, owner, "reader", daysAgo(5));
    await setOwnerRetention(env.ACCESS, owner, 30);
    await pruneExpired(env.ACCESS, NOW);
    expect((await viewRows(id)).map((row) => row.day)).toEqual([daysAgo(5)]);
    expect(await count("select count(*) as n from access_events where artifact_id = ?", id)).toBe(
      1,
    );
    // Another owner's rows keep their retention.
    expect(await viewRows(otherId)).toHaveLength(1);
  });

  it("an upgrade extends the rows still kept", async () => {
    const owner = `owner-${randomId()}`;
    const id = randomId();
    await recordViews(env.ACCESS, [
      delta(id, { ownerId: owner, day: daysAgo(20), retentionDays: 30 }),
    ]);
    await setOwnerRetention(env.ACCESS, owner, 365);
    expect(await viewRows(id)).toMatchObject([{ expires_at: viewsExpireAt(daysAgo(20), 365) }]);
  });
});

describe("eraseArtifactViews", () => {
  it("erases every row of the artifact and nothing else", async () => {
    const id = randomId();
    const other = randomId();
    await recordViews(env.ACCESS, [delta(id, { day: daysAgo(2) }), delta(id), delta(other)]);
    expect(await eraseArtifactViews(env.ACCESS, id)).toBe("done");
    expect(await viewRows(id)).toEqual([]);
    expect(await viewRows(other)).toHaveLength(1);
  });

  it("asks to run again when a run did not reach the end", async () => {
    const id = randomId();
    const deltas = Array.from({ length: DELETE_BATCH + 1 }, (_, i) =>
      delta(id, { day: TODAY - i * DAY_MS }),
    );
    await recordViews(env.ACCESS, deltas);
    expect(await eraseArtifactViews(env.ACCESS, id, 1)).toBe("pending");
    expect(await eraseArtifactViews(env.ACCESS, id, 1)).toBe("done");
    expect(await viewRows(id)).toEqual([]);
  });
});
