import { env } from "cloudflare:test";
import { globalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { noticeWindowEnd, personalActor } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, getArtifact, listArtifacts } from "../src/artifacts.ts";
import { value } from "./fixtures.ts";

const db = () => regionsFromEnv(env).get("default").db;
const NOW = Date.parse("2026-11-08T12:00:00Z");
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function artifactId(seed: number): string {
  let id = "";
  for (let i = 0; i < 10; i += 1) id += ALPHABET[(seed * 7 + i * 13) % 32];
  return id;
}

async function insert(
  ownerId: string,
  count: number,
  state: "active" | "archived" | "deleted" | "draft" = "active",
  offset = 0,
) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = artifactId(offset + i);
    ids.push(id);
    await db()
      .insert(schema.artifacts)
      .values({
        id,
        ownerId,
        type: "site",
        name: `Artifact ${i}`,
        state,
        createdAt: 1000,
        // Two share each timestamp, so the id breaks ties.
        updatedAt: 1000 + Math.floor((offset + i) / 2),
      });
  }
  return ids;
}

describe("listing an owner's artifacts", () => {
  it("pages through every artifact once, newest first, without others' or deleted ones", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const ids = await insert(owner, 5);
    await insert(owner, 1, "deleted", 40);
    await insert(owner, 1, "draft", 41);
    await insert(`u_${crypto.randomUUID()}`, 2, "active", 50);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = value(
        await listArtifacts(db(), { actor: personalActor(owner), cursor, limit: 2, now: NOW }),
      );
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    const rows = value(
      await listArtifacts(db(), { actor: personalActor(owner), limit: 100, now: NOW }),
    );
    const times = rows?.items.map((row) => row.updatedAt) ?? [];
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(rows?.nextCursor).toBeNull();
  });

  it("rejects a cursor it did not issue", async () => {
    for (const cursor of ["not-base64!", btoa("x.y"), btoa("123.TOOSHORT"), "%%%"]) {
      expect(
        await listArtifacts(db(), { actor: personalActor("u"), cursor, limit: 10, now: NOW }),
        cursor,
      ).toEqual({ ok: false, code: "invalid_input", message: "Invalid cursor." });
    }
    expect(decodeCursor(encodeCursor({ updatedAt: 42, id: "abcdefghij" }))).toEqual({
      updatedAt: 42,
      id: "abcdefghij",
    });
  });

  it("finds only the owner's live artifact", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const [live] = await insert(owner, 1, "active", 60);
    const [gone] = await insert(owner, 1, "deleted", 61);
    const missing = { ok: false, code: "not_found", message: "Artifact not found." };
    expect(value(await getArtifact(db(), { userId: owner, artifactId: live as string })).id).toBe(
      live,
    );
    expect(await getArtifact(db(), { userId: "u_else", artifactId: live as string })).toEqual(
      missing,
    );
    expect(await getArtifact(db(), { userId: owner, artifactId: gone as string })).toEqual(missing);
    expect(await getArtifact(db(), { userId: owner, artifactId: "zzzzzzzzzz" })).toEqual(missing);
  });
});

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((byte) => ALPHABET[byte % 32]).join("");
}

type Row = typeof schema.artifacts.$inferInsert;

async function insertRows(ownerId: string, rows: Partial<Row>[]) {
  const ids: string[] = [];
  for (const [i, row] of rows.entries()) {
    const id = row.id ?? randomId();
    ids.push(id);
    await db()
      .insert(schema.artifacts)
      .values({
        id,
        ownerId,
        type: "site",
        name: `Artifact ${i}`,
        state: "active",
        createdAt: 1000,
        updatedAt: 2000 + i,
        ...row,
      });
  }
  return ids;
}

