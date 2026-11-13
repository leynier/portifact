// Acceptances in a region with its own database (decision 0005): the accepting person's role is
// a global row, so it is read again right before each batch (`stillActs`) and the batch fails
// closed on a refusal; a removal is seen at every boundary but the read-then-batch gap.
import { env } from "cloudflare:test";
import { aliasBinding, globalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { acceptSuggestion, publishDraft } from "../src/suggestion-accept.ts";
import { planDraft, planSuggestion } from "../src/suggestion-plans.ts";
import { submitSuggestion } from "../src/suggestions.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { NOW, sha256, user, value } from "./fixtures.ts";
import { raceGlobalBeforeStatement } from "./race.ts";
import { DOMAIN, humanCheck, JOB_DEPS, PAGE, textOp } from "./suggestion-support.ts";

const regions = () => regionsFromEnv(env);
const eu = () => regions().get("eu");
const SITE = { type: "site" as const, path: "index.html" };
const LISTED = PAGE.replace("</body>", "<script>1</script></body>");

/** An EU workspace with an editor who publishes a page and suggests on it. */
async function euSuggestion(body: string) {
  const admin = await user("Admin");
  const editor = await user("Editor");
  const slug = `se-${crypto.randomUUID().slice(0, 8)}`;
  const ws = value(
    await createWorkspace(regions().global, {
      slug,
      name: "EU",
      adminUserId: admin.id,
      now: NOW,
      region: "eu",
    }),
  );
  await regions()
    .global.insert(schema.ownerPlans)
    .values({ ownerId: ws.id, plan: "enterprise", seats: 5, grantedBy: "test", updatedAt: NOW });
  await regions()
    .global.insert(schema.workspaceMembers)
    .values({ workspaceId: ws.id, userId: editor.id, role: "editor", updatedAt: NOW });
  const digest = await sha256(body);
  const prepared = value(
    await preparePublish(eu().db, {
      userId: editor.id,
      targetOwnerId: ws.id,
      type: "site",
      name: "EU page",
      entrypoint: "index.html",
      baseVersionId: null,
      files: [
        {
          path: "index.html",
          kind: "published",
          sha256: digest,
          size: new TextEncoder().encode(body).length,
          contentType: "text/html",
        },
      ],
      now: NOW,
    }),
  );
  await env.ARTIFACTS_EU.put(`objects/${ws.id}/${digest}`, body);
  const committed = value(
    await commitPublish(eu().db, env.ARTIFACTS_EU, {
      userId: editor.id,
      sessionId: prepared.sessionId,
      now: NOW,
    }),
  );
  await eu()
    .db.update(schema.artifacts)
    .set({ annotations: "open" })
    .where(eq(schema.artifacts.id, committed.artifactId));
  const input = { userId: editor.id, artifactId: committed.artifactId, now: NOW + 10 };
  const threadId = value(
    await submitSuggestion(eu().db, {
      ...input,
      versionId: committed.versionId,
      edit: { operations: [textOp(SITE, body, "Second", "Next")] },
      body: "Fix",
      humanCheck,
    }),
  ).id;
  const plan = value(
    await planSuggestion(eu().db, env.ARTIFACTS_EU, { ...input, threadId, contentDomain: DOMAIN }),
  );
  const demote = () =>
    regions()
      .global.update(schema.workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, ws.id),
          eq(schema.workspaceMembers.userId, editor.id),
        ),
      );
  return {
    ws,
    editor,
    artifactId: committed.artifactId,
    versionId: committed.versionId,
    threadId,
    plan,
    input,
    demote,
  };
}

async function runEuJobs(topic: "suggestion_accept" | "draft_publish", artifactId: string) {
  const rows = await eu()
    .db.select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.topic, topic), eq(schema.outbox.subject, artifactId)));
  for (const row of rows) {
    await runJob(
      eu().db,
      env.ARTIFACTS_EU,
      { id: row.id, topic, region: "eu" },
      NOW + 2_000,
      JOB_DEPS,
    );
  }
}

/**
 * The EU handle whose global database counts its membership reads and runs `before` right before
 * the `fireAt`-th one.
 */
function membershipReads(fireAt: number, before: () => Promise<void>) {
  let seen = 0;
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values), query);
        if (prop === "run" || prop === "all" || prop === "raw" || prop === "first") {
          return async (...args: unknown[]) => {
            if (/from "workspace_members"/.test(query)) {
              seen++;
              if (seen === fireAt) await before();
            }
            // biome-ignore lint/suspicious/noExplicitAny: forwarding the D1 call as is
            return (target as any)[prop](...args);
          };
        }
        const member = Reflect.get(target, prop, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  const counted = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query), query);
      const member = Reflect.get(target, prop, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return {
    handle: regionalDb(env.DB_EU, globalDb(aliasBinding(counted, env.DB))),
    count: () => seen,
  };
}

