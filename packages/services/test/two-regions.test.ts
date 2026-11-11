// A workspace in the EU region, end to end through the services (decision 0005, "Two-region
// audit"). The EU region here is its own control database, access log database and bucket, and
// the region guard is strict (REGION_GUARD), so a statement that reaches the wrong database fails
// the test instead of working by accident.
import { env } from "cloudflare:test";
import { type AnnotationTarget, DEFAULT_POLICY, type JobMessage } from "@portifact/contracts";
import { accessSchema, aliasBinding, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { entitlements, personalActor } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { recordOpenings } from "../src/access-log.ts";
import { requestAccountDeletion } from "../src/account-data.ts";
import { actorOn, artifactHandles } from "../src/actors.ts";
import { recordViews } from "../src/analytics.ts";
import {
  createAnnotationThread,
  getAnnotationThread,
  type HumanCheck,
} from "../src/annotations.ts";
import { requestApprovalReview, submitApprovalVerdict } from "../src/approval-reviews.ts";
import { listArtifacts } from "../src/artifacts.ts";
import { exportAuditLog, getAuditLog } from "../src/audit.ts";
import {
  applyIntegrationTombstones,
  applyTombstones,
  exportTombstones,
  rebuildArtifactDirectory,
  reconcileStorage,
} from "../src/backups.ts";
import { measurePlatformUsage } from "../src/budget.ts";
import { integrationKeys } from "../src/integration-keys.ts";
import {
  createIntegrationConnection,
  listIntegrationChoices,
  removeIntegrationConnection,
} from "../src/integrations.ts";
import { pruneVersions, runMaintenance, runRegionalMaintenance } from "../src/maintenance.ts";
import { relayOutbox, runJob } from "../src/outbox.ts";
import {
  alignPlanLimits,
  getOwnerPlan,
  HALF_APPLIED,
  removeOwnerPlan,
  setOwnerPlan,
} from "../src/plans.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { issueReadHandoff, redeemReadHandoff, refreshReadSession } from "../src/read-access.ts";
import type { ReviewNotifier } from "../src/review-notices.ts";
import { createShareLink, openShareLink } from "../src/share-links.ts";
import { FakeIssueTrackers } from "../src/testing/fake-issue-trackers.ts";
import { requestThreadIssue } from "../src/thread-issues.ts";
import { transferArtifact } from "../src/transfer.ts";
import { webhookKeys } from "../src/webhook-keys.ts";
import { createWebhook, removeWebhook, sendTestEvent, type WebhookDeps } from "../src/webhooks.ts";
import { createWorkspace, deleteWorkspace, resolveOwnerScope } from "../src/workspaces.ts";
import { DAY, NOW, publishSite, session, sha256, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite, raceBeforeStatementIn } from "./race.ts";

const regions = () => regionsFromEnv(env);
const eu = () => regions().get("eu");
const home = () => regions().get("default");
const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };

/** An enterprise workspace created in the EU region, with an admin and a member. */
async function euWorkspace() {
  const admin = await user("Admin");
  const member = await user("Member");
  const slug = `eu-${crypto.randomUUID().slice(0, 8)}`;
  const created = await createWorkspace(regions().global, {
    slug,
    name: "EU team",
    adminUserId: admin.id,
    now: NOW,
    region: "eu",
  });
  if (!created.ok) throw new Error(created.message);
  const ws = created.value;
  // Arranged directly in the global database: plans and memberships are global.
  await regions()
    .global.insert(schema.ownerPlans)
    .values({ ownerId: ws.id, plan: "enterprise", seats: 5, grantedBy: "test", updatedAt: NOW });
  await regions()
    .global.insert(schema.workspaceMembers)
    .values({ workspaceId: ws.id, userId: member.id, role: "member", updatedAt: NOW });
  return { ws, admin, member, slug };
}