describe("searching and filtering an owner's artifacts", () => {
  const ids = async (ownerId: string, filters: Parameters<typeof listArtifacts>[1]["filters"]) =>
    value(
      await listArtifacts(db(), { actor: personalActor(ownerId), limit: 100, filters, now: NOW }),
    )?.items.map((row) => row.id);

  it("matches a part of the name in any case, or a part of the ID", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const [report, notes, other] = await insertRows(owner, [
      { name: "Quarterly REPORT" },
      { name: "Release notes" },
      { name: "Café menu" },
    ]);
    await insertRows(`u_${crypto.randomUUID()}`, [{ name: "Quarterly report too" }]);
    expect(await ids(owner, { search: "report" })).toEqual([report]);
    expect(await ids(owner, { search: "RELEASE" })).toEqual([notes]);
    expect(await ids(owner, { search: "café" })).toEqual([other]);
    expect(await ids(owner, { search: (notes as string).slice(2, 8).toUpperCase() })).toContain(
      notes,
    );
    expect(await ids(owner, { search: "nothing like this" })).toEqual([]);
    // Wildcards are text, not patterns.
    expect(await ids(owner, { search: "%" })).toEqual([]);
    expect(await ids(owner, { search: "_" })).toEqual([]);
  });

  it("applies every filter given, and never lists drafts or deleted artifacts", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const [site, doc, archived, suspended, purging] = await insertRows(owner, [
      { type: "site", accessMode: "public", annotations: "open" },
      { type: "markdown", accessMode: "authenticated", annotations: "locked" },
      { type: "text", state: "archived" },
      { type: "site", state: "suspended", suspensionReason: "phishing" },
      { type: "site", state: "purging" },
      { type: "site", state: "draft", accessMode: "public", annotations: "open" },
      { type: "site", state: "deleted", accessMode: "public", annotations: "open" },
    ]);
    expect(await ids(owner, { state: "active" })).toEqual([doc, site]);
    expect(await ids(owner, { state: "archived" })).toEqual([archived]);
    expect(await ids(owner, { state: "suspended" })).toEqual([suspended]);
    expect(await ids(owner, { state: "purging" })).toEqual([purging]);
    expect(await ids(owner, { type: "site" })).toEqual([purging, suspended, site]);
    expect(await ids(owner, { type: "markdown" })).toEqual([doc]);
    expect(await ids(owner, { access: "public" })).toEqual([site]);
    expect(await ids(owner, { access: "restricted" })).toEqual([purging, suspended, archived]);
    expect(await ids(owner, { annotations: "open" })).toEqual([site]);
    expect(await ids(owner, { annotations: "locked" })).toEqual([doc]);
    expect(await ids(owner, { annotations: "off" })).toEqual([purging, suspended, archived]);
    expect(await ids(owner, { type: "site", state: "active", access: "public" })).toEqual([site]);
    expect(await ids(owner, { type: "site", access: "authenticated" })).toEqual([]);
    expect(await ids(owner, {})).toHaveLength(5);
  });

  it("lists with expiring=soon the active artifacts an expiry notice is about", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const DAY = 86_400_000;
    const [tomorrow, inThree, inFour, past, archived, pinned] = await insertRows(owner, [
      { expiresAt: NOW + DAY },
      { expiresAt: NOW + 3 * DAY },
      { expiresAt: NOW + 3 * DAY + 1 },
      { expiresAt: NOW - 1 },
      { state: "archived", expiresAt: NOW + DAY },
      { pinned: true, expiresAt: null },
    ]);
    const soon = await ids(owner, { expiring: "soon" });
    expect(soon).toEqual([inThree, tomorrow]);
    for (const id of [inFour, past, archived, pinned]) expect(soon).not.toContain(id);
    // The window is the expiry notices' own (noticeWindowEnd), so the list holds what they count.
    expect(NOW + 3 * DAY).toBe(noticeWindowEnd(NOW));
    expect(await ids(owner, { expiring: "soon", search: "nothing like this" })).toEqual([]);
  });

  it("pages through the filtered artifacts once", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const rows = await insertRows(
      owner,
      Array.from({ length: 7 }, (_, i) => ({
        name: i % 2 === 0 ? `Even ${i}` : `Odd ${i}`,
        updatedAt: 3000 + Math.floor(i / 2),
      })),
    );
    const even = rows.filter((_, i) => i % 2 === 0);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = value(
        await listArtifacts(db(), {
          actor: personalActor(owner),
          cursor,
          limit: 2,
          filters: { search: "even" },
          now: NOW,
        }),
      );
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(even.length);
    expect(new Set(seen)).toEqual(new Set(even));
  });
});