async function runEuJobsOn(handle: ReturnType<typeof regionalDb>, artifactId: string) {
  const rows = await eu()
    .db.select()
    .from(schema.outbox)
    .where(
      and(eq(schema.outbox.topic, "suggestion_accept"), eq(schema.outbox.subject, artifactId)),
    );
  for (const row of rows) {
    await runJob(
      handle,
      env.ARTIFACTS_EU,
      { id: row.id, topic: "suggestion_accept", region: "eu" },
      NOW + 2_000,
      JOB_DEPS,
    );
  }
}

const threadOf = async (id: string) =>
  (
    await eu().db.select().from(schema.annotationThreads).where(eq(schema.annotationThreads.id, id))
  )[0];

describe("acceptances in a region with its own database", () => {
  it("publishes a version and lists items when the person still acts for the owner", async () => {
    const s = await euSuggestion(PAGE);
    value(
      await acceptSuggestion(eu().db, env.ARTIFACTS_EU, {
        ...s.input,
        threadId: s.threadId,
        digest: s.plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runEuJobs("suggestion_accept", s.artifactId);
    expect(await threadOf(s.threadId)).toMatchObject({ suggestionState: "accepted" });
    const l = await euSuggestion(LISTED);
    value(
      await acceptSuggestion(eu().db, env.ARTIFACTS_EU, {
        ...l.input,
        threadId: l.threadId,
        digest: l.plan.digest,
        contentDomain: DOMAIN,
      }),
    );
    await runEuJobs("suggestion_accept", l.artifactId);
    expect(await threadOf(l.threadId)).toMatchObject({
      suggestionState: "accepted",
      resultVersionId: null,
    });
  });

  it("refuses to start when the role is gone, read right before the batch", async () => {
    const s = await euSuggestion(PAGE);
    await s.demote();
    expect(
      await acceptSuggestion(eu().db, env.ARTIFACTS_EU, {
        ...s.input,
        threadId: s.threadId,
        digest: s.plan.digest,
        contentDomain: DOMAIN,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("ends a version acceptance and a listing one as revoked when the role went before the job", async () => {
    for (const body of [PAGE, LISTED]) {
      const s = await euSuggestion(body);
      value(
        await acceptSuggestion(eu().db, env.ARTIFACTS_EU, {
          ...s.input,
          threadId: s.threadId,
          digest: s.plan.digest,
          contentDomain: DOMAIN,
        }),
      );
      await s.demote();
      await runEuJobs("suggestion_accept", s.artifactId);
      expect(await threadOf(s.threadId)).toMatchObject({
        suggestionState: "pending",
        attemptReason: "revoked",
      });
    }
  });

  it("refuses a draft publish when the role is gone", async () => {
    const s = await euSuggestion(PAGE);
    const edit = JSON.stringify({ operations: [textOp(SITE, PAGE, "Second", "Next")] });
    await eu().db.insert(schema.editDrafts).values({
      artifactId: s.artifactId,
      userId: s.editor.id,
      ownerId: s.ws.id,
      baseVersionId: s.versionId,
      edit,
      editBytes: edit.length,
      updatedAt: NOW,
    });
    const input = { ...s.input, contentDomain: DOMAIN };
    const plan = value(await planDraft(eu().db, env.ARTIFACTS_EU, input));
    await s.demote();
    expect(
      await publishDraft(eu().db, env.ARTIFACTS_EU, { ...input, digest: plan.digest }),
    ).toMatchObject({ ok: false });
  });
});

/**
 * The EU region's handle whose global database demotes the editor right before the first
 * statement matching `pattern`: the window between the job's or route's checks and the re-read.
 */
function demotingAt(pattern: RegExp, demote: () => Promise<unknown>) {
  return regionalDb(
    env.DB_EU,
    raceGlobalBeforeStatement(pattern, async () => {
      await demote();
    }),
  );
}

describe("the re-read right before each batch", () => {
  it("refuses to start an acceptance when the role went after the route's checks", async () => {
    const s = await euSuggestion(PAGE);
    const raced = demotingAt(/platform_budget/, s.demote);
    expect(
      await acceptSuggestion(raced, env.ARTIFACTS_EU, {
        ...s.input,
        threadId: s.threadId,
        digest: s.plan.digest,
        contentDomain: DOMAIN,
      }),
    ).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
    expect(
      await eu()
        .db.select()
        .from(schema.acceptanceAttempts)
        .where(eq(schema.acceptanceAttempts.artifactId, s.artifactId)),
    ).toEqual([]);
  });

  it("ends the job as revoked when the role went after its checks, with or without a version", async () => {
    for (const body of [LISTED, PAGE]) {
      // An undisturbed run counts the job's membership reads; the last one is the re-read right
      // before the completing batch, after every check of the job passed.
      const probe = await euSuggestion(body);
      value(
        await acceptSuggestion(eu().db, env.ARTIFACTS_EU, {
          ...probe.input,
          threadId: probe.threadId,
          digest: probe.plan.digest,
          contentDomain: DOMAIN,
        }),
      );
      const counter = membershipReads(Number.POSITIVE_INFINITY, async () => {});
      await runEuJobsOn(counter.handle, probe.artifactId);
      expect(await threadOf(probe.threadId)).toMatchObject({ suggestionState: "accepted" });

      const s = await euSuggestion(body);
      value(
        await acceptSuggestion(eu().db, env.ARTIFACTS_EU, {
          ...s.input,
          threadId: s.threadId,
          digest: s.plan.digest,
          contentDomain: DOMAIN,
        }),
      );
      const raced = membershipReads(counter.count(), async () => {
        await s.demote();
      });
      await runEuJobsOn(raced.handle, s.artifactId);
      expect(await threadOf(s.threadId)).toMatchObject({
        suggestionState: "pending",
        attemptReason: "revoked",
      });
    }
  });
});

/** The EU bucket, running `before` once right before its first read: after authorization. */
function demotingOnRead(before: () => Promise<unknown>): R2Bucket {
  let fired = false;
  return new Proxy(env.ARTIFACTS_EU, {
    get(target, key) {
      if (key === "get") {
        return async (...args: Parameters<R2Bucket["get"]>) => {
          if (!fired) {
            fired = true;
            await before();
          }
          return target.get(...args);
        };
      }
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

describe("plan batches in a region with its own database", () => {
  const cached = (artifactId: string) =>
    eu()
      .db.select()
      .from(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, artifactId));

  it("refuses a suggestion's plan when the planner's role went while it was built", async () => {
    const s = await euSuggestion(PAGE);
    await eu()
      .db.delete(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, s.artifactId));
    const planned = await planSuggestion(eu().db, demotingOnRead(s.demote), {
      ...s.input,
      threadId: s.threadId,
      contentDomain: DOMAIN,
    });
    expect(planned).toMatchObject({ ok: false, code: "not_found" });
    expect(await cached(s.artifactId)).toEqual([]);
  });

  it("refuses a draft's plan when its author's role went while it was built", async () => {
    const s = await euSuggestion(PAGE);
    const edit = JSON.stringify({ operations: [textOp(SITE, PAGE, "Second", "Next")] });
    await eu().db.insert(schema.editDrafts).values({
      artifactId: s.artifactId,
      userId: s.editor.id,
      ownerId: s.ws.id,
      baseVersionId: s.versionId,
      edit,
      editBytes: edit.length,
      updatedAt: NOW,
    });
    await eu()
      .db.delete(schema.suggestionPlans)
      .where(eq(schema.suggestionPlans.artifactId, s.artifactId));
    const input = { ...s.input, contentDomain: DOMAIN };
    expect(await planDraft(eu().db, demotingOnRead(s.demote), input)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await cached(s.artifactId)).toEqual([]);
    // The control: undisturbed, the same draft plans and is cached.
    await regions()
      .global.update(schema.workspaceMembers)
      .set({ role: "editor" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, s.ws.id),
          eq(schema.workspaceMembers.userId, s.editor.id),
        ),
      );
    value(await planDraft(eu().db, env.ARTIFACTS_EU, input));
    expect(await cached(s.artifactId)).toHaveLength(1);
  });
});

describe("a domain reader's plan in a region with its own database", () => {
  async function euDomainReader() {
    const s = await euSuggestion(PAGE);
    const domain = `acme${crypto.randomUUID().slice(0, 8)}.com`;
    const domainId = `wd_${crypto.randomUUID()}`;
    await regions()
      .global.insert(schema.workspaceDomains)
      .values({
        id: domainId,
        workspaceId: s.ws.id,
        domain,
        token: "t",
        state: "verified",
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
        verifiedAt: NOW,
      });
    const reader = await user("Reader");
    await regions()
      .global.update(schema.users)
      .set({ email: `dana@${domain}`, emailVerified: true })
      .where(eq(schema.users.id, reader.id));
    await eu()
      .db.update(schema.artifacts)
      .set({ accessMode: "domain" })
      .where(eq(schema.artifacts.id, s.artifactId));
    const input = {
      userId: reader.id,
      artifactId: s.artifactId,
      now: NOW + 10,
      threadId: s.threadId,
      contentDomain: DOMAIN,
    };
    const unverify = () =>
      regions()
        .global.update(schema.workspaceDomains)
        .set({ state: "pending" })
        .where(eq(schema.workspaceDomains.id, domainId));
    const readerPlans = () =>
      eu()
        .db.select()
        .from(schema.suggestionPlans)
        .where(eq(schema.suggestionPlans.userId, reader.id));
    return { input, unverify, readerPlans };
  }

  it("plans while the domain is still verified (the control)", async () => {
    const s = await euDomainReader();
    value(await planSuggestion(eu().db, env.ARTIFACTS_EU, s.input));
    expect(await s.readerPlans()).toHaveLength(1);
  });

  it("refuses the plan when the domain loses verification while it was built", async () => {
    const s = await euDomainReader();
    expect(await planSuggestion(eu().db, demotingOnRead(s.unverify), s.input)).toMatchObject({
      ok: false,
    });
    expect(await s.readerPlans()).toEqual([]);
  });
});
