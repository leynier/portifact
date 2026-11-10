// A space's open feedback (premium plan T9): the listing is exactly the union of the per-artifact
// lists for the same caller, for every role, access mode, comment visibility, reader exception,
// artifact state and comment mode; a hidden thread never shows in items, counts or cursors; a
// token reads nothing; a workspace needs the `workspaces` feature.
import type { AnnotationThreadView } from "@portifact/contracts";
import { schema } from "@portifact/db";
import { decodeFeedbackCursor, encodeFeedbackCursor } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { listAnnotations } from "../src/annotations.ts";
import { type FeedbackInput, listOpenFeedback } from "../src/feedback.ts";
import { resolveOwnerScope } from "../src/workspaces.ts";
import { DAY, db, grantPlan, MINUTE, NOW, value } from "./fixtures.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const hex = () => crypto.randomUUID().replaceAll("-", "");

function newArtifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

async function person(verified = true) {
  const id = `u_${hex()}`;
  const email = `${id}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: `Name ${id.slice(2, 6)}`,
      email,
      emailVerified: verified,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

type AccessVariant = "public" | "authenticated" | "workspace" | "domain" | "restricted";
type Exception = "all" | "own" | null;

interface ArtifactSpec {
  ownerId: string;
  access?: AccessVariant;
  visibility?: "owner" | "everyone";
  state?: "active" | "archived" | "suspended" | "draft" | "expired";
  annotations?: "open" | "locked" | "off";
  /** Reader rows: email and exception. */
  readers?: { email: string; exception: Exception }[];
  createdBy?: string | null;
}

let clock = NOW - DAY;

/** An artifact with a current version (and an older one), inserted as the publish flow leaves it. */
async function artifact(spec: ArtifactSpec): Promise<{ id: string; version: string; old: string }> {
  const id = newArtifactId();
  const expired = spec.state === "expired";
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId: spec.ownerId,
      type: "site",
      name: `Doc ${id}`,
      state: spec.state === undefined || spec.state === "expired" ? "active" : spec.state,
      annotations: spec.annotations ?? "open",
      accessMode: spec.access ?? "restricted",
      commentVisibility: spec.visibility ?? "owner",
      createdBy: spec.createdBy ?? null,
      expiresAt: expired ? NOW - MINUTE : NOW + 30 * DAY,
      archivedAt: spec.state === "archived" ? NOW - DAY : null,
      createdAt: NOW - 2 * DAY,
      updatedAt: NOW - 2 * DAY,
    });
  const old = `${id}_v1`;
  const version = `${id}_v2`;
  for (const [number, versionId] of [
    [1, old],
    [2, version],
  ] as const) {
    await db().insert(schema.versions).values({
      id: versionId,
      artifactId: id,
      number,
      authorId: spec.ownerId,
      state: "committed",
      entrypoint: "index.html",
      publishedBytes: 10,
      committedAt: NOW,
    });
  }
  if (spec.state !== "draft") {
    await db()
      .update(schema.artifacts)
      .set({ currentVersionId: version })
      .where(eq(schema.artifacts.id, id));
  }
  for (const reader of spec.readers ?? []) {
    await db().insert(schema.artifactReaders).values({
      artifactId: id,
      email: reader.email,
      commentVisibility: reader.exception,
    });
  }
  return { id, version, old };
}

/** A thread with one message per author, written as the annotation services leave it. */
async function thread(
  art: { id: string; version: string },
  ownerId: string,
  authors: string[],
  options: { state?: "open" | "resolved"; versionId?: string; at?: number } = {},
): Promise<string> {
  clock += MINUTE;
  const at = options.at ?? clock;
  const id = crypto.randomUUID();
  const target = JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } });
  await db()
    .insert(schema.annotationThreads)
    .values({
      id,
      artifactId: art.id,
      versionId: options.versionId ?? art.version,
      ownerId,
      authorId: authors[0] as string,
      target,
      targetBytes: target.length,
      path: "index.html",
      state: options.state ?? "open",
      messageCount: authors.length,
      // A real thread's refresh cursor is the ID of the event that last changed it, never 0.
      changeSeq: (at - NOW + 10 * DAY) / 1000,
      resolvedAt: options.state === "resolved" ? at : null,
      createdAt: at,
      updatedAt: at,
    });
  for (const [index, authorId] of authors.entries()) {
    await db()
      .insert(schema.annotationMessages)
      .values({
        id: crypto.randomUUID(),
        threadId: id,
        artifactId: art.id,
        ownerId,
        authorId,
        body: `Message ${index}`,
        bodyBytes: 9,
        createdAt: at + index,
      });
  }
  return id;
}

interface Team {
  id: string;
  slug: string;
  admin: { id: string; email: string };
  editor: { id: string; email: string };
  member: { id: string; email: string };
  colleague: { id: string; email: string };
  unverified: { id: string; email: string };
}

async function team(plan: "team" | "free" = "team"): Promise<Team> {
  const id = `ws_${hex()}`;
  const slug = `f${hex().slice(0, 20)}`;
  const t: Team = {
    id,
    slug,
    admin: await person(),
    editor: await person(),
    member: await person(),
    colleague: await person(),
    unverified: await person(false),
  };
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: t.admin.id, updatedAt: NOW });
  const roles = [
    [t.admin, "admin"],
    [t.editor, "editor"],
    [t.member, "member"],
    [t.colleague, "member"],
    [t.unverified, "member"],
  ] as const;
  for (const [who, role] of roles) {
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId: who.id, role, updatedAt: NOW });
  }
  if (plan === "team") await grantPlan(id, "team");
  return t;
}

async function actorFor(userId: string, slug?: string) {
  return value(await resolveOwnerScope(db().global, userId, slug));
}

/** Every page of the space's feedback for `userId`. */
async function everyPage(
  userId: string,
  slug: string | undefined,
  extra: Partial<FeedbackInput> = {},
  limit = 7,
) {
  const actor = await actorFor(userId, slug);
  const items = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = value(
      await listOpenFeedback(db(), {
        actor,
        limit,
        now: NOW,
        ...extra,
        ...(cursor ? { cursor } : {}),
      }),
    );
    items.push(...page.items);
    if (page.nextCursor === null) return { items, cursors, role: page.role };
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/** The union of the per-artifact lists (current version, open threads) for `userId`. */
async function perArtifactUnion(userId: string, artifactIds: readonly string[]) {
  const threads = new Map<string, AnnotationThreadView & { artifactId: string }>();
  for (const artifactId of artifactIds) {
    let cursor: string | undefined;
    for (;;) {
      const page = await listAnnotations(db(), {
        userId,
        artifactId,
        limit: 50,
        version: "current",
        state: "open",
        now: NOW,
        ...(cursor ? { cursor } : {}),
      });
      if (!page.ok) break;
      for (const view of page.value.threads) threads.set(view.id, { ...view, artifactId });
      if (!page.value.hasMore) break;
      cursor = page.value.cursor;
    }
  }
  return threads;
}

const ACCESS: AccessVariant[] = ["public", "authenticated", "workspace", "domain", "restricted"];
const VISIBILITY = ["owner", "everyone"] as const;
const EXCEPTIONS: (Exception | "unlisted")[] = ["unlisted", null, "all", "own"];
const STATES = ["active", "archived", "suspended", "draft", "expired"] as const;
const MODES = ["open", "locked", "off"] as const;

/**
 * A workspace with an artifact for every access mode, comment visibility and reader exception of
 * `t.member`, and for every artifact state and comment mode, each with threads by an admin, the
 * member, a colleague (another member) and the editor, one of them resolved and one on the old
 * version.
 */
async function populated(t: Team) {
  const ids: string[] = [];
  const add = async (spec: Omit<ArtifactSpec, "ownerId">) => {
    const art = await artifact({ ownerId: t.id, createdBy: t.editor.id, ...spec });
    ids.push(art.id);
    await thread(art, t.id, [t.admin.id, t.colleague.id]);
    await thread(art, t.id, [t.member.id, t.admin.id]);
    await thread(art, t.id, [t.colleague.id]);
    await thread(art, t.id, [t.colleague.id, t.member.id]);
    await thread(art, t.id, [t.editor.id]);
    await thread(art, t.id, [t.colleague.id], { state: "resolved" });
    await thread(art, t.id, [t.admin.id], { versionId: art.old });
    return art;
  };
  for (const access of ACCESS) {
    for (const visibility of VISIBILITY) {
      for (const exception of EXCEPTIONS) {
        await add({
          access,
          visibility,
          readers: exception === "unlisted" ? [] : [{ email: t.member.email, exception }],
        });
      }
    }
  }
  for (const state of STATES) {
    for (const annotations of MODES) {
      await add({ access: "workspace", visibility: "everyone", state, annotations });
    }
  }
  return ids;
}

function comparable(item: { artifact: { id: string }; thread: AnnotationThreadView }) {
  return { ...item.thread, artifactId: item.artifact.id };
}

describe("listOpenFeedback equals the union of the per-artifact lists", () => {
  it("for every role, access mode, visibility, exception, state and comment mode", async () => {
    const t = await team();
    const ids = await populated(t);
    // An artifact of another owner that everyone may read and comment on never shows.
    const elsewhere = await artifact({
      ownerId: t.admin.id,
      access: "public",
      visibility: "everyone",
    });
    await thread(elsewhere, t.admin.id, [t.admin.id]);

    const sizes = new Map<string, number>();
    for (const who of [t.admin, t.editor, t.member, t.colleague, t.unverified]) {
      const listed = await everyPage(who.id, t.slug);
      sizes.set(who.id, listed.items.length);
      const union = await perArtifactUnion(who.id, ids);
      expect((await perArtifactUnion(who.id, [elsewhere.id])).size).toBe(1);
      const expected = [...union.values()].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      );
      expect(listed.items.map(comparable), who.email).toEqual(expected);
      expect(listed.items.some((item) => item.artifact.id === elsewhere.id)).toBe(false);
      expect(listed.role).toBe(who === t.admin || who === t.editor ? "owner" : "participant");

      // Counts and cursors name only what the caller sees.
      const perArtifact = new Map<string, number>();
      for (const item of listed.items) {
        perArtifact.set(item.artifact.id, (perArtifact.get(item.artifact.id) ?? 0) + 1);
      }
      for (const item of listed.items) {
        expect(item.counts.artifactOpenThreads).toBe(perArtifact.get(item.artifact.id));
        expect(item.counts.messages).toBe(item.thread.messages.length);
      }
      const shown = new Set(listed.items.map((item) => item.thread.id));
      for (const cursor of listed.cursors) {
        expect(shown.has(decodeFeedbackCursor(cursor)?.threadId ?? "")).toBe(true);
      }
    }
    // The table is not trivial: members see some threads, fewer than the owner side, and the
    // member with reader exceptions sees a different set from one without.
    const admin = sizes.get(t.admin.id) ?? 0;
    expect(sizes.get(t.editor.id)).toBe(admin);
    for (const member of [t.member, t.colleague, t.unverified]) {
      expect(sizes.get(member.id)).toBeGreaterThan(0);
      expect(sizes.get(member.id)).toBeLessThan(admin);
    }
    expect(sizes.get(t.member.id)).not.toBe(sizes.get(t.unverified.id));
  });

  it("in the personal space, where the user sees every open thread of their readable artifacts", async () => {
    const owner = await person();
    const reader = await person();
    const ids: string[] = [];
    for (const state of STATES) {
      for (const annotations of MODES) {
        const art = await artifact({
          ownerId: owner.id,
          state,
          annotations,
          readers: [{ email: reader.email, exception: null }],
        });
        ids.push(art.id);
        await thread(art, owner.id, [reader.id, owner.id]);
        await thread(art, owner.id, [owner.id], { state: "resolved" });
      }
    }
    const listed = await everyPage(owner.id, undefined, {}, 4);
    const union = await perArtifactUnion(owner.id, ids);
    expect(listed.items.map(comparable)).toEqual(
      [...union.values()].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      ),
    );
    // Archived (also past its expiry), suspended and locked or off artifacts keep their threads
    // for the owner; drafts have none.
    expect(new Set(listed.items.map((item) => item.artifact.id)).size).toBe(12);
    expect(listed.role).toBe("owner");

    // A reader's own personal space has none of the owner's threads.
    expect((await everyPage(reader.id, undefined)).items).toEqual([]);
  });
});

describe("filters", () => {
  it("since keeps threads with activity after the time", async () => {
    const owner = await person();
    const art = await artifact({ ownerId: owner.id });
    await thread(art, owner.id, [owner.id], { at: NOW - 3 * DAY });
    const recent = await thread(art, owner.id, [owner.id], { at: NOW - MINUTE });
    const listed = await everyPage(owner.id, undefined, { since: NOW - DAY });
    expect(listed.items.map((item) => item.thread.id)).toEqual([recent]);
    expect(listed.items[0]?.counts.artifactOpenThreads).toBe(1);
  });

  it("mine keeps threads the caller wrote in or on artifacts they published", async () => {
    const t = await team();
    const byEditor = await artifact({ ownerId: t.id, createdBy: t.editor.id });
    const byAdmin = await artifact({ ownerId: t.id, createdBy: t.admin.id });
    const onTheirs = await thread(byEditor, t.id, [t.admin.id]);
    const started = await thread(byAdmin, t.id, [t.editor.id]);
    const replied = await thread(byAdmin, t.id, [t.admin.id, t.editor.id]);
    await thread(byAdmin, t.id, [t.admin.id]);
    const listed = await everyPage(t.editor.id, t.slug, { mine: true });
    expect(new Set(listed.items.map((item) => item.thread.id))).toEqual(
      new Set([onTheirs, started, replied]),
    );
  });
});

describe("refusals", () => {
  it("a workspace without the workspaces feature is refused after authorization", async () => {
    const t = await team("free");
    const result = await listOpenFeedback(db(), {
      actor: await actorFor(t.member.id, t.slug),
      limit: 10,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, code: "plan_required" });
    // A free personal space needs no feature.
    const own = await listOpenFeedback(db(), {
      actor: await actorFor(t.member.id),
      limit: 10,
      now: NOW,
    });
    expect(own.ok).toBe(true);
  });

  it("a workspace the caller is not in answers like a missing one", async () => {
    const t = await team();
    const outsider = await person();
    const result = await resolveOwnerScope(db().global, outsider.id, t.slug);
    const missing = await resolveOwnerScope(db().global, outsider.id, `m${hex().slice(0, 20)}`);
    expect(result).toEqual(missing);
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  it("a service token reads no comments: an empty page, like every per-artifact list", async () => {
    const t = await team();
    const art = await artifact({ ownerId: t.id, access: "workspace", visibility: "everyone" });
    await thread(art, t.id, [t.admin.id]);
    const tokenId = `st_${hex()}`;
    await db()
      .insert(schema.serviceTokens)
      .values({
        id: tokenId,
        workspaceId: t.id,
        label: "CI",
        role: "editor",
        scopes: "artifacts:read",
        tokenHash: hex() + hex(),
        createdBy: t.admin.id,
        createdAt: NOW,
        expiresAt: NOW + DAY,
      });
    const actor = await actorFor(tokenId, t.slug);
    const page = value(await listOpenFeedback(db(), { actor, limit: 10, now: NOW }));
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    const perArtifact = await listAnnotations(db(), {
      userId: tokenId,
      artifactId: art.id,
      limit: 10,
      version: "current",
      now: NOW,
    });
    expect(perArtifact).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses cursors it did not make", async () => {
    const owner = await person();
    const actor = await actorFor(owner.id);
    for (const cursor of [
      "x",
      btoa("f1.not-a-uuid"),
      btoa(`a1.${crypto.randomUUID()}`),
      btoa(`f${"9".repeat(16)}.${crypto.randomUUID()}`),
      "%%%",
    ]) {
      const result = await listOpenFeedback(db(), { actor, cursor, limit: 10, now: NOW });
      expect(result, cursor).toMatchObject({ ok: false, code: "invalid_input" });
    }
  });
});

describe("cursors", () => {
  it("a crafted cursor at a hidden thread reveals nothing: it only positions the list", async () => {
    const t = await team();
    const art = await artifact({ ownerId: t.id, access: "workspace", visibility: "owner" });
    const first = await thread(art, t.id, [t.member.id]);
    const hidden = await thread(art, t.id, [t.colleague.id]);
    const last = await thread(art, t.id, [t.admin.id]);
    const [row] = await db()
      .select()
      .from(schema.annotationThreads)
      .where(eq(schema.annotationThreads.id, hidden));
    const cursor = encodeFeedbackCursor({
      updatedAt: row?.updatedAt as number,
      threadId: hidden,
    });
    const actor = await actorFor(t.member.id, t.slug);
    const page = value(await listOpenFeedback(db(), { actor, cursor, limit: 10, now: NOW }));
    expect(page.items.map((item) => item.thread.id)).toEqual([first]);
    const all = value(await listOpenFeedback(db(), { actor, limit: 10, now: NOW }));
    expect(all.items.map((item) => item.thread.id)).toEqual([last, first]);
  });

  it("stays stable when threads resolve between pages", async () => {
    const owner = await person();
    const art = await artifact({ ownerId: owner.id });
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await thread(art, owner.id, [owner.id]));
    const newestFirst = [...ids].reverse();
    const actor = await actorFor(owner.id);
    const first = value(await listOpenFeedback(db(), { actor, limit: 2, now: NOW }));
    expect(first.items.map((item) => item.thread.id)).toEqual(newestFirst.slice(0, 2));
    // One thread already shown and one not shown yet resolve.
    for (const id of [newestFirst[0], newestFirst[3]] as string[]) {
      await db()
        .update(schema.annotationThreads)
        .set({ state: "resolved", resolvedAt: NOW })
        .where(eq(schema.annotationThreads.id, id));
    }
    const rest = [];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = value(await listOpenFeedback(db(), { actor, cursor, limit: 2, now: NOW }));
      rest.push(...page.items.map((item) => item.thread.id));
      cursor = page.nextCursor;
    }
    expect(rest).toEqual([newestFirst[2], newestFirst[4], newestFirst[5]]);
  });
});
