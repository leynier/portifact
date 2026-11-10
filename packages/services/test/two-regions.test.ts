// A workspace in the EU region, end to end through the services (decision 0005, "Two-region
// audit"). The EU region here is its own control database, access log database and bucket, and
// the region guard is strict (REGION_GUARD), so a statement that reaches the wrong database fails
// the test instead of working by accident.
import { env } from "cloudflare:test";
import type { AnnotationTarget, JobMessage } from "@portifact/contracts";
import { accessSchema, regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { recordOpenings } from "../src/access-log.ts";
import { requestAccountDeletion } from "../src/account-data.ts";
import { artifactHandles } from "../src/actors.ts";
import { recordViews } from "../src/analytics.ts";
import {
  createAnnotationThread,
  getAnnotationThread,
  type HumanCheck,
} from "../src/annotations.ts";
import {
  applyIntegrationTombstones,
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
import { runMaintenance, runRegionalMaintenance } from "../src/maintenance.ts";
import { relayOutbox, runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { issueReadHandoff, redeemReadHandoff, refreshReadSession } from "../src/read-access.ts";
import { createShareLink, openShareLink } from "../src/share-links.ts";
import { FakeIssueTrackers } from "../src/testing/fake-issue-trackers.ts";
import { requestThreadIssue } from "../src/thread-issues.ts";
import { transferArtifact } from "../src/transfer.ts";
import { createWorkspace, deleteWorkspace } from "../src/workspaces.ts";
import { DAY, NOW, session, sha256, user } from "./fixtures.ts";

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
    const scans = await runRegionalMaintenance(eu().db, env.ARTIFACTS_EU, NOW + DAY);
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