/** Publishes a one-page site for the EU workspace, through the EU region's database and bucket. */
async function publishInEu(ownerId: string, adminId: string) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const prepared = await preparePublish(eu().db, {
    userId: adminId,
    targetOwnerId: ownerId,
    type: "site",
    name: "EU plan",
    entrypoint: "index.html",
    baseVersionId: null,
    files: [
      {
        path: "index.html",
        kind: "published",
        sha256: digest,
        size: body.length,
        contentType: "text/html",
      },
    ],
    now: NOW,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  await env.ARTIFACTS_EU.put(`objects/${ownerId}/${digest}`, body);
  const committed = await commitPublish(eu().db, env.ARTIFACTS_EU, {
    userId: adminId,
    sessionId: prepared.value.sessionId,
    now: NOW,
  });
  if (!committed.ok) throw new Error(committed.message);
  return { ...committed.value, digest };
}

async function artifactIn(db: ReturnType<typeof eu>["db"], id: string) {
  const [row] = await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  return row;
}

describe("a workspace in the EU region", () => {
  it("is created in eu, and its region never changes", async () => {
    const { ws } = await euWorkspace();
    expect(ws.region).toBe("eu");
    await expect(
      regions()
        .global.update(schema.workspaces)
        .set({ region: "default" })
        .where(eq(schema.workspaces.id, ws.id)),
    ).rejects.toThrow();
  });

  it("publishes into the EU database and bucket, and the directory says where", async () => {
    const { ws, admin } = await euWorkspace();
    const { artifactId, digest } = await publishInEu(ws.id, admin.id);
    expect(await artifactIn(eu().db, artifactId)).toMatchObject({
      ownerId: ws.id,
      state: "active",
    });
    expect(await artifactIn(home().db, artifactId)).toBeUndefined();
    expect((await artifactHandles(regions(), artifactId))?.region).toBe("eu");
    expect(await env.ARTIFACTS_EU.head(`objects/${ws.id}/${digest}`)).not.toBeNull();
    expect(await env.ARTIFACTS.head(`objects/${ws.id}/${digest}`)).toBeNull();
    // The regional usage row is the EU database's.
    const [usage] = await eu()
      .db.select()
      .from(schema.accountUsage)
      .where(eq(schema.accountUsage.ownerId, ws.id));
    expect(usage?.activeArtifacts).toBe(1);
  });

  it("keeps comments, openings and views in the EU databases", async () => {
    const { ws, admin, member } = await euWorkspace();
    const { artifactId, versionId } = await publishInEu(ws.id, admin.id);
    await eu()
      .db.update(schema.artifacts)
      .set({ accessMode: "workspace", annotations: "open" })
      .where(eq(schema.artifacts.id, artifactId));
    const thread = await createAnnotationThread(eu().db, {
      humanCheck: HUMAN,
      userId: member.id,
      artifactId,
      versionId,
      target: DOC,
      body: "From the EU",
      now: NOW,
    });
    expect(thread.ok).toBe(true);
    const threads = (db: ReturnType<typeof eu>["db"]) =>
      db
        .select()
        .from(schema.annotationThreads)
        .where(eq(schema.annotationThreads.artifactId, artifactId));
    expect(await threads(eu().db)).toHaveLength(1);
    expect(await threads(home().db)).toHaveLength(0);

    const euAccess = eu().accessDb;
    if (!euAccess) throw new Error("no EU access log");
    await eu()
      .db.update(schema.artifacts)
      .set({ accessMode: "restricted" })
      .where(eq(schema.artifacts.id, artifactId));
    await recordOpenings(eu().db, euAccess, [{ artifactId, userId: member.id, at: NOW }]);
    await recordViews(regions().global, euAccess, [
      {
        artifactId,
        ownerId: ws.id,
        day: NOW - (NOW % DAY),
        anonymous: 2,
        signedIn: {},
        expiresAt: NOW + DAY,
      },
    ]);
    const openings = await euAccess
      .select()
      .from(accessSchema.accessEvents)
      .where(eq(accessSchema.accessEvents.artifactId, artifactId));
    expect(openings).toHaveLength(1);
    const homeAccess = home().accessDb;
    if (!homeAccess) throw new Error("no access log");
    expect(
      await homeAccess
        .select()
        .from(accessSchema.accessEvents)
        .where(eq(accessSchema.accessEvents.artifactId, artifactId)),
    ).toHaveLength(0);
    const views = await euAccess
      .select()
      .from(accessSchema.artifactViews)
      .where(eq(accessSchema.artifactViews.artifactId, artifactId));
    expect(views.map((row) => row.views)).toEqual([2]);
  });

  it("opens a share link from the token alone, looking in every region", async () => {
    const { ws, admin } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    const created = await createShareLink(eu().db, {
      userId: admin.id,
      artifactId,
      label: "For a client",
      expiresAt: null,
      password: undefined,
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);
    const opened = await openShareLink(
      regions()
        .all()
        .map((handles) => handles.db),
      {
        token: created.value.token,
        now: NOW,
        contentDomain: "portifact.dev",
        customDomains: false,
      },
    );
    expect(opened).toMatchObject({ kind: "opened", artifactId });
  });

  it("issues, redeems and renews a read session in the EU database, checking the app session globally", async () => {
    const { ws, admin, member } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    await eu()
      .db.update(schema.artifacts)
      .set({ accessMode: "workspace" })
      .where(eq(schema.artifacts.id, artifactId));
    const authSessionId = await session(member.id);
    const issued = await issueReadHandoff(eu().db, {
      customDomains: false,
      confirmed: false,
      artifactId,
      userId: member.id,
      authSessionId,
      state: "nonce",
      now: NOW,
      requestedHost: null,
      contentDomain: "portifact.dev",
    });
    if (!issued.ok) throw new Error(issued.code);
    const host = `${artifactId}.portifact.dev`;
    const redeemed = await redeemReadHandoff(eu().db, {
      code: issued.value.code,
      artifactId,
      states: ["nonce"],
      host,
      devHost: host,
      now: NOW + 1,
    });
    if (!redeemed.ok) throw new Error(redeemed.code);
    const input = { sessionId: redeemed.value.sessionId, artifactId, now: NOW + 2 };
    expect((await refreshReadSession(eu().db, input)).ok).toBe(true);
    // Signing out deletes the global session: the regional read session renews no more.
    await regions().global.delete(schema.sessions).where(eq(schema.sessions.id, authSessionId));
    expect((await refreshReadSession(eu().db, input)).ok).toBe(false);
  });

  it("refuses moving an artifact to another region, with the same error everywhere", async () => {
    const { ws, admin } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    const moved = await transferArtifact(eu().db, env.ARTIFACTS_EU, {
      userId: admin.id,
      artifactId,
      workspace: null,
      now: NOW,
    });
    expect(moved).toMatchObject({ ok: false, code: "invalid_input" });
    expect(moved.ok ? "" : moved.message).toBe("An artifact cannot move between regions.");
    expect(await artifactIn(eu().db, artifactId)).toMatchObject({ ownerId: ws.id });
  });

  it("moves an artifact between two EU workspaces", async () => {
    const source = await euWorkspace();
    const target = await euWorkspace();
    await regions().global.insert(schema.workspaceMembers).values({
      workspaceId: target.ws.id,
      userId: source.admin.id,
      role: "admin",
      updatedAt: NOW,
    });
    const { artifactId } = await publishInEu(source.ws.id, source.admin.id);
    const moved = await transferArtifact(eu().db, env.ARTIFACTS_EU, {
      userId: source.admin.id,
      artifactId,
      workspace: target.slug,
      now: NOW,
    });
    expect(moved).toMatchObject({ ok: true, value: { ownerId: target.ws.id } });
  });

  it("deletes an account in the default region that commented in the EU, in every region", async () => {
    const { ws, admin, member } = await euWorkspace();
    const { artifactId, versionId } = await publishInEu(ws.id, admin.id);
    await eu()
      .db.update(schema.artifacts)
      .set({ accessMode: "workspace", annotations: "open" })
      .where(eq(schema.artifacts.id, artifactId));
    const thread = await createAnnotationThread(eu().db, {
      humanCheck: HUMAN,
      userId: member.id,
      artifactId,
      versionId,
      target: DOC,
      body: "Mine, to be erased",
      now: NOW,
    });
    expect(thread.ok).toBe(true);
    const sessionId = await session(member.id);
    const deleted = await requestAccountDeletion(regions(), {
      userId: member.id,
      sessionId,
      confirmEmail: member.email,
      now: NOW,
    });
    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    // The user and its membership are gone globally at once.
    const [gone] = await regions()
      .global.select()
      .from(schema.users)
      .where(eq(schema.users.id, member.id));
    expect(gone).toBeUndefined();
    // The job erases its words in the EU (one run), then finishes with a tombstone (the next).
    await runMaintenance(home().db, env.ARTIFACTS, NOW + 1, regions());
    await runMaintenance(home().db, env.ARTIFACTS, NOW + 2, regions());
    const messages = await eu()
      .db.select({ body: schema.annotationMessages.body })
      .from(schema.annotationMessages)
      .where(eq(schema.annotationMessages.authorId, member.id));
    expect(messages.map((row) => row.body)).not.toContain("Mine, to be erased");
    const [tombstone] = await regions()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, member.id));
    expect(tombstone).toMatchObject({ kind: "account" });
  });

  it("keeps issue connections and issue links in the EU database, tombstones in the global one", async () => {
    const { ws, admin, member } = await euWorkspace();
    const { artifactId, versionId } = await publishInEu(ws.id, admin.id);
    await eu()
      .db.update(schema.artifacts)
      .set({ accessMode: "workspace", annotations: "open" })
      .where(eq(schema.artifacts.id, artifactId));
    const thread = await createAnnotationThread(eu().db, {
      humanCheck: HUMAN,
      userId: member.id,
      artifactId,
      versionId,
      target: DOC,
      body: "From the EU",
      now: NOW,
    });
    if (!thread.ok) throw new Error(thread.message);
    const fake = new FakeIssueTrackers().github("ghp_eu_token_with_enough_characters", "eu-bot", [
      "acme/site",
    ]);
    const keys = await integrationKeys({ current: "test-only integrations key for the EU test" });
    const actor = {
      userId: admin.id,
      ownerId: ws.id,
      role: "admin" as const,
      region: "eu" as const,
    };
    const connection = await createIntegrationConnection(eu().db, {
      actor,
      connection: {
        service: "github",
        label: "EU repo",
        credential: "ghp_eu_token_with_enough_characters",
        targets: ["acme/site"],
      },
      deps: { keys, service: { enabled: true }, fetch: fake.fetch },
      now: NOW,
    });
    if (!connection.ok) throw new Error(connection.message);
    const rows = (db: ReturnType<typeof eu>["db"]) =>
      db
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.ownerId, ws.id));
    expect(await rows(eu().db)).toHaveLength(1);
    expect(await rows(home().db)).toHaveLength(0);
    // The dialog says comment text leaves the EU for such an owner.
    const choices = await listIntegrationChoices(eu().db, {
      actor,
      service: { enabled: true },
      now: NOW,
    });
    expect(choices.ok && choices.value.euResidency).toBe(true);
    const issue = await requestThreadIssue(eu().db, {
      userId: admin.id,
      artifactId,
      threadId: thread.value.id,
      request: {
        connectionId: connection.value.id,
        target: "acme/site",
        title: "From the EU",
        include: { link: true, artifactName: true, quote: false, message: true },
      },
      idempotencyKey: crypto.randomUUID(),
      service: { enabled: true },
      now: NOW,
    });
    if (!issue.ok) throw new Error(issue.message);
    const sent: JobMessage[] = [];
    const queue = {
      sendBatch: async (messages: { body: JobMessage }[]) => {
        sent.push(...messages.map((message) => message.body));
      },
    } as unknown as Queue<JobMessage>;
    await relayOutbox(eu().db, queue, NOW + 1, 5, "eu");
    const job = sent.find((message) => message.topic === "thread_issue");
    expect(job?.region).toBe("eu");
    if (!job) throw new Error("no issue job");
    expect(
      await runJob(eu().db, env.ARTIFACTS_EU, job, NOW + 2, {
        issues: { keys, fetch: fake.fetch, appOrigin: "https://app.portifact.test", enabled: true },
      }),
    ).toBe("done");
    expect(fake.issues.map((i) => i.body)).toEqual([expect.stringContaining("From the EU")]);
    const view = await getAnnotationThread(eu().db, {
      userId: member.id,
      artifactId,
      threadId: thread.value.id,
      now: NOW + 3,
    });
    expect(view.ok && view.value.issues?.[0]).toMatchObject({ state: "created", key: "#1" });
    const [snapshot] = await eu()
      .db.select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connection.value.id));
    expect(
      await removeIntegrationConnection(eu().db, {
        actor,
        connectionId: connection.value.id,
        now: NOW + 4,
      }),
    ).toEqual({ ok: true, value: { connectionId: connection.value.id } });
    const [tombstone] = await regions()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, connection.value.id));
    expect(tombstone).toMatchObject({ kind: "integration_connection" });
    expect(await rows(eu().db)).toHaveLength(0);
    // A restore of the EU database brings the row back; re-applying the tombstones, per region,
    // deletes it again, with the strict guard on (the global tombstone is never joined in).
    if (!snapshot) throw new Error("setup");
    await eu().db.insert(schema.integrationConnections).values(snapshot);
    expect(await applyIntegrationTombstones(regions())).toEqual({ integrations: 1 });
    expect(await rows(eu().db)).toHaveLength(0);
  });

  it("deletes an EU workspace: global first, its artifacts purged from the EU database and bucket", async () => {
    const { ws, admin } = await euWorkspace();
    const { artifactId, digest } = await publishInEu(ws.id, admin.id);
    const deleted = await deleteWorkspace(regions(), { workspaceId: ws.id, now: NOW });
    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    expect(await artifactIn(eu().db, artifactId)).toMatchObject({ state: "purging" });
    // The purge job is in the EU outbox, and the relay names its region.
    const sent: JobMessage[] = [];
    const queue = {
      sendBatch: async (messages: { body: JobMessage }[]) => {
        sent.push(...messages.map((message) => message.body));
      },
    } as unknown as Queue<JobMessage>;
    await relayOutbox(eu().db, queue, NOW + 1, 5, "eu");
    const purge = sent.find((message) => message.topic === "purge_artifact");
    expect(purge?.region).toBe("eu");
    if (!purge) throw new Error("no purge job");
    expect(
      await runJob(eu().db, env.ARTIFACTS_EU, purge, NOW + 2, {
        access: eu().accessDb,
        regions: regions(),
      }),
    ).toBe("done");
    expect(await artifactIn(eu().db, artifactId)).toBeUndefined();
    expect(await env.ARTIFACTS_EU.head(`objects/${ws.id}/${digest}`)).toBeNull();
    const tombstones = await regions()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, artifactId));
    expect(tombstones).toMatchObject([{ kind: "artifact" }]);
    // The deletion finishes from the global job, reaching every region.
    await runMaintenance(home().db, env.ARTIFACTS, NOW + 3, regions());
    const [workspaceTombstone] = await regions()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, ws.id));
    expect(workspaceTombstone).toMatchObject({ kind: "workspace" });
  });

  it("runs every regional scan and the reconciliation on the EU database and bucket", async () => {
    const { ws, admin } = await euWorkspace();
    await publishInEu(ws.id, admin.id);
    const scans = await runRegionalMaintenance(eu().db, env.ARTIFACTS_EU, NOW + DAY, "eu");
    expect(scans).toHaveProperty("archived");
    const storage = await reconcileStorage(eu().db, env.ARTIFACTS_EU, NOW + DAY);
    expect(storage).toBeDefined();
  });

  it("measures the platform's storage across every region", async () => {
    const before = await measurePlatformUsage(regions(), NOW);
    const { ws, admin } = await euWorkspace();
    await publishInEu(ws.id, admin.id);
    const after = await measurePlatformUsage(regions(), NOW);
    expect(after.storedBytes).toBeGreaterThan(before.storedBytes);
  });

  it("exports a purging EU artifact as a tombstone, and rebuilds the EU directory rows", async () => {
    const { ws, admin } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    await eu()
      .db.update(schema.artifacts)
      .set({ state: "purging" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await exportTombstones(regions())).toContainEqual(
      expect.objectContaining({ kind: "artifact", id: artifactId }),
    );
    // Every EU artifact already has its directory row: the rebuild after a global restore adds
    // none and never moves one to another region (rows are never updated or deleted).
    expect(await rebuildArtifactDirectory(regions().global, eu().db, "eu")).toBe(0);
    expect((await artifactHandles(regions(), artifactId))?.region).toBe("eu");
  });
});

