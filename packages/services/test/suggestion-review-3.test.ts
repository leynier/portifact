// The third adversarial review of the suggestion services (decision 0027), probes B1 to B7, D1 to
// D7 and E1: identity of the live standing check (another workspace, group or person keeps a
// qualifying fact while the relevant one goes), per-object stored-size caps, the finished-attempt
// partial index and the ordinary publish's call counts, plus the domain reader's identity.
import { env } from "cloudflare:test";
import { aliasBinding, globalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { and, eq, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { eraseAuthorFromThread, replyToAnnotationThread } from "../src/annotations.ts";
import { runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { acceptSuggestion, endAttempt, publishDraft } from "../src/suggestion-accept.ts";
import { retentionSweeps, sweepPage } from "../src/suggestion-maintenance.ts";
import {
  planDraft,
  planSuggestion,
  readStoredPage,
  storedFiles,
  storedReadCost,
} from "../src/suggestion-plans.ts";
import { runChangeListCheck, runSuggestionCarry } from "../src/suggestion-versions.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { rollbackArtifact } from "../src/versions.ts";
import { createWorkspace, deleteWorkspace } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, sha256, user, value } from "./fixtures.ts";
import { raceBeforeBatchWith } from "./race.ts";
import { recording } from "./recording.ts";
import {
  attempts,
  DOC,
  DOMAIN,
  humanCheck,
  JOB_DEPS,
  jobsOf,
  PAGE,
  publishDoc,
  republish,
  textOp,
  thread,
} from "./suggestion-support.ts";
import { publishVersion } from "./version-support.ts";

/** The value, which the test expects to be there. */
function the<T>(x: T | null | undefined): T {
  if (x === undefined || x === null) throw new Error("missing");
  return x;
}

// A deterministic boundary on either the global standing read or the regional batch.
function boundary(
  binding: D1Database,
  pattern: RegExp,
  before: () => Promise<void>,
  batchOnly = false,
) {
  let fired = false;
  const real = new WeakMap<object, D1PreparedStatement>(),
    queries = new WeakMap<object, string>();
  const fire = async () => {
    if (!fired) {
      fired = true;
      await before();
    }
  };
  const wrap = (s: D1PreparedStatement, q: string): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...v: unknown[]) => wrap(t.bind(...v), q);
        if (["all", "raw", "first", "run"].includes(String(k)))
          return async (...v: unknown[]) => {
            if (!batchOnly && pattern.test(q)) await fire(); // biome-ignore lint/suspicious/noExplicitAny: forwarding the D1 call as is
            return (t as any)[k](...v);
          };
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    real.set(p, s);
    queries.set(p, q);
    return p;
  };
  const proxy = new Proxy(binding, {
    get(t, k) {
      if (k === "prepare") return (q: string) => wrap(t.prepare(q), q);
      if (k === "batch")
        return async (ss: D1PreparedStatement[]) => {
          if (ss.some((s) => pattern.test(queries.get(s) ?? ""))) await fire();
          return t.batch(ss.map((s) => real.get(s) ?? s));
        };
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { binding: aliasBinding(proxy, binding), fired: () => fired };
}
async function setup(separate = false) {
  const regions = regionsFromEnv(env),
    e = {
      db: regions.get(separate ? "eu" : "default").db,
      bucket: separate ? env.ARTIFACTS_EU : env.ARTIFACTS,
    };
  const admin = await user("Admin"),
    editor = await user("Editor"),
    reader = await user("Reader"),
    author = await user("Author");
  const ws = value(
    await createWorkspace(regions.global, {
      slug: `r3-${crypto.randomUUID().slice(0, 8)}`,
      name: "Review",
      adminUserId: admin.id,
      region: separate ? "eu" : "default",
      now: NOW,
    }),
  );
  await grantPlan(ws.id, "team", { seats: 20 });
  for (const [who, role] of [
    [editor, "editor"],
    [reader, "member"],
  ] as const)
    await regions.global
      .insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: who.id, role, updatedAt: NOW });
  const hash = await sha256(DOC),
    p = value(
      await preparePublish(e.db, {
        userId: editor.id,
        targetOwnerId: ws.id,
        type: "markdown",
        name: "Versions",
        entrypoint: "index.md",
        baseVersionId: null,
        files: [
          {
            path: "index.md",
            kind: "published",
            sha256: hash,
            size: DOC.length,
            contentType: "text/markdown",
          },
        ],
        now: NOW,
      }),
    );
  await e.bucket.put(`objects/${ws.id}/${hash}`, DOC);
  const doc = {
    ...value(
      await commitPublish(e.db, e.bucket, { userId: editor.id, sessionId: p.sessionId, now: NOW }),
    ),
    type: "markdown" as const,
    path: "index.md",
  };
  await e.db
    .update(schema.artifacts)
    .set({ annotations: "open", accessMode: "public", commentVisibility: "everyone" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const input = {
    userId: editor.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    contentDomain: DOMAIN,
  };
  const edit = { operations: [textOp(doc, DOC, "Second", "Next")] };
  const view = value(
    await submitSuggestion(e.db, {
      ...input,
      userId: author.id,
      versionId: doc.versionId,
      edit,
      body: "Fix",
      humanCheck,
    }),
  );
  const serialized = JSON.stringify(edit);
  await e.db.insert(schema.editDrafts).values({
    artifactId: doc.artifactId,
    userId: editor.id,
    ownerId: ws.id,
    baseVersionId: doc.versionId,
    edit: serialized,
    editBytes: serialized.length,
    updatedAt: NOW,
  });
  return { regions, e, ws, admin, editor, reader, author, doc, input, view };
}
function planBoundary(
  s: Awaited<ReturnType<typeof setup>>,
  separate: boolean,
  change: () => Promise<void>,
) {
  const b = boundary(
    separate ? env.DB : env.DB,
    /as holds|insert into "suggestion_plans"/i,
    change,
    !separate,
  );
  return {
    handle: regionalDb(separate ? env.DB_EU : b.binding, globalDb(b.binding)),
    fired: b.fired,
  };
}
for (const separate of [false, true])
  for (const origin of ["suggestion", "draft"] as const)
    for (const change of ["demote", "remove", "delete-workspace"] as const) {
      it(`B1: owner plan ${origin} separate=${separate} ${change}`, async () => {
        const s = await setup(separate),
          b = planBoundary(s, separate, async () => {
            const m = schema.workspaceMembers;
            if (change === "demote")
              await s.regions.global
                .update(m)
                .set({ role: "member" })
                .where(and(eq(m.workspaceId, s.ws.id), eq(m.userId, s.editor.id)));
            else if (change === "remove")
              await s.regions.global
                .delete(m)
                .where(and(eq(m.workspaceId, s.ws.id), eq(m.userId, s.editor.id)));
            else value(await deleteWorkspace(s.regions, { workspaceId: s.ws.id, now: NOW + 20 }));
          });
        const result =
          origin === "draft"
            ? await planDraft(b.handle, s.e.bucket, s.input)
            : await planSuggestion(b.handle, s.e.bucket, { ...s.input, threadId: s.view.id });
        expect(b.fired()).toBe(true);
        expect(result).toMatchObject({ ok: false });
        expect(
          await s.e.db
            .select()
            .from(schema.suggestionPlans)
            .where(eq(schema.suggestionPlans.artifactId, s.doc.artifactId)),
        ).toEqual([]);
      });
    }
async function group(s: Awaited<ReturnType<typeof setup>>, listed = true) {
  const id = `wg_${crypto.randomUUID()}`;
  await s.regions.global
    .insert(schema.workspaceGroups)
    .values({ id, workspaceId: s.ws.id, name: id, createdAt: NOW, updatedAt: NOW });
  await s.regions.global.insert(schema.workspaceGroupMembers).values({
    id: `wgm_${crypto.randomUUID()}`,
    workspaceId: s.ws.id,
    groupId: id,
    userId: s.reader.id,
    createdAt: NOW,
  });
  if (listed)
    await s.e.db.insert(schema.artifactGroups).values({
      artifactId: s.doc.artifactId,
      groupId: id,
      commentVisibility: "all",
      createdAt: NOW,
    });
  return id;
}
for (const separate of [false, true])
  for (const change of [
    "member-removed",
    "group-deleted",
    "unlisted",
    "mode",
    "workspace-member",
    "other-group",
    "other-user",
    "other-listed-group",
  ] as const) {
    it(`B2: reader plan separate=${separate} ${change}`, async () => {
      const s = await setup(separate);
      await s.e.db
        .update(schema.artifacts)
        .set({
          commentVisibility: change === "workspace-member" ? "everyone" : "owner",
          accessMode: change === "workspace-member" ? "workspace" : "public",
        })
        .where(eq(schema.artifacts.id, s.doc.artifactId));
      const gid = change === "workspace-member" ? null : await group(s);
      if (change === "other-group") await group(s, false);
      if (change === "other-listed-group") {
        const other = await group(s);
        await s.e.db
          .update(schema.artifactGroups)
          .set({ commentVisibility: "own" })
          .where(eq(schema.artifactGroups.groupId, other));
      }
      if (change === "other-user")
        await s.regions.global.insert(schema.workspaceGroupMembers).values({
          id: `wgm_${crypto.randomUUID()}`,
          workspaceId: s.ws.id,
          groupId: the(gid),
          userId: s.editor.id,
          createdAt: NOW,
        });
      const b = planBoundary(s, separate, async () => {
        if (change === "group-deleted")
          await s.regions.global
            .delete(schema.workspaceGroups)
            .where(eq(schema.workspaceGroups.id, the(gid)));
        else if (change === "unlisted")
          await s.e.db
            .delete(schema.artifactGroups)
            .where(eq(schema.artifactGroups.groupId, the(gid)));
        else if (change === "mode")
          await s.e.db
            .update(schema.artifacts)
            .set({ accessMode: "restricted", policyGeneration: 2 })
            .where(eq(schema.artifacts.id, s.doc.artifactId));
        else if (change === "workspace-member")
          await s.regions.global
            .delete(schema.workspaceMembers)
            .where(
              and(
                eq(schema.workspaceMembers.workspaceId, s.ws.id),
                eq(schema.workspaceMembers.userId, s.reader.id),
              ),
            );
        else
          await s.regions.global
            .delete(schema.workspaceGroupMembers)
            .where(
              and(
                eq(schema.workspaceGroupMembers.groupId, the(gid)),
                eq(schema.workspaceGroupMembers.userId, s.reader.id),
              ),
            );
      });
      expect(
        await planSuggestion(b.handle, s.e.bucket, {
          ...s.input,
          userId: s.reader.id,
          threadId: s.view.id,
        }),
      ).toMatchObject({ ok: false });
      expect(b.fired()).toBe(true);
    });
  }
for (const separate of [false, true])
  it(`B3: a role on another workspace is not the plan's role separate=${separate}`, async () => {
    const s = await setup(separate);
    const other = value(
      await createWorkspace(s.regions.global, {
        slug: `r3-${crypto.randomUUID().slice(0, 8)}`,
        name: "Other",
        adminUserId: s.editor.id,
        region: separate ? "eu" : "default",
        now: NOW,
      }),
    );
    const b = planBoundary(s, separate, async () => {
      await s.regions.global
        .delete(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, s.ws.id),
            eq(schema.workspaceMembers.userId, s.editor.id),
          ),
        );
    });
    expect(await planDraft(b.handle, s.e.bucket, s.input)).toMatchObject({ ok: false });
    expect(other.id).not.toBe(s.ws.id);
  });
it("B4: personal owner and a suggestion author still plan without membership", async () => {
  const owner = await user("Owner"),
    reader = await user("Reader"),
    doc = await publishDoc(owner.id);
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public", commentVisibility: "owner" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const input = {
    userId: reader.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    contentDomain: DOMAIN,
  };
  const view = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  for (const userId of [owner.id, reader.id])
    expect(
      (await planSuggestion(db(), env.ARTIFACTS, { ...input, userId, threadId: view.id })).ok,
    ).toBe(true);
});
for (const origin of ["suggestion", "draft"] as const)
  it(`B5: EU ${origin} refusal releases everything and leaves no completion`, async () => {
    const s = await setup(true),
      params = { ...s.input, threadId: s.view.id },
      plan = value(
        await (origin === "draft"
          ? planDraft(s.e.db, s.e.bucket, params)
          : planSuggestion(s.e.db, s.e.bucket, params)),
      );
    value(
      await (origin === "draft" ? publishDraft : acceptSuggestion)(s.e.db, s.e.bucket, {
        ...params,
        digest: plan.digest,
      }),
    );
    let fired = false;
    const bucket = new Proxy(s.e.bucket, {
      get(t, k) {
        if (k === "put")
          return async (...a: Parameters<R2Bucket["put"]>) => {
            if (!fired && JSON.stringify(a[2]).includes("text/html")) {
              fired = true;
              await s.regions.global
                .delete(schema.workspaceMembers)
                .where(
                  and(
                    eq(schema.workspaceMembers.workspaceId, s.ws.id),
                    eq(schema.workspaceMembers.userId, s.editor.id),
                  ),
                );
            }
            return t.put(...a);
          };
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const topic = origin === "draft" ? "draft_publish" : "suggestion_accept",
      [job] = await jobsOf(topic, s.doc.artifactId, s.e.db);
    await runJob(s.e.db, bucket, { id: the(job).id, topic }, NOW + 2000, JOB_DEPS);
    expect(fired).toBe(true);
    const [attempt] = await s.e.db
      .select()
      .from(schema.acceptanceAttempts)
      .where(eq(schema.acceptanceAttempts.artifactId, s.doc.artifactId));
    expect(attempt).toMatchObject({ state: "ended", reason: "revoked" });
    expect(
      (
        await s.e.db
          .select()
          .from(schema.uploadSessions)
          .where(eq(schema.uploadSessions.versionId, the(the(attempt).versionId)))
      )[0]?.state,
    ).toBe("failed");
    const [usage] = await s.e.db
      .select()
      .from(schema.accountUsage)
      .where(eq(schema.accountUsage.ownerId, s.ws.id));
    expect(the(usage).openUploads).toBe(0);
    expect(the(usage).reservedBytes).toBe(0);
    expect(
      await s.e.db
        .select()
        .from(schema.uploadSessions)
        .where(
          and(
            eq(schema.uploadSessions.artifactId, s.doc.artifactId),
            sql`${schema.uploadSessions.state} in ('uploading','ready')`,
          ),
        ),
    ).toEqual([]);
    expect(
      await s.e.db
        .select()
        .from(schema.acceptanceClaims)
        .where(eq(schema.acceptanceClaims.attemptId, the(attempt).id)),
    ).toEqual([]);
    expect(
      await s.e.db
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.artifactId, s.doc.artifactId),
            eq(schema.versions.state, "committed"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await s.e.db
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.targetId, s.doc.artifactId),
            eq(schema.auditEvents.kind, "suggestion.accepted"),
          ),
        ),
    ).toEqual([]);
    if (origin === "suggestion")
      expect(
        (
          await s.e.db
            .select()
            .from(schema.annotationThreads)
            .where(eq(schema.annotationThreads.id, s.view.id))
        )[0]?.suggestionState,
      ).toBe("pending");
    else
      expect(
        (
          await s.e.db
            .select()
            .from(schema.editDrafts)
            .where(eq(schema.editDrafts.artifactId, s.doc.artifactId))
        )[0]?.attemptId,
      ).toBeNull();
    await endAttempt(s.e.db, the(attempt), "revoked", NOW + 3000);
    await endAttempt(s.e.db, the(attempt), "revoked", NOW + 4000);
    expect(
      (
        await s.e.db
          .select()
          .from(schema.accountUsage)
          .where(eq(schema.accountUsage.ownerId, s.ws.id))
      )[0]?.openUploads,
    ).toBe(0);
  });
