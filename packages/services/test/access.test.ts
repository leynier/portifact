import { env } from "cloudflare:test";
import { LIMITS } from "@portifact/contracts";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccess, updateAccess } from "../src/access.ts";

const db = () => createDb(env.DB);
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
let seq = 0;

function newId(): string {
  seq += 1;
  let id = "";
  for (let i = 0, n = seq * 7919 + 13; i < 10; i += 1, n = Math.floor(n / 32) + i * 31) {
    id += ALPHABET[n % 32];
  }
  return id;
}

async function owner(ageDays: number): Promise<string> {
  const id = `u_${crypto.randomUUID()}`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: "",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(NOW - ageDays * DAY),
      updatedAt: new Date(NOW),
    });
  return id;
}

async function artifact(
  ownerId: string,
  state: "active" | "archived" | "suspended" | "deleted" = "active",
) {
  const id = newId();
  await db().insert(schema.artifacts).values({
    id,
    ownerId,
    type: "site",
    name: "x",
    state,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

describe("access policy", () => {
  it("starts private, then opens to a reader list and bumps the generation each time", async () => {
    const ownerId = await owner(30);
    const artifactId = await artifact(ownerId);
    const initial = await getAccess(db(), { ownerId, artifactId });
    expect(initial).toEqual({
      ok: true,
      value: {
        mode: "restricted",
        readers: [],
        indexable: false,
        embeddable: false,
        bar: true,
        policyGeneration: 1,
      },
    });

    const added = await updateAccess(db(), {
      ownerId,
      artifactId,
      change: { addReaders: ["b@example.test", "a@example.test", "a@example.test"] },
      now: NOW,
    });
    expect(added.ok && added.value).toMatchObject({
      readers: ["a@example.test", "b@example.test"],
      policyGeneration: 2,
    });

    const changed = await updateAccess(db(), {
      ownerId,
      artifactId,
      change: {
        removeReaders: ["a@example.test"],
        mode: "authenticated",
        indexable: true,
        embeddable: true,
        bar: false,
      },
      now: NOW,
    });
    expect(changed.ok && changed.value).toEqual({
      mode: "authenticated",
      readers: ["b@example.test"],
      indexable: true,
      embeddable: true,
      bar: false,
      policyGeneration: 3,
    });
  });

  it("lets a reader be added and removed in one change, keeping the addition", async () => {
    const ownerId = await owner(30);
    const artifactId = await artifact(ownerId);
    const result = await updateAccess(db(), {
      ownerId,
      artifactId,
      change: { addReaders: ["c@example.test"], removeReaders: ["c@example.test"] },
      now: NOW,
    });
    expect(result.ok && result.value.readers).toEqual(["c@example.test"]);
  });

  it("keeps new accounts from going public but lets them narrow access", async () => {
    const young = await owner(2);
    const artifactId = await artifact(young);
    expect(
      await updateAccess(db(), {
        ownerId: young,
        artifactId,
        change: { mode: "public" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "account_too_new_for_public" });
    expect(
      await updateAccess(db(), {
        ownerId: young,
        artifactId,
        change: { mode: "authenticated" },
        now: NOW,
      }),
    ).toMatchObject({ ok: true });

    const old = await owner(LIMITS.publicAccessMinAccountAgeDays);
    const other = await artifact(old);
    expect(
      await updateAccess(db(), {
        ownerId: old,
        artifactId: other,
        change: { mode: "public" },
        now: NOW,
      }),
    ).toMatchObject({ ok: true, value: { mode: "public" } });
  });

  it("caps the reader list", async () => {
    const ownerId = await owner(30);
    const artifactId = await artifact(ownerId);
    const emails = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => `r${from + i}@example.test`);
    for (let start = 0; start < LIMITS.readersPerArtifact; start += LIMITS.readersPerChange) {
      const step = await updateAccess(db(), {
        ownerId,
        artifactId,
        change: { addReaders: emails(start, LIMITS.readersPerChange) },
        now: NOW,
      });
      expect(step.ok).toBe(true);
    }
    expect(
      await updateAccess(db(), {
        ownerId,
        artifactId,
        change: { addReaders: ["one-more@example.test"] },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "quota_exceeded" });
    // Swapping one reader for another stays within the cap.
    expect(
      await updateAccess(db(), {
        ownerId,
        artifactId,
        change: { addReaders: ["swap@example.test"], removeReaders: ["r0@example.test"] },
        now: NOW,
      }),
    ).toMatchObject({ ok: true });
  });

  it("hides other accounts' and deleted artifacts, and freezes suspended ones", async () => {
    const ownerId = await owner(30);
    const artifactId = await artifact(ownerId);
    const deleted = await artifact(ownerId, "deleted");
    const suspended = await artifact(ownerId, "suspended");
    expect(await getAccess(db(), { ownerId: "u_else", artifactId })).toMatchObject({
      code: "not_found",
    });
    expect(await getAccess(db(), { ownerId, artifactId: deleted })).toMatchObject({
      code: "not_found",
    });
    expect(
      await updateAccess(db(), {
        ownerId: "u_else",
        artifactId,
        change: { mode: "authenticated" },
        now: NOW,
      }),
    ).toMatchObject({ code: "not_found" });
    expect(
      await updateAccess(db(), {
        ownerId,
        artifactId: suspended,
        change: { mode: "authenticated" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("allows narrowing the access of an archived artifact", async () => {
    const ownerId = await owner(30);
    const artifactId = await artifact(ownerId, "archived");
    expect(
      await updateAccess(db(), {
        ownerId,
        artifactId,
        change: { removeReaders: ["x@example.test"] },
        now: NOW,
      }),
    ).toMatchObject({ ok: true });
  });

  it("turns a concurrent change into a conflict without applying its reader changes", async () => {
    const ownerId = await owner(30);
    const artifactId = await artifact(ownerId);
    const results = await Promise.all([
      updateAccess(db(), {
        ownerId,
        artifactId,
        change: { addReaders: ["first@example.test"] },
        now: NOW,
      }),
      updateAccess(db(), {
        ownerId,
        artifactId,
        change: { addReaders: ["second@example.test"] },
        now: NOW,
      }),
    ]);
    const conflicts = results.filter((r) => !r.ok);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: "version_conflict" });
    const final = await getAccess(db(), { ownerId, artifactId });
    expect(final.ok && final.value.readers).toHaveLength(1);
    expect(final.ok && final.value.policyGeneration).toBe(2);
  });

  it("records each change for the owner's activity log", async () => {
    const ownerId = await owner(30);
    const artifactId = await artifact(ownerId);
    await updateAccess(db(), { ownerId, artifactId, change: { mode: "authenticated" }, now: NOW });
    const events = await db()
      .select()
      .from(schema.lifecycleEvents)
      .where(eq(schema.lifecycleEvents.artifactId, artifactId));
    expect(events).toMatchObject([
      { event: "access_changed", details: { mode: "authenticated", added: 0, removed: 0 } },
    ]);
  });
});