/** A version of `artifactId` published into the EU region at `now`, replacing `base`. */
async function updateInEu(
  ownerId: string,
  adminId: string,
  artifactId: string,
  base: string,
  now: number,
) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const prepared = await preparePublish(eu().db, {
    userId: adminId,
    targetOwnerId: ownerId,
    artifactId,
    type: "site",
    name: "EU plan",
    entrypoint: "index.html",
    baseVersionId: base,
    files: [
      {
        path: "index.html",
        kind: "published",
        sha256: digest,
        size: body.length,
        contentType: "text/html",
      },
    ],
    now,
  });
  if (!prepared.ok) throw new Error(prepared.message);
  await env.ARTIFACTS_EU.put(`objects/${ownerId}/${digest}`, body);
  return value(
    await commitPublish(eu().db, env.ARTIFACTS_EU, {
      userId: adminId,
      sessionId: prepared.value.sessionId,
      now,
    }),
  );
}

async function euActor(userId: string, ownerId: string) {
  const actor = await actorOn(regions().global, userId, ownerId);
  if (!actor.ok || !actor.value) throw new Error("no role");
  return actor.value;
}

async function euJobs(topic: string, subject?: string) {
  const rows = await eu()
    .db.select()
    .from(schema.outbox)
    .where(eq(schema.outbox.topic, topic as typeof schema.outbox.$inferSelect.topic));
  return subject === undefined ? rows : rows.filter((row) => row.subject === subject);
}