it("B6: a crash after the final role check leaves a recoverable attempt", async () => {
  const s = await setup(true),
    params = { ...s.input, threadId: s.view.id },
    plan = value(await planSuggestion(s.e.db, s.e.bucket, params));
  value(await acceptSuggestion(s.e.db, s.e.bucket, { ...params, digest: plan.digest }));
  const [job] = await jobsOf("suggestion_accept", s.doc.artifactId, s.e.db);
  const b = boundary(
      env.DB_EU,
      /insert into "acceptance_claims"/,
      async () => {
        throw new Error("crash-before-batch");
      },
      true,
    ),
    handle = regionalDb(b.binding, s.regions.global),
    message = { id: the(job).id, topic: "suggestion_accept" as const };
  await expect(runJob(handle, s.e.bucket, message, NOW + 2000, JOB_DEPS)).rejects.toThrow(
    "crash-before-batch",
  );
  expect(
    (
      await s.e.db
        .select()
        .from(schema.acceptanceAttempts)
        .where(eq(schema.acceptanceAttempts.artifactId, s.doc.artifactId))
    )[0]?.state,
  ).toBe("running");
  await runJob(s.e.db, s.e.bucket, message, NOW + 3000, JOB_DEPS);
  await runJob(s.e.db, s.e.bucket, message, NOW + 4000, JOB_DEPS);
  expect(
    await s.e.db
      .select()
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.artifactId, s.doc.artifactId),
          eq(schema.versions.state, "committed"),
        ),
      ),
  ).toHaveLength(2);
  const [t] = await s.e.db
    .select()
    .from(schema.annotationThreads)
    .where(eq(schema.annotationThreads.id, s.view.id));
  expect(t?.suggestionState).toBe("accepted");
  expect(t?.resultVersionId).not.toBeNull();
  expect(
    (
      await s.e.db
        .select()
        .from(schema.accountUsage)
        .where(eq(schema.accountUsage.ownerId, s.ws.id))
    )[0]?.openUploads,
  ).toBe(0);
});
for (const delta of [-1, 0, 1])
  it(`B7: actual R2 size versus version_files delta=${delta}`, async () => {
    const owner = await user("Owner"),
      doc = await publishDoc(owner.id),
      [artifact] = await db()
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, doc.artifactId));
    const found = value(
      await storedFiles(db(), {
        artifact: the(artifact),
        versionId: doc.versionId,
        path: doc.path,
        contentDomain: DOMAIN,
      }),
    );
    found.file.size += delta;
    const result = value(
      await readStoredPage(env.ARTIFACTS, found, { artifact: the(artifact) }, false),
    );
    expect(result.read).toBe(delta < 0 ? 0 : DOC.length);
    expect(result.oversized).toBe(delta < 0);
    expect(result.read).toBeLessThanOrEqual(storedReadCost(found, false));
  });