describe("the activity of listed artifacts", () => {
  async function version(
    artifactId: string,
    number: number,
    values: Partial<typeof schema.versions.$inferInsert> = {},
  ) {
    const id = `ver_${artifactId}_${number}`;
    await db()
      .insert(schema.versions)
      .values({
        id,
        artifactId,
        number,
        authorId: "u_author",
        state: "committed",
        entrypoint: "index.html",
        publishedBytes: 100 * number,
        sourceBytes: 0,
        committedAt: NOW - 1000,
        ...values,
      });
    return id;
  }

  async function thread(
    artifactId: string,
    versionId: string,
    ownerId: string,
    values: { state?: "open" | "resolved"; changeSeq: number; updatedAt: number },
  ) {
    await db()
      .insert(schema.annotationThreads)
      .values({
        id: `th_${crypto.randomUUID()}`,
        artifactId,
        versionId,
        ownerId,
        authorId: "u_reviewer",
        target: "{}",
        targetBytes: 2,
        path: "index.html",
        ...values,
      });
  }

  it("counts retained versions, the current size, open threads and the last thread change", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const [busy, quiet] = await insertRows(owner, [{ name: "Busy" }, { name: "Quiet" }]);
    const id = busy as string;
    // Retained: the current one and a previous one inside its seven days. Not retained: a
    // previous one past them that pruning has not removed yet, and an unfinished upload.
    const kept = await version(id, 1, { supersededAt: NOW - 7 * 86_400_000 + 1000 });
    await version(id, 2, { supersededAt: NOW - 7 * 86_400_000 });
    await version(id, 3, { state: "uploading" });
    const current = await version(id, 4, { publishedBytes: 1500, sourceBytes: 250 });
    await db()
      .update(schema.artifacts)
      .set({ currentVersionId: current })
      .where(eq(schema.artifacts.id, id));
    await thread(id, current, owner, { changeSeq: 3, updatedAt: NOW - 300 });
    await thread(id, current, owner, { changeSeq: 2, updatedAt: NOW - 200 });
    await thread(id, current, owner, { state: "resolved", changeSeq: 1, updatedAt: NOW - 900 });
    // An earlier version's thread is not open on the current one, but its later change counts.
    await thread(id, kept, owner, { changeSeq: 9, updatedAt: NOW - 50 });

    const page = value(
      await listArtifacts(db(), { actor: personalActor(owner), limit: 10, now: NOW }),
    );
    const byId = new Map(page?.items.map((item) => [item.id, item.activity]));
    expect(byId.get(id)).toEqual({
      versions: 2,
      currentBytes: 1750,
      openThreads: 2,
      lastAnnotationAt: NOW - 50,
    });
    expect(byId.get(quiet as string)).toEqual({
      versions: 0,
      currentBytes: null,
      openThreads: 0,
      lastAnnotationAt: null,
    });

    // The previous version stops counting once its seven days are over.
    const later = value(
      await listArtifacts(db(), { actor: personalActor(owner), limit: 10, now: NOW + 1000 }),
    );
    expect(later?.items.find((item) => item.id === id)?.activity.versions).toBe(1);
  });

  it("never counts another artifact's versions or threads", async () => {
    const owner = `u_${crypto.randomUUID()}`;
    const [mine] = await insertRows(owner, [{ name: "Mine" }]);
    const [theirs] = await insertRows(`u_${crypto.randomUUID()}`, [{ name: "Theirs" }]);
    const other = await version(theirs as string, 1);
    await thread(theirs as string, other, "u_else", { changeSeq: 1, updatedAt: NOW });
    const own = await version(mine as string, 1);
    await db()
      .update(schema.artifacts)
      .set({ currentVersionId: own })
      .where(eq(schema.artifacts.id, mine as string));

    const page = value(
      await listArtifacts(db(), { actor: personalActor(owner), limit: 10, now: NOW }),
    );
    expect(page?.items.map((item) => item.activity)).toEqual([
      { versions: 1, currentBytes: 100, openThreads: 0, lastAnnotationAt: null },
    ]);
  });

  it.each([
    ["no filter", undefined],
    ["expiring=soon", { expiring: "soon" as const }],
  ])("reads every figure through an index, never a scan, with %s", async (_name, filters) => {
    const statements: { query: string; params: unknown[] }[] = [];
    const recording = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (query: string) => {
            const entry = { query, params: [] as unknown[] };
            statements.push(entry);
            const statement = target.prepare(query);
            return new Proxy(statement, {
              get(inner, property) {
                const value = Reflect.get(inner, property, inner);
                if (property === "bind") {
                  return (...params: unknown[]) => {
                    entry.params = params;
                    return value.apply(inner, params);
                  };
                }
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await listArtifacts(regionalDb(recording, globalDb(recording)), {
      actor: personalActor("u_plan"),
      limit: 10,
      filters,
      now: NOW,
    });
    // The owner's plan is read first; the list is the last statement.
    const last = statements.at(-1);
    if (!last) throw new Error("no statement");
    const plan = await env.DB.prepare(`explain query plan ${last.query}`)
      .bind(...last.params)
      .all<{ detail: string }>();
    const steps = plan.results.map((row) => row.detail);
    expect(steps.filter((step) => step.startsWith("SCAN"))).toEqual([]);
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.stringContaining("versions USING INDEX versions_artifact_state_idx"),
        expect.stringContaining(
          "annotation_threads USING COVERING INDEX annotation_threads_artifact_version_state_idx",
        ),
        expect.stringContaining(
          "annotation_threads USING INDEX annotation_threads_artifact_change_idx",
        ),
      ]),
    );
  });
});