async function homeJobs(topic: string, subject: string) {
  return (
    await home()
      .db.select()
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, topic as typeof schema.outbox.$inferSelect.topic))
  ).filter((row) => row.subject === subject);
}

async function usageIn(db: ReturnType<typeof eu>["db"], ownerId: string) {
  const [row] = await db
    .select()
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  return row;
}

describe("an EU workspace's plan, scans and paid features", () => {
  it("grants and removes its plan in the EU region: the limit columns and the retention job", async () => {
    const { ws, admin } = await euWorkspace();
    await publishInEu(ws.id, admin.id);
    const grant = {
      ownerId: ws.id,
      plan: "team" as const,
      seats: 3,
      validUntil: null,
      overrides: null,
      grantedBy: "test",
      note: null,
      now: NOW + 1,
    };
    value(await setOwnerPlan(eu().db, grant));
    const team = entitlements({ ...grant, overrides: null }, NOW + 1);
    expect((await usageIn(eu().db, ws.id))?.activeLimit).toBe(team.limits.activeArtifacts);
    expect(await usageIn(home().db, ws.id)).toBeUndefined();
    // The retention job is where the owner's access log is: the EU outbox, never the default.
    const [job] = await euJobs("owner_retention", ws.id);
    expect(job).toBeDefined();
    expect(await homeJobs("owner_retention", ws.id)).toEqual([]);
    expect(
      await runJob(eu().db, env.ARTIFACTS_EU, { id: job?.id ?? 0, topic: "owner_retention" }, NOW, {
        access: eu().accessDb,
      }),
    ).toBe("done");
    expect((await getOwnerPlan(eu().db, ws.id, NOW + 1)).row?.plan).toBe("team");

    value(await removeOwnerPlan(eu().db, { ownerId: ws.id, now: NOW + 2 }));
    expect((await usageIn(eu().db, ws.id))?.activeLimit).toBe(
      entitlements(null, NOW).limits.activeArtifacts,
    );
    // The first job ran and is gone; the removal wrote the next one, in the EU again.
    expect(await euJobs("owner_retention", ws.id)).toHaveLength(1);
  });

  it("runs the plan, expiry, search, group and policy scans for EU owners only in the EU", async () => {
    const { ws, admin, slug } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    await eu()
      .db.update(schema.artifacts)
      .set({ expiresAt: NOW + 2 * DAY })
      .where(eq(schema.artifacts.id, artifactId));
    // Limit columns out of line, a group that is gone, and a public artifact a policy forbids.
    await eu()
      .db.update(schema.accountUsage)
      .set({ activeLimit: 1 })
      .where(eq(schema.accountUsage.ownerId, ws.id));
    await eu()
      .db.insert(schema.artifactGroups)
      .values({ artifactId, groupId: "wg_gone", createdAt: NOW });
    value(
      await updateAccess(eu().db, {
        userId: admin.id,
        artifactId,
        change: { mode: "public" },
        now: NOW,
      }),
    );
    await regions()
      .global.update(schema.workspaces)
      .set({ policy: { ...DEFAULT_POLICY, publicAccess: "forbidden" }, policyRevision: 1 })
      .where(eq(schema.workspaces.id, ws.id));
    await eu().db.delete(schema.outbox).where(eq(schema.outbox.topic, "search_index"));

    // The default region's scans never touch an EU owner, nor give it rows there.
    await runMaintenance(home().db, env.ARTIFACTS, NOW, regions());
    expect(await usageIn(home().db, ws.id)).toBeUndefined();
    expect(await homeJobs("expiry_notice", ws.id)).toEqual([]);

    const scans = await runRegionalMaintenance(eu().db, env.ARTIFACTS_EU, NOW, "eu");
    expect(scans.expiryNotices).toBe(1);
    expect(await euJobs("expiry_notice", ws.id)).toHaveLength(1);
    expect(scans.alignedPlanLimits).toBeGreaterThanOrEqual(1);
    const enterprise = entitlements(
      { plan: "enterprise", seats: 5, validUntil: null, overrides: null },
      NOW,
    );
    expect((await usageIn(eu().db, ws.id))?.activeLimit).toBe(enterprise.limits.activeArtifacts);
    expect(scans.scheduledSearchIndexing).toBeGreaterThanOrEqual(1);
    const [index] = await euJobs("search_index", artifactId);
    expect(
      await runJob(eu().db, env.ARTIFACTS_EU, { id: index?.id ?? 0, topic: "search_index" }, NOW),
    ).toBe("done");
    expect(scans.artifactGroups).toBeGreaterThanOrEqual(1);
    const [policed] = await eu()
      .db.select({ mode: schema.artifacts.accessMode })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(policed?.mode).not.toBe("public");
    expect(slug).toBeTruthy();

    // A lapsed plan unpins, and drops the content index, in the EU.
    await eu()
      .db.update(schema.artifacts)
      .set({ pinned: true, expiresAt: null })
      .where(eq(schema.artifacts.id, artifactId));
    await regions().global.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, ws.id));
    const lapsed = await runRegionalMaintenance(eu().db, env.ARTIFACTS_EU, NOW + 1, "eu");
    expect(lapsed.unpinned).toBeGreaterThanOrEqual(1);
    expect(lapsed.droppedSearchIndexes).toBeGreaterThanOrEqual(1);
    const [unpinned] = await eu()
      .db.select({ pinned: schema.artifacts.pinned })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(unpinned?.pinned).toBe(false);
  });

  it("prunes EU workspaces' old versions in the EU, each with its own plan's retention", async () => {
    const free = await euWorkspace();
    await regions()
      .global.delete(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, free.ws.id));
    const paid = await euWorkspace();
    const versions = async (team: Awaited<ReturnType<typeof euWorkspace>>) => {
      const first = await publishInEu(team.ws.id, team.admin.id);
      const second = await updateInEu(
        team.ws.id,
        team.admin.id,
        first.artifactId,
        first.versionId,
        NOW + 1,
      );
      await updateInEu(team.ws.id, team.admin.id, first.artifactId, second.versionId, NOW + 2);
      return first;
    };
    const freeFirst = await versions(free);
    const paidFirst = await versions(paid);
    const left = async (artifactId: string) =>
      (
        await eu()
          .db.select({ id: schema.versions.id })
          .from(schema.versions)
          .where(eq(schema.versions.artifactId, artifactId))
      ).map((row) => row.id);
    // A month on, the free retention (7 days) has passed and the enterprise one has not.
    const month = await runRegionalMaintenance(eu().db, env.ARTIFACTS_EU, NOW + 30 * DAY, "eu");
    expect(month.prunedVersions).toBeGreaterThanOrEqual(1);
    expect(await left(freeFirst.artifactId)).not.toContain(freeFirst.versionId);
    expect(await left(paidFirst.artifactId)).toContain(paidFirst.versionId);
    // After a year and more, the enterprise retention has passed too.
    await runRegionalMaintenance(eu().db, env.ARTIFACTS_EU, NOW + 400 * DAY, "eu");
    expect(await left(paidFirst.artifactId)).not.toContain(paidFirst.versionId);
  });

  it("delivers, removes and keeps removed an EU workspace's webhook", async () => {
    const { ws, admin } = await euWorkspace();
    const actor = await euActor(admin.id, ws.id);
    const keys = await webhookKeys({
      current: "test-only webhook sealing key, long enough to use",
    });
    const { webhook: hook } = value(
      await createWebhook(eu().db, {
        service: { enabled: true },
        via: "dashboard",
        actor,
        webhook: {
          url: "https://hooks.example.com/in?token=abc",
          format: "generic",
          events: ["artifact.published"],
        },
        keys,
        now: NOW,
      }),
    );
    value(
      await sendTestEvent(eu().db, {
        actor,
        webhookId: hook.id,
        service: { enabled: true },
        now: NOW,
      }),
    );
    const sent: string[] = [];
    const deps: WebhookDeps = {
      keys,
      fetch: async (url: string) => {
        sent.push(url);
        return new Response("ok");
      },
      appOrigin: "https://app.portifact.test",
      contentDomain: "portifact.test",
      enabled: true,
    };
    for (const job of await euJobs("webhook_delivery", hook.id)) {
      await runJob(
        eu().db,
        env.ARTIFACTS_EU,
        { id: job.id, topic: "webhook_delivery" },
        NOW + 60_000,
        {
          webhooks: deps,
        },
      );
    }
    // The plan was read from the global database: the enterprise plan delivers.
    expect(sent).toHaveLength(1);

    const [row] = await eu()
      .db.select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, hook.id));
    value(await removeWebhook(eu().db, { actor, webhookId: hook.id, now: NOW + 2 }));
    const [tombstone] = await regions()
      .global.select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, hook.id));
    expect(tombstone).toMatchObject({ kind: "webhook" });
    // A restore of the EU database brings it back; the tombstones remove it again.
    if (row) await eu().db.insert(schema.webhooks).values(row);
    const applied = await applyTombstones(regions(), [], NOW + 3);
    expect(applied.webhooks).toBe(1);
    expect(
      await eu().db.select().from(schema.webhooks).where(eq(schema.webhooks.id, hook.id)),
    ).toEqual([]);
  });

  it("re-applies tombstones to the EU: purges a resurrected artifact and deletes its owner again", async () => {
    const { ws, admin } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    const ghost = await user("Ghost");
    // An account deleted before the restore whose only rows left are in the EU.
    await eu()
      .db.insert(schema.artifacts)
      .values({ id: "ghostghost", ownerId: ghost.id, type: "site", name: "Gone", state: "active" });
    await regions().global.delete(schema.users).where(eq(schema.users.id, ghost.id));
    const applied = await applyTombstones(
      regions(),
      [
        { kind: "artifact", id: artifactId, deletedAt: NOW },
        { kind: "account", id: ghost.id, deletedAt: NOW },
      ],
      NOW + 1,
    );
    expect(applied.artifacts).toBe(2);
    expect(applied.accounts).toBe(1);
    expect((await artifactIn(eu().db, artifactId))?.state).toBe("purging");
    expect(await euJobs("purge_artifact", artifactId)).toHaveLength(1);
    // The account's deletion is a global job; running it all again changes nothing.
    expect(await homeJobs("account_deletion", ghost.id)).toHaveLength(1);
    const again = await applyTombstones(regions(), [], NOW + 2);
    expect(again).toMatchObject({ artifacts: 0, accounts: 0 });
  });

  it("keeps the EU workspace's audit log in the EU, reads and exports it", async () => {
    const { ws, admin } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    value(
      await updateAccess(eu().db, {
        userId: admin.id,
        artifactId,
        change: { mode: "authenticated" },
        now: NOW + 1,
      }),
    );
    const actor = await euActor(admin.id, ws.id);
    const log = value(
      await getAuditLog(eu().db, { actor, filters: {}, limit: 50, now: NOW + DAY }),
    );
    expect(log.events.map((event) => event.kind)).toContain("access.changed");
    const homeEvents = await home()
      .db.select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, ws.id));
    expect(homeEvents.filter((event) => event.kind === "access.changed")).toEqual([]);
    const exported = value(
      await exportAuditLog(eu().db, { actor, format: "jsonl", filters: {}, now: NOW + DAY }),
    );
    let text = "";
    for await (const chunk of exported.lines()) text += chunk;
    expect(text).toContain("access.changed");
  });

  it("requests an approval review of an EU artifact, notifies the reviewer and records the verdict", async () => {
    const { ws, admin, member } = await euWorkspace();
    const { artifactId } = await publishInEu(ws.id, admin.id);
    // Every member of the workspace may read it, so the member may review it.
    value(
      await updateAccess(eu().db, {
        userId: admin.id,
        artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    );
    value(
      await requestApprovalReview(eu().db, {
        userId: admin.id,
        artifactId,
        reviewers: [member.email],
        now: NOW + 1,
      }),
    );
    const sent: { to: string; name: string }[] = [];
    const reviewNotifier: ReviewNotifier = {
      async send(notice) {
        sent.push({ to: notice.to, name: notice.name });
      },
    };
    for (let round = 0; round < 3; round += 1) {
      for (const job of await euJobs("review_notice")) {
        await runJob(eu().db, env.ARTIFACTS_EU, { id: job.id, topic: "review_notice" }, NOW + 2, {
          reviewNotifier,
        });
      }
    }
    expect(sent.map((notice) => notice.to)).toEqual([member.email]);
    const reviewed = value(
      await submitApprovalVerdict(eu().db, {
        userId: member.id,
        artifactId,
        verdict: "approve",
        now: NOW + 3,
      }),
    );
    expect(reviewed).toBeDefined();
  });

  it("lists a default-region person's own space at home and their EU workspace in the EU", async () => {
    const { ws, member } = await euWorkspace();
    // The member's personal space is in the default region; as a member of the EU workspace
    // (made an editor here) they publish there too.
    await regions()
      .global.update(schema.workspaceMembers)
      .set({ role: "editor" })
      .where(eq(schema.workspaceMembers.userId, member.id));
    const personal = await publishSite(member.id);
    const inEu = await publishInEu(ws.id, member.id);
    const own = value(
      await listArtifacts(home().db, { actor: personalActor(member.id), limit: 50, now: NOW }),
    );
    expect(own.items.map((item) => item.id)).toEqual([personal.artifactId]);
    const scope = value(await resolveOwnerScope(regions().global, member.id, ws.slug));
    expect(scope.region).toBe("eu");
    const theirs = value(await listArtifacts(eu().db, { actor: scope, limit: 50, now: NOW }));
    expect(theirs.items.map((item) => item.id)).toEqual([inEu.artifactId]);
  });
});