for (const delta of [-1, 0, 1])
  for (const kind of ["carry", "closure"] as const)
    it(`D1: ${kind} remaining budget delta=${delta}`, async () => {
      const owner = await user("Owner"),
        paths = ["a.html", "b.html"],
        site = await publishVersion(owner.id, Object.fromEntries(paths.map((p) => [p, PAGE])), {
          entrypoint: "a.html",
        });
      const proof = JSON.stringify({
        unit: "utf16",
        start: 0,
        end: 1,
        before: "x",
        after: "y",
        shownBefore: "x",
        shownAfter: "y",
        nodeLeft: "",
        nodeRight: "",
        identity: [],
      });
      for (const path of paths) {
        if (kind === "carry")
          await db()
            .insert(schema.annotationThreads)
            .values({
              id: `r3-${path}-${site.artifactId}`,
              artifactId: site.artifactId,
              ownerId: owner.id,
              authorId: owner.id,
              versionId: site.versionId,
              path,
              target: "{}",
              targetBytes: 2,
              kind: "suggestion",
              suggestionState: "pending",
              suggestionRevision: 1,
              edit: '{"operations":[]}',
              editBytes: 17,
              updatedAt: NOW,
            });
        else
          await db()
            .insert(schema.changeItems)
            .values({
              id: `r3-${path}-${site.artifactId}`,
              artifactId: site.artifactId,
              ownerId: owner.id,
              origin: "draft",
              versionId: site.versionId,
              path,
              envelope: '{"format":1}',
              proof,
              bytes: 12 + proof.length,
              reason: "not_eligible",
            });
      }
      const next = await publishVersion(
        owner.id,
        Object.fromEntries(paths.map((p) => [p, PAGE.replace("Title", "Other")])),
        { base: site, entrypoint: "a.html", now: NOW + 1000 },
      );
      let bytes = 0,
        reads = 0;
      const b = new Proxy(env.ARTIFACTS, {
        get(t, k) {
          if (k === "get")
            return async (key: string) => {
              const o = await t.get(key);
              bytes += o?.size ?? 0;
              reads++;
              return o;
            };
          const v = Reflect.get(t, k, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const topic = kind === "carry" ? "suggestion_carry" : "change_list_check",
        [job] = await jobsOf(topic, site.artifactId);
      const unit = PAGE.length * (kind === "carry" ? 2 : 1),
        limit = 2 * unit + delta;
      await (kind === "carry" ? runSuggestionCarry : runChangeListCheck)(
        db(),
        b,
        the(job),
        NOW + 2000,
        DOMAIN,
        200,
        limit,
      );
      expect(bytes).toBe(delta < 0 ? unit : 2 * unit);
      expect(reads).toBe((delta < 0 ? 1 : 2) * (kind === "carry" ? 2 : 1));
      await db()
        .delete(schema.outbox)
        .where(eq(schema.outbox.id, the(job).id));
      const continuations = await jobsOf(topic, site.artifactId);
      expect(continuations).toHaveLength(delta < 0 ? 1 : 0);
      for (const j of continuations)
        await runJob(db(), b, { id: j.id, topic }, NOW + 3000, JOB_DEPS);
      expect(bytes).toBe(2 * unit);
      expect(reads).toBe(2 * (kind === "carry" ? 2 : 1));
      expect(await jobsOf(topic, site.artifactId)).toEqual([]);
    });
it("D2: a document carry never reads the stored rendering or block map", async () => {
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id),
    input = { userId: owner.id, artifactId: doc.artifactId, now: NOW + 10, contentDomain: DOMAIN };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  value(await planSuggestion(db(), env.ARTIFACTS, { ...input, threadId: t.id }));
  const next = await republish(owner.id, doc, DOC + "\n\nAdded.");
  let gets = 0;
  const b = new Proxy(env.ARTIFACTS, {
    get(t, k) {
      if (k === "get")
        return (...a: Parameters<R2Bucket["get"]>) => {
          gets++;
          return t.get(...a);
        };
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const [j] = await jobsOf("suggestion_carry", doc.artifactId);
  await runSuggestionCarry(db(), b, the(j), NOW + 2000, DOMAIN);
  expect(gets).toBe(2);
  expect((await thread(t.id))?.versionId).toBe(next.versionId);
});
for (const kind of ["rendered", "block_map"] as const)
  it(`D3: ${kind} read is capped by its version_files size`, async () => {
    const owner = await user("Owner"),
      doc = await publishDoc(owner.id),
      [artifact] = await db()
        .select()
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, doc.artifactId));
    const files = value(
      await storedFiles(db(), {
        artifact: the(artifact),
        versionId: doc.versionId,
        path: doc.path,
        contentDomain: DOMAIN,
      }),
    );
    if (kind === "rendered") the(files.rendered).size = 1;
    else the(files.blockMap).size = 1;
    const result = value(await readStoredPage(env.ARTIFACTS, files, { artifact: the(artifact) }));
    expect(result.read).toBe(
      files.file.size + (kind === "rendered" ? 0 : the(files.rendered).size),
    );
    if (kind === "rendered") expect(result.stored).toBeUndefined();
    else expect(result.stored?.blockMap).toBeNull();
  });
for (const name of [
  "suggestion_attempts_retention",
  "suggestion_items_retention",
  "suggestion_drafts_retention",
])
  it(`D4: excluded prefix ${name}`, async () => {
    const owner = await user("Owner"),
      doc = await publishDoc(owner.id),
      old = NOW - 400 * DAY;
    for (let i = 0; i < 300; i += 5) {
      const rows = Array.from({ length: 5 }, (_, j) => ({ i: i + j }));
      if (name === "suggestion_attempts_retention")
        await db()
          .insert(schema.acceptanceAttempts)
          .values(
            rows.map(({ i }) => ({
              id: `r3-prefix-${i}-${doc.artifactId}`,
              artifactId: doc.artifactId,
              ownerId: owner.id,
              origin: "draft" as const,
              userId: owner.id,
              digest: "a".repeat(64),
              baseVersionId: doc.versionId,
              createdAt: old,
              updatedAt: old,
            })),
          );
      else if (name === "suggestion_items_retention")
        await db()
          .insert(schema.changeItems)
          .values(
            rows.map(({ i }) => ({
              id: `r3-prefix-${i}-${doc.artifactId}`,
              artifactId: doc.artifactId,
              ownerId: owner.id,
              origin: "draft" as const,
              versionId: doc.versionId,
              path: "index.md",
              envelope: '{"format":1}',
              bytes: 12,
              reason: "not_eligible" as const,
              createdAt: old,
            })),
          );
      else
        await db()
          .insert(schema.editDrafts)
          .values(
            rows.map(({ i }) => ({
              artifactId: doc.artifactId,
              userId: `r3-${i}`,
              ownerId: owner.id,
              baseVersionId: doc.versionId,
              edit: "{}",
              editBytes: 2,
              attemptId: "running",
              updatedAt: old,
            })),
          );
    }
    const sweep = the(retentionSweeps(NOW).find((s) => s.name === name)),
      q = new SQLiteAsyncDialect().sqlToQuery(sweepPage(sweep, null, 20));
    const r = await env.DB.prepare(q.sql)
      .bind(...q.params)
      .all();
    const p = await env.DB.prepare("explain query plan " + q.sql)
      .bind(...q.params)
      .all();
    expect(r.results).toEqual([]);
    expect(r.meta.rows_read, JSON.stringify(p.results)).toBeLessThanOrEqual(20);
  });
async function prepared() {
  const owner = await user("Owner"),
    author = await user("Author"),
    doc = await publishDoc(owner.id);
  await db()
    .update(schema.artifacts)
    .set({ accessMode: "public", commentVisibility: "everyone" })
    .where(eq(schema.artifacts.id, doc.artifactId));
  const input = {
    userId: author.id,
    artifactId: doc.artifactId,
    now: NOW + 10,
    contentDomain: DOMAIN,
  };
  const t = value(
    await submitSuggestion(db(), {
      ...input,
      versionId: doc.versionId,
      edit: { operations: [textOp(doc, DOC, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  );
  value(
    await replyToAnnotationThread(db(), {
      ...input,
      userId: owner.id,
      threadId: t.id,
      body: "Keep",
      humanCheck,
    }),
  );
  const params = { ...input, userId: owner.id, threadId: t.id },
    p = value(await planSuggestion(db(), env.ARTIFACTS, params));
  value(await acceptSuggestion(db(), env.ARTIFACTS, { ...params, digest: p.digest }));
  const [job] = await jobsOf("suggestion_accept", doc.artifactId),
    message = { id: the(job).id, topic: "suggestion_accept" as const };
  const broken = new Proxy(env.ARTIFACTS, {
    get(t, k) {
      if (k === "put")
        return async () => {
          throw new Error("prepare-crash");
        };
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  await expect(runJob(db(), broken, message, NOW + 2000, JOB_DEPS)).rejects.toThrow(
    "prepare-crash",
  );
  return { owner, author, doc, t, message };
}
for (const order of ["erasure-first", "commit-first", "held"] as const)
  it(`D5: prepared upload ${order} and double endAttempt`, async () => {
    const s = await prepared(),
      erase = () =>
        eraseAuthorFromThread(db(), {
          authorId: s.author.id,
          threadId: s.t.id,
          now: NOW + 4000,
        }).then(() => {});
    if (order === "commit-first") {
      await runJob(db(), env.ARTIFACTS, s.message, NOW + 3000, JOB_DEPS);
      await erase();
    } else if (order === "erasure-first")
      await runJob(
        raceBeforeBatchWith(/insert into "acceptance_claims"/, erase),
        env.ARTIFACTS,
        s.message,
        NOW + 3000,
        JOB_DEPS,
      );
    else {
      const { suspendArtifact } = await import("../src/moderation.ts");
      const { placeLegalHold, releaseLegalHold, runHoldRelease } = await import(
        "../src/legal-holds.ts"
      );
      const { applyTombstones } = await import("../src/backups.ts");
      const { advanceAccountDeletion } = await import("../src/account-data.ts");
      const { regionsFromEnv } = await import("@portifact/db");
      const r = regionsFromEnv(env);
      value(
        await suspendArtifact(db(), {
          artifactId: s.doc.artifactId,
          reason: "spam",
          now: NOW + 2500,
        }),
      );
      value(
        await placeLegalHold(db(), {
          artifactId: s.doc.artifactId,
          ground: "court order",
          releaseAt: null,
          now: NOW + 2600,
        }),
      );
      await applyTombstones(
        r,
        [{ kind: "account", id: s.author.id, deletedAt: NOW + 2700 }],
        NOW + 2800,
      );
      for (let i = 0; i < 4; i++) await advanceAccountDeletion(r, s.author.id, NOW + 2900 + i);
      await releaseLegalHold(db(), { artifactId: s.doc.artifactId, now: NOW + 3000 });
      await runHoldRelease(db(), undefined, s.doc.artifactId, NOW + 4000);
    }
    const [a] = await attempts(s.doc.artifactId);
    for (let i = 0; i < 2; i++) await endAttempt(db(), the(a), "revoked", NOW + 5000 + i);
    expect(
      (
        await db()
          .select()
          .from(schema.accountUsage)
          .where(eq(schema.accountUsage.ownerId, s.owner.id))
      )[0]?.openUploads,
    ).toBe(0);
    expect((await thread(s.t.id))?.suggestionState).toBe(
      order === "commit-first" ? "accepted" : "withdrawn",
    );
    expect(
      await db()
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.artifactId, s.doc.artifactId),
            eq(schema.versions.state, "committed"),
          ),
        ),
    ).toHaveLength(order === "commit-first" ? 2 : 1);
  });
it("D6: two nested deliveries cannot publish two accepted versions", async () => {
  const s = await prepared();
  const raced = raceBeforeBatchWith(/insert into "acceptance_claims"/, async () => {
    await runJob(db(), env.ARTIFACTS, s.message, NOW + 3001, JOB_DEPS);
  });
  await runJob(raced, env.ARTIFACTS, s.message, NOW + 3000, JOB_DEPS);
  await runJob(db(), env.ARTIFACTS, s.message, NOW + 4000, JOB_DEPS);
  const versions = await db()
    .select()
    .from(schema.versions)
    .where(
      and(eq(schema.versions.artifactId, s.doc.artifactId), eq(schema.versions.state, "committed")),
    );
  expect(versions).toHaveLength(2);
  const t = await thread(s.t.id);
  expect(t?.suggestionState).toBe("accepted");
  expect(versions.map((v) => v.id)).toContain(t?.resultVersionId);
  expect(
    (
      await db()
        .select()
        .from(schema.accountUsage)
        .where(eq(schema.accountUsage.ownerId, s.owner.id))
    )[0]?.openUploads,
  ).toBe(0);
});
it("D7: 0079 upgrade preserves populated attempts, items and drafts and every trigger", async () => {
  const owner = await user("Owner"),
    doc = await publishDoc(owner.id),
    id = `upgrade-${doc.artifactId}`;
  await db()
    .insert(schema.acceptanceAttempts)
    .values({
      id,
      artifactId: doc.artifactId,
      ownerId: owner.id,
      origin: "draft",
      userId: owner.id,
      digest: "a".repeat(64),
      baseVersionId: doc.versionId,
      createdAt: NOW,
      updatedAt: NOW,
    });
  await db().insert(schema.changeItems).values({
    id,
    artifactId: doc.artifactId,
    ownerId: owner.id,
    origin: "draft",
    versionId: doc.versionId,
    path: doc.path,
    envelope: '{"format":1}',
    bytes: 12,
    reason: "not_eligible",
  });
  await db().insert(schema.editDrafts).values({
    artifactId: doc.artifactId,
    userId: owner.id,
    ownerId: owner.id,
    baseVersionId: doc.versionId,
    edit: "{}",
    editBytes: 2,
    updatedAt: NOW,
  });
  const tables = ["acceptance_attempts", "change_items", "edit_drafts"],
    before = [];
  for (const table of tables)
    before.push(
      (
        await env.DB.prepare(`select * from ${table} where artifact_id=?`)
          .bind(doc.artifactId)
          .all()
      ).results,
    );
  const triggers = (
    await env.DB.prepare(
      "select name,sql from sqlite_master where type='trigger' order by name",
    ).all()
  ).results;
  for (const name of [
    "change_items_closed_key_idx",
    "edit_drafts_unused_idx",
    "acceptance_attempts_running_created_idx",
    "acceptance_attempts_running_deliveries_idx",
    "acceptance_attempts_finished_created_idx",
  ])
    await env.DB.prepare(`drop index ${name}`).run();
  await env.DB.prepare(
    "create index change_items_closed_idx on change_items(closed_at) where closed_at is not null",
  ).run();
  await env.DB.prepare("create index edit_drafts_updated_idx on edit_drafts(updated_at)").run();
  const migration = the(
    env.TEST_MIGRATIONS.find((m: { name: string }) => m.name.startsWith("0079_")),
  );
  for (const q of migration.queries) await env.DB.prepare(q).run();
  for (let i = 0; i < tables.length; i++)
    expect(
      (
        await env.DB.prepare(`select * from ${tables[i]} where artifact_id=?`)
          .bind(doc.artifactId)
          .all()
      ).results,
    ).toEqual(before[i]);
  expect(
    (
      await env.DB.prepare(
        "select name,sql from sqlite_master where type='trigger' order by name",
      ).all()
    ).results,
  ).toEqual(triggers);
});

it("E1: normal publish and rollback D1 call counts", async () => {
  const owner = await user("Owner");
  const versions: { artifactId: string; versionId: string }[] = [];
  const counts: { prepare: number; commit: number }[] = [];
  for (const text of [PAGE, PAGE.replace("Title", "Other")]) {
    const hash = await sha256(text),
      r = recording();
    const prepared = value(
      await preparePublish(r.database, {
        userId: owner.id,
        type: "site",
        name: "Versions",
        entrypoint: "index.html",
        baseVersionId: versions.at(-1)?.versionId ?? null,
        ...(versions.length ? { artifactId: the(versions[0]).artifactId } : {}),
        files: [
          {
            path: "index.html",
            kind: "published",
            sha256: hash,
            size: text.length,
            contentType: "text/html",
          },
        ],
        now: NOW + 1000 * versions.length,
      }),
    );
    await env.ARTIFACTS.put(`objects/${owner.id}/${hash}`, text);
    const before = r.count();
    const committed = value(
      await commitPublish(r.database, env.ARTIFACTS, {
        userId: owner.id,
        sessionId: prepared.sessionId,
        now: NOW + 1000 * versions.length,
      }),
    );
    counts.push({ prepare: before, commit: r.count() - before });
    versions.push(committed);
  }
  const r = recording();
  value(
    await rollbackArtifact(r.database, {
      userId: owner.id,
      artifactId: the(versions[0]).artifactId,
      versionId: the(versions[0]).versionId,
      baseVersionId: the(versions[1]).versionId,
      now: NOW + 3000,
    }),
  );
  expect(r.count()).toBeGreaterThan(0);
  expect(counts.map((x) => x.commit)).toEqual([6, 6]);
});

describe("the domain standing names this workspace and this person", () => {
  async function domainReader(separate: boolean) {
    const s = await setup(separate);
    const domain = `acme${crypto.randomUUID().slice(0, 8)}.com`;
    const domainId = `wd_${crypto.randomUUID()}`;
    await s.regions.global.insert(schema.workspaceDomains).values({
      id: domainId,
      workspaceId: s.ws.id,
      domain,
      token: "t",
      state: "verified",
      createdAt: NOW,
      expiresAt: NOW + DAY,
      verifiedAt: NOW,
    });
    const reader = await user("Domain reader");
    const address = `dana@${domain}`;
    await s.regions.global
      .update(schema.users)
      .set({ email: address, emailVerified: true })
      .where(eq(schema.users.id, reader.id));
    await s.e.db
      .update(schema.artifacts)
      .set({ accessMode: "domain" })
      .where(eq(schema.artifacts.id, s.doc.artifactId));
    const input = { ...s.input, userId: reader.id, threadId: s.view.id };
    const plans = () =>
      s.e.db
        .select()
        .from(schema.suggestionPlans)
        .where(eq(schema.suggestionPlans.userId, reader.id));
    return { s, domain, domainId, reader, address, input, plans };
  }

  for (const separate of [false, true]) {
    it(`plans while the domain holds (the control), separate=${separate}`, async () => {
      const d = await domainReader(separate);
      value(await planSuggestion(d.s.e.db, d.s.e.bucket, d.input));
      expect(await d.plans()).toHaveLength(1);
    });

    it(`another workspace's verified domain of the same name does not hold it, separate=${separate}`, async () => {
      const d = await domainReader(separate);
      const other = value(
        await createWorkspace(d.s.regions.global, {
          slug: `r3d-${crypto.randomUUID().slice(0, 8)}`,
          name: "Other",
          adminUserId: d.s.admin.id,
          region: separate ? "eu" : "default",
          now: NOW,
        }),
      );
      const b = planBoundary(d.s, separate, async () => {
        await d.s.regions.global
          .delete(schema.workspaceDomains)
          .where(eq(schema.workspaceDomains.id, d.domainId));
        await d.s.regions.global.insert(schema.workspaceDomains).values({
          id: `wd_${crypto.randomUUID()}`,
          workspaceId: other.id,
          domain: d.domain,
          token: "t",
          state: "verified",
          createdAt: NOW,
          expiresAt: NOW + DAY,
          verifiedAt: NOW,
        });
      });
      expect(await planSuggestion(b.handle, d.s.e.bucket, d.input)).toMatchObject({ ok: false });
      expect(b.fired()).toBe(true);
      expect(await d.plans()).toEqual([]);
    });

    it(`another verified domain of the workspace does not hold it, separate=${separate}`, async () => {
      const d = await domainReader(separate);
      await d.s.regions.global.insert(schema.workspaceDomains).values({
        id: `wd_${crypto.randomUUID()}`,
        workspaceId: d.s.ws.id,
        domain: `other${crypto.randomUUID().slice(0, 8)}.com`,
        token: "t",
        state: "verified",
        createdAt: NOW,
        expiresAt: NOW + DAY,
        verifiedAt: NOW,
      });
      const b = planBoundary(d.s, separate, async () => {
        await d.s.regions.global
          .delete(schema.workspaceDomains)
          .where(eq(schema.workspaceDomains.id, d.domainId));
      });
      expect(await planSuggestion(b.handle, d.s.e.bucket, d.input)).toMatchObject({ ok: false });
      expect(b.fired()).toBe(true);
      expect(await d.plans()).toEqual([]);
    });

    it(`an address no longer verified does not hold it, separate=${separate}`, async () => {
      const d = await domainReader(separate);
      const b = planBoundary(d.s, separate, async () => {
        await d.s.regions.global
          .update(schema.users)
          .set({ emailVerified: false })
          .where(eq(schema.users.id, d.reader.id));
      });
      expect(await planSuggestion(b.handle, d.s.e.bucket, d.input)).toMatchObject({ ok: false });
      expect(b.fired()).toBe(true);
      expect(await d.plans()).toEqual([]);
    });

    it(`a member of a domain artifact's workspace loses it with the membership, separate=${separate}`, async () => {
      const d = await domainReader(separate);
      // The workspace's member, whose address is at no verified domain, reads through the membership.
      const input = { ...d.input, userId: d.s.reader.id };
      const b = planBoundary(d.s, separate, async () => {
        await d.s.regions.global
          .delete(schema.workspaceMembers)
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, d.s.ws.id),
              eq(schema.workspaceMembers.userId, d.s.reader.id),
            ),
          );
      });
      expect(await planSuggestion(b.handle, d.s.e.bucket, input)).toMatchObject({ ok: false });
      expect(b.fired()).toBe(true);
    });

    it(`another person holding the address does not hold it, separate=${separate}`, async () => {
      const d = await domainReader(separate);
      const someone = await user("Someone");
      const b = planBoundary(d.s, separate, async () => {
        await d.s.regions.global
          .update(schema.users)
          .set({ email: `dana@elsewhere-${crypto.randomUUID().slice(0, 6)}.org` })
          .where(eq(schema.users.id, d.reader.id));
        await d.s.regions.global
          .update(schema.users)
          .set({ email: d.address, emailVerified: true })
          .where(eq(schema.users.id, someone.id));
      });
      expect(await planSuggestion(b.handle, d.s.e.bucket, d.input)).toMatchObject({ ok: false });
      expect(b.fired()).toBe(true);
      expect(await d.plans()).toEqual([]);
    });
  }
});
