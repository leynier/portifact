// Fixtures shared by the comment retention tests (decision 0023): workspaces, artifacts,
// threads, saves and an in-memory bucket for the restore guard's mark.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY, WORKSPACE_POLICIES, type WorkspacePolicy } from "@portifact/contracts";
import { type Regions, regionsFromEnv, schema } from "@portifact/db";
import { policyOf } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { enforceCommentRetention } from "../src/comment-retention.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { previewWorkspacePolicy, setWorkspacePolicy } from "../src/workspace-policies.ts";
import { DAY, db, grantPlan, NOW, sha256, value } from "./fixtures.ts";

export const hex = () => crypto.randomUUID().replaceAll("-", "");
export const regions = (): Regions => regionsFromEnv(env);
export const NOTICE = WORKSPACE_POLICIES.retentionNoticeDays * DAY;
export const FROM = NOW + NOTICE;
export const retention = (
  days: number | null,
  extra: Partial<WorkspacePolicy> = {},
): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...extra,
  commentRetentionDays: days,
  commentRetentionFrom: null,
});
export const th = schema.annotationThreads;
export const m = schema.annotationMessages;

export async function person(name: string) {
  const id = `u_${hex()}`;
  const email = `${name.toLowerCase()}-${hex().slice(0, 8)}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name,
      email,
      emailVerified: true,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

export async function team(region: "default" | "eu" = "default") {
  const id = `ws_${hex()}`;
  const slug = `c${hex().slice(0, 20)}`;
  const t = {
    id,
    slug,
    region,
    admin: await person("Admin"),
    editor: await person("Editor"),
    member: await person("Member"),
  };
  await regions()
    .global.insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: t.admin.id, updatedAt: NOW, region });
  await regions()
    .global.insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: t.admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: t.member.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(id, "enterprise", { seats: 10 });
  return t;
}
export type Team = Awaited<ReturnType<typeof team>>;
export const home = (t: { region: "default" | "eu" }) => regions().get(t.region).db;
export const bucketOf = (t: { region: "default" | "eu" }) =>
  t.region === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS;

export async function publishIn(
  userId: string,
  ownerId: string,
  region: "default" | "eu" = "default",
  next?: { artifactId: string; baseVersionId: string; now: number },
) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const target = regions().get(region).db;
  const at = next?.now ?? NOW - 400 * DAY;
  const prepared = value(
    await preparePublish(target, {
      userId,
      targetOwnerId: ownerId,
      ...(next ? { artifactId: next.artifactId } : {}),
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: next?.baseVersionId ?? null,
      files: [
        {
          path: "index.html",
          kind: "published" as const,
          sha256: digest,
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: at,
    }),
  );
  const bucket = region === "eu" ? env.ARTIFACTS_EU : env.ARTIFACTS;
  await bucket.put(`objects/${ownerId}/${digest}`, body);
  return value(
    await commitPublish(target, bucket, {
      userId,
      sessionId: prepared.sessionId,
      now: at,
    }),
  );
}

/** A new version of `artifact` at `now`: its current version stops being current then. */
export const publishNext = (
  t: Team,
  artifact: { artifactId: string; versionId: string },
  now: number,
) =>
  publishIn(t.editor.id, t.id, t.region, {
    artifactId: artifact.artifactId,
    baseVersionId: artifact.versionId,
    now,
  });

/**
 * A thread written directly, with `messages` messages, last active `agoDays` before NOW. The
 * `annotation_usage` triggers count it as any thread.
 */
export async function thread(
  t: { id: string; region: "default" | "eu"; editor: { id: string } },
  artifact: { artifactId: string; versionId: string },
  options: { agoDays: number; state?: "open" | "resolved"; version?: string; messages?: number },
) {
  const id = `th_${hex()}`;
  const at = NOW - options.agoDays * DAY;
  const target = home(t);
  await target.insert(th).values({
    id,
    artifactId: artifact.artifactId,
    versionId: options.version ?? artifact.versionId,
    ownerId: t.id,
    authorId: t.editor.id,
    target: JSON.stringify({ schema: 1, path: "index.html", anchor: { kind: "document" } }),
    targetBytes: 60,
    path: "index.html",
    state: options.state ?? "resolved",
    messageCount: options.messages ?? 2,
    createdAt: at,
    updatedAt: at,
  });
  for (let i = 0; i < (options.messages ?? 2); i += 1) {
    await target.insert(m).values({
      id: `msg_${hex()}`,
      threadId: id,
      artifactId: artifact.artifactId,
      ownerId: t.id,
      authorId: t.editor.id,
      body: "x".repeat(10),
      bodyBytes: 10,
      createdAt: at,
    });
  }
  return id;
}

export async function exists(t: { region: "default" | "eu" }, id: string) {
  return (await home(t).select({ id: th.id }).from(th).where(eq(th.id, id))).length === 1;
}

export const preview = (t: Team, next: WorkspacePolicy, now = NOW) =>
  previewWorkspacePolicy(regions(), { userId: t.admin.id, slug: t.slug, policy: next, now });

export async function revision(t: Team) {
  const [row] = await regions()
    .global.select({ revision: schema.workspaces.policyRevision })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, t.id));
  return row?.revision ?? 0;
}

export async function save(
  t: Team,
  next: WorkspacePolicy,
  options: { now?: number; userId?: string; confirm?: boolean; via?: Regions } = {},
) {
  const now = options.now ?? NOW;
  const shown = options.confirm === false ? undefined : await preview(t, next, now);
  return setWorkspacePolicy(options.via ?? regions(), {
    userId: options.userId ?? t.admin.id,
    slug: t.slug,
    policy: next,
    revision: await revision(t),
    confirmed: shown?.ok ? shown.value : undefined,
    now,
  });
}

export async function stored(t: Team) {
  const [row] = await regions()
    .global.select({ policy: schema.workspaces.policy })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, t.id));
  return policyOf(row?.policy ?? null);
}

/**
 * An in-memory bucket for the guard records, which can refuse each operation and run a hook
 * around the next write. Each record carries R2's `uploaded` (the wall clock at its write, moved
 * back by `age`) and an etag that changes with every write, as the sweep reads them.
 */
export function memoryBucket(
  fail: { get?: boolean; put?: boolean; delete?: boolean; list?: boolean } = {},
  hooks: {
    beforeWrite?: () => Promise<void>;
    afterWrite?: () => Promise<void>;
    beforeDelete?: () => Promise<void>;
  } = {},
) {
  const held = new Map<string, { text: string; uploaded: number; etag: string }>();
  let reads = 0;
  let lists = 0;
  let writes = 0;
  const readsByKey = new Map<string, number>();
  const hook = async () => {
    const run = hooks.beforeWrite;
    delete hooks.beforeWrite;
    if (run) await run();
  };
  const bucket = {
    get: async (key: string) => {
      reads += 1;
      readsByKey.set(key, (readsByKey.get(key) ?? 0) + 1);
      if (fail.get) throw new Error("r2 unavailable");
      const seen = held.get(key);
      return seen === undefined ? null : { etag: seen.etag, text: async () => seen.text };
    },
    put: async (key: string, text: string) => {
      await hook();
      if (fail.put) throw new Error("r2 unavailable");
      writes += 1;
      held.set(key, { text, uploaded: Date.now(), etag: crypto.randomUUID() });
      const after = hooks.afterWrite;
      delete hooks.afterWrite;
      if (after) await after();
      return {};
    },
    delete: async (key: string) => {
      await hook();
      const before = hooks.beforeDelete;
      delete hooks.beforeDelete;
      if (before) await before();
      if (fail.delete ?? fail.put) throw new Error("r2 unavailable");
      held.delete(key);
      const after = hooks.afterWrite;
      delete hooks.afterWrite;
      if (after) await after();
    },
    list: async (options: { prefix?: string; limit?: number; startAfter?: string }) => {
      lists += 1;
      if (fail.list) throw new Error("r2 unavailable");
      const keys = [...held.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .filter((key) => options.startAfter === undefined || key > options.startAfter)
        .sort();
      const limit = options.limit ?? 1000;
      const page = keys.slice(0, limit);
      return {
        objects: page.map((key) => {
          const entry = held.get(key) as { uploaded: number; etag: string };
          return { key, uploaded: new Date(entry.uploaded), etag: entry.etag };
        }),
        truncated: keys.length > limit,
        delimitedPrefixes: [],
      };
    },
  };
  return Object.assign(bucket as unknown as R2Bucket, {
    held: (key: string) => held.get(key)?.text,
    keys: () => [...held.keys()],
    /** Moves every record's `uploaded` back by `ms`, as if written that long ago. */
    age: (ms: number) => {
      for (const entry of held.values()) entry.uploaded -= ms;
    },
    /** Writes a record as a write path would, with no hook (a test's setup). */
    plant: (key: string, text: string, agoMs = 0) => {
      held.set(key, { text, uploaded: Date.now() - agoMs, etag: crypto.randomUUID() });
    },
    reads: (key?: string) => (key === undefined ? reads : (readsByKey.get(key) ?? 0)),
    lists: () => lists,
    writes: () => writes,
    fail,
    hooks,
  });
}

export const scan = (t: { region: "default" | "eu" }, now: number) =>
  enforceCommentRetention(home(t), bucketOf(t), now, t.region);

export async function usage(t: { id: string; region: "default" | "eu" }) {
  const [row] = await home(t)
    .select({ messages: schema.annotationUsage.messages, bytes: schema.annotationUsage.bytes })
    .from(schema.annotationUsage)
    .where(eq(schema.annotationUsage.ownerId, t.id));
  return row;
}