/** An EU handle whose batches fail, as if the EU database were unreachable. */
function unreachableEu() {
  const failing = new Proxy(env.DB_EU, {
    get(target, property) {
      if (property === "batch") return async () => Promise.reject(new Error("EU unreachable"));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return regionalDb(aliasBinding(failing, env.DB_EU), regions().global);
}

/** An EU workspace with one artifact and `count` versions, the first published at NOW. */
async function euVersions(count: number, plan?: { validUntil: number | null } | null) {
  const team = await euWorkspace();
  if (plan === null) {
    await regions()
      .global.delete(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, team.ws.id));
  } else if (plan) {
    await regions()
      .global.update(schema.ownerPlans)
      .set({ validUntil: plan.validUntil })
      .where(eq(schema.ownerPlans.ownerId, team.ws.id));
  }
  const first = await publishInEu(team.ws.id, team.admin.id);
  let base = first.versionId;
  for (let i = 1; i < count; i += 1) {
    base = (await updateInEu(team.ws.id, team.admin.id, first.artifactId, base, NOW + i)).versionId;
  }
  const versions = async () =>
    (
      await eu()
        .db.select({ id: schema.versions.id })
        .from(schema.versions)
        .where(eq(schema.versions.artifactId, first.artifactId))
    ).length;
  return { ...team, artifactId: first.artifactId, versions };
}

describe("EU scans and plan changes, second review", () => {
  const LATER = NOW + 30 * DAY;

  it("prunes an expired plan's owner as free, and never stalls the region on skipped versions", async () => {
    // An expired plan keeps its row; alignment puts its columns back to free.
    const expired = await euVersions(5, { validUntil: NOW - DAY });
    const freeOwner = await euVersions(3, null);
    // The reviewer's repro: two versions per run, three runs used to prune nothing.
    for (let run = 0; run < 6; run += 1) {
      await pruneVersions(eu().db, env.ARTIFACTS_EU, LATER, 2, "eu");
    }
    // Only the current version of each is left: the expired plan reads as free.
    expect(await expired.versions()).toBe(1);
    expect(await freeOwner.versions()).toBe(1);
  });

  it("keeps a paid owner's versions, and prunes them as free once its plan has expired", async () => {
    const paid = await euVersions(3, { validUntil: NOW + 60 * DAY });
    await pruneVersions(eu().db, env.ARTIFACTS_EU, LATER, 50, "eu");
    expect(await paid.versions()).toBe(3);
    await pruneVersions(eu().db, env.ARTIFACTS_EU, NOW + 70 * DAY, 50, "eu");
    expect(await paid.versions()).toBe(1);
  });

  it("prunes an owner with an explicit free plan row once, by one branch", async () => {
    const explicit = await euVersions(4);
    await regions()
      .global.update(schema.ownerPlans)
      .set({ plan: "free", seats: 1 })
      .where(eq(schema.ownerPlans.ownerId, explicit.ws.id));
    // As many versions as the run takes: a version picked twice, or picked by the branch that
    // then skips it, would leave some behind.
    const result = await pruneVersions(eu().db, env.ARTIFACTS_EU, LATER, 3, "eu");
    expect(result.processed).toBe(3);
    expect(await explicit.versions()).toBe(1);
  });

  it("keeps a version when the plan changes between the choice and the delete", async () => {
    // Chosen as free (expired plan); renewed after the choice (when the run saves its cursor),
    // before the delete: the re-read keeps the version.
    const renewed = await euVersions(3, { validUntil: NOW - DAY });
    const raced = raceBeforeStatementIn(
      env.DB_EU,
      /^insert into "maintenance_cursors"/i,
      async () => {
        await regions()
          .global.update(schema.ownerPlans)
          .set({ validUntil: null })
          .where(eq(schema.ownerPlans.ownerId, renewed.ws.id));
      },
    );
    const result = await pruneVersions(raced, env.ARTIFACTS_EU, LATER, 1, "eu");
    expect(result.processed).toBe(0);
    expect(await renewed.versions()).toBe(3);
    // Without the renewal the same choice is pruned as free.
    const lapsed = await euVersions(3, { validUntil: NOW - DAY });
    await regions()
      .global.update(schema.ownerPlans)
      .set({ validUntil: null })
      .where(eq(schema.ownerPlans.ownerId, renewed.ws.id));
    for (let run = 0; run < 4; run += 1) {
      await pruneVersions(eu().db, env.ARTIFACTS_EU, LATER, 1, "eu");
    }
    expect(await lapsed.versions()).toBe(1);
  });

  it("refuses a plan grant left half applied, and its job or a second run completes it", async () => {
    const { ws } = await euWorkspace();
    const grant = {
      ownerId: ws.id,
      plan: "team" as const,
      seats: 2,
      validUntil: null,
      overrides: null,
      grantedBy: "test",
      note: null,
      now: NOW,
    };
    const half = await setOwnerPlan(unreachableEu(), grant);
    expect(half).toMatchObject({ ok: false, message: HALF_APPLIED });
    const [row] = await regions()
      .global.select()
      .from(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, ws.id));
    expect(row?.plan).toBe("team");
    expect(await euJobs("owner_retention", ws.id)).toEqual([]);
    const [job] = await homeJobs("plan_region", ws.id);
    expect(job).toBeDefined();
    // The job does the regional half: the columns and the retention job.
    expect(
      await runJob(home().db, env.ARTIFACTS, { id: job?.id ?? 0, topic: "plan_region" }, NOW, {
        regions: regions(),
      }),
    ).toBe("done");
    const team = entitlements({ plan: "team", seats: 2, validUntil: null, overrides: null }, NOW);
    expect((await usageIn(eu().db, ws.id))?.bytesLimit).toBe(team.limits.accountBytes);
    expect(await euJobs("owner_retention", ws.id)).toHaveLength(1);

    // A second failed removal, completed by running the same command again.
    expect(await removeOwnerPlan(unreachableEu(), { ownerId: ws.id, now: NOW + 1 })).toMatchObject({
      ok: false,
      message: HALF_APPLIED,
    });
    expect(await homeJobs("plan_region", ws.id)).toHaveLength(1);
    value(await removeOwnerPlan(eu().db, { ownerId: ws.id, now: NOW + 2 }));
    expect(await homeJobs("plan_region", ws.id)).toEqual([]);
    expect(await euJobs("owner_retention", ws.id)).toHaveLength(2);
    expect((await usageIn(eu().db, ws.id))?.bytesLimit).toBe(
      entitlements(null, NOW).limits.accountBytes,
    );
  });

  it("leaves the newest plan's limits when two grants cross in the region", async () => {
    const { ws } = await euWorkspace();
    const grant = (plan: "pro" | "team", now: number) => ({
      ownerId: ws.id,
      plan,
      seats: 1,
      validUntil: null,
      overrides: null,
      grantedBy: "test",
      note: null,
      now,
    });
    // The first grant has read its plan row; a second grant commits whole, global row and
    // regional columns, before the first one's regional write lands with the older plan.
    const raced = raceBeforeFirstWrite(async () => {
      value(await setOwnerPlan(eu().db, grant("pro", NOW + 1)));
    }, env.DB_EU);
    value(await setOwnerPlan(raced, grant("team", NOW)));
    const [row] = await regions()
      .global.select()
      .from(schema.ownerPlans)
      .where(eq(schema.ownerPlans.ownerId, ws.id));
    expect(row?.plan).toBe("pro");
    const pro = entitlements({ plan: "pro", seats: 1, validUntil: null, overrides: null }, NOW);
    const team = entitlements({ plan: "team", seats: 1, validUntil: null, overrides: null }, NOW);
    expect(pro.limits.accountBytes).not.toBe(team.limits.accountBytes);
    expect((await usageIn(eu().db, ws.id))?.bytesLimit).toBe(pro.limits.accountBytes);
    expect(await homeJobs("plan_region", ws.id)).toEqual([]);
  });

  it("writes no retention job when a removal removed nothing, in either layout", async () => {
    const { ws } = await euWorkspace();
    await regions().global.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, ws.id));
    const removed = value(await removeOwnerPlan(eu().db, { ownerId: ws.id, now: NOW }));
    expect(removed.removed).toBe(false);
    expect(await euJobs("owner_retention", ws.id)).toEqual([]);
    expect(await homeJobs("plan_region", ws.id)).toEqual([]);
    const person = await user("Nobody");
    value(await removeOwnerPlan(home().db, { ownerId: person.id, now: NOW }));
    expect(await homeJobs("owner_retention", person.id)).toEqual([]);
  });

  it("aligns the EU owners a page at a time, resuming where the last run stopped", async () => {
    const teams: Awaited<ReturnType<typeof euWorkspace>>[] = [];
    for (let i = 0; i < 5; i += 1) {
      const team = await euWorkspace();
      await publishInEu(team.ws.id, team.admin.id);
      await eu()
        .db.update(schema.accountUsage)
        .set({ activeLimit: 1 })
        .where(eq(schema.accountUsage.ownerId, team.ws.id));
      teams.push(team);
    }
    const caps = { pageSize: 2, maxPages: 1 };
    const enterprise = entitlements(
      { plan: "enterprise", seats: 5, validUntil: null, overrides: null },
      NOW,
    ).limits.activeArtifacts;
    const aligned = async () => {
      let count = 0;
      for (const team of teams) {
        if ((await usageIn(eu().db, team.ws.id))?.activeLimit === enterprise) count += 1;
      }
      return count;
    };
    // Each run reads one page of two owners, whatever the region holds, and the next run goes on.
    const first = await alignPlanLimits(eu().db, NOW, 50, "eu", caps);
    expect(first.processed).toBeLessThanOrEqual(2);
    const owners = (
      await regions()
        .global.select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.region, "eu"))
    ).length;
    for (let run = 0; run < owners && (await aligned()) < 5; run += 1) {
      await alignPlanLimits(eu().db, NOW, 50, "eu", caps);
    }
    expect(await aligned()).toBe(5);
  });
});
