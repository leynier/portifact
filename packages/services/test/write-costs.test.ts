// D1 calls on the write paths (AGENTS.md: no read or round trip may be added to them). Each
// path runs through one recording proxy that every handle shares, so the count is the calls the
// path makes in today's production shape (one region, the regional database is the global one).
// The expected numbers were measured once on develop (71b6ea2) with this same file.
import { env } from "cloudflare:test";
import type { AnnotationTarget } from "@portifact/contracts";
import { globalDb, type RegionalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import {
  createAnnotationThread,
  type HumanCheck,
  replyToAnnotationThread,
  setAnnotationThreadState,
} from "../src/annotations.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { createShareLink, openShareLink, redeemShareHandoff } from "../src/share-links.ts";
import { createWorkspace } from "../src/workspaces.ts";
import { db, NOW, publishSite, sha256, user } from "./fixtures.ts";
import { recording } from "./recording.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };

/** A one-page site that `userId` publishes for `ownerId` (a workspace). */
async function publishAs(
  userId: string,
  ownerId: string,
  database: RegionalDb = db(),
  bucket: R2Bucket = env.ARTIFACTS,
) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const prepared = await preparePublish(database, {
    userId,
    targetOwnerId: ownerId,
    type: "site",
    name: "Plan",
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
  await bucket.put(`objects/${ownerId}/${digest}`, body);
  const committed = await commitPublish(database, bucket, {
    userId,
    sessionId: prepared.value.sessionId,
    now: NOW,
  });
  if (!committed.ok) throw new Error(committed.message);
  return committed.value;
}

async function counted(
  run: (database: RegionalDb) => Promise<unknown>,
  regionalBinding?: D1Database,
): Promise<number> {
  const { database, count } = recording(regionalBinding);
  await run(database);
  return count();
}

/** The D1 calls of each write path on develop, measured with this file before the change. */
const DEVELOP = {
  comment: 11,
  reply: 9,
  resolution: 6,
  accessPersonal: 6,
  accessWorkspace: 11,
  publishPrepare: 12,
  publishCommit: 6,
  shareLinkOpen: 3,
  shareLinkRedeem: 1,
};

/** A member's comment, an admin's reply and the admin's resolution, each counted. */
async function commentCosts(
  people: { member: string; admin: string },
  artifact: { artifactId: string; versionId: string },
  count: (run: (database: RegionalDb) => Promise<unknown>) => Promise<number>,
) {
  let threadId = "";
  const comment = await count(async (d) => {
    const result = await createAnnotationThread(d, {
      humanCheck: HUMAN,
      userId: people.member,
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      target: DOC,
      body: "A comment",
      now: NOW,
    });
    if (!result.ok) throw new Error(result.message);
    threadId = result.value.id;
  });
  const reply = await count(async (d) => {
    const result = await replyToAnnotationThread(d, {
      humanCheck: HUMAN,
      userId: people.admin,
      artifactId: artifact.artifactId,
      threadId,
      body: "A reply",
      now: NOW + 1,
    });
    if (!result.ok) throw new Error(result.message);
  });
  const resolution = await count(async (d) => {
    const result = await setAnnotationThreadState(d, {
      userId: people.admin,
      artifactId: artifact.artifactId,
      threadId,
      state: "resolved",
      now: NOW + 2,
    });
    if (!result.ok) throw new Error(result.message);
  });
  return { comment, reply, resolution };
}

/** A workspace's member comment, admin reply and resolution on develop. */
const DEVELOP_WORKSPACE_COMMENTS = { comment: 14, reply: 11, resolution: 8 };

describe("D1 calls on the write paths, one region", () => {
  it("are what develop makes", async () => {
    const owner = await user("Owner");
    const reader = await user("Reader");
    const { artifactId, versionId } = await publishSite(owner.id);
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, artifactId));
    await db().insert(schema.artifactReaders).values({ artifactId, email: reader.email });
    await db()
      .global.insert(schema.ownerPlans)
      .values({ ownerId: owner.id, plan: "pro", grantedBy: "test", updatedAt: NOW });

    let threadId = "";
    const comment = await counted(async (d) => {
      const result = await createAnnotationThread(d, {
        humanCheck: HUMAN,
        userId: reader.id,
        artifactId,
        versionId,
        target: DOC,
        body: "A comment",
        now: NOW,
      });
      if (!result.ok) throw new Error(result.message);
      threadId = result.value.id;
    });
    const reply = await counted(async (d) => {
      const result = await replyToAnnotationThread(d, {
        humanCheck: HUMAN,
        userId: owner.id,
        artifactId,
        threadId,
        body: "A reply",
        now: NOW + 1,
      });
      if (!result.ok) throw new Error(result.message);
    });
    const resolution = await counted(async (d) => {
      const result = await setAnnotationThreadState(d, {
        userId: owner.id,
        artifactId,
        threadId,
        state: "resolved",
        now: NOW + 2,
      });
      if (!result.ok) throw new Error(result.message);
    });
    const accessPersonal = await counted(async (d) => {
      const result = await updateAccess(d, {
        userId: owner.id,
        artifactId,
        change: { addReaders: ["ana@example.test"] },
        now: NOW,
      });
      if (!result.ok) throw new Error(result.message);
    });

    const admin = await user("Admin");
    const created = await createWorkspace(db().global, {
      slug: `wc-${crypto.randomUUID().slice(0, 8)}`,
      name: "Costs",
      adminUserId: admin.id,
      now: NOW,
    });
    if (!created.ok) throw new Error(created.message);
    const workspace = await publishAs(admin.id, created.value.id);
    const member = await user("Member");
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: created.value.id, userId: member.id, role: "member", updatedAt: NOW });
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open", accessMode: "workspace" })
      .where(eq(schema.artifacts.id, workspace.artifactId));
    const workspaceCosts = await commentCosts(
      { member: member.id, admin: admin.id },
      workspace,
      (run) => counted(run),
    );
    const accessWorkspace = await counted(async (d) => {
      const result = await updateAccess(d, {
        userId: admin.id,
        artifactId: workspace.artifactId,
        change: { addReaders: ["ana@example.test"] },
        now: NOW,
      });
      if (!result.ok) throw new Error(result.message);
    });

    const body = `<p>${crypto.randomUUID()}</p>`;
    const digest = await sha256(body);
    let sessionId = "";
    const publishPrepare = await counted(async (d) => {
      const result = await preparePublish(d, {
        userId: owner.id,
        type: "site",
        name: "Plan",
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
      if (!result.ok) throw new Error(result.message);
      sessionId = result.value.sessionId;
    });
    await env.ARTIFACTS.put(`objects/${owner.id}/${digest}`, body);
    const publishCommit = await counted(async (d) => {
      const result = await commitPublish(d, env.ARTIFACTS, {
        userId: owner.id,
        sessionId,
        now: NOW,
      });
      if (!result.ok) throw new Error(result.message);
    });

    const link = await createShareLink(db(), {
      userId: owner.id,
      artifactId,
      label: "Costs",
      expiresAt: null,
      password: undefined,
      now: NOW,
    });
    if (!link.ok) throw new Error(link.message);
    let code = "";
    let host = "";
    const shareLinkOpen = await counted(async (d) => {
      const opened = await openShareLink([d], {
        token: link.value.token,
        now: NOW,
        contentDomain: "portifact.dev",
        customDomains: false,
      });
      if (opened.kind !== "opened") throw new Error(opened.kind);
      code = opened.code;
      host = opened.host;
    });
    const shareLinkRedeem = await counted(async (d) => {
      const redeemed = await redeemShareHandoff(d, {
        code,
        artifactId,
        host,
        devHost: `${artifactId}.portifact.dev`,
        now: NOW + 1,
      });
      if (!redeemed.ok) throw new Error(redeemed.message);
    });

    expect(workspaceCosts).toEqual(DEVELOP_WORKSPACE_COMMENTS);
    expect({
      comment,
      reply,
      resolution,
      accessPersonal,
      accessWorkspace,
      publishPrepare,
      publishCommit,
      shareLinkOpen,
      shareLinkRedeem,
    }).toEqual(DEVELOP);
  });
});

describe("D1 calls on the write paths, a region with its own database", () => {
  it("are what develop makes with one database: the plan rides in the global batch", async () => {
    const admin = await user("Admin");
    const member = await user("Member");
    const created = await createWorkspace(db().global, {
      slug: `we-${crypto.randomUUID().slice(0, 8)}`,
      name: "EU costs",
      adminUserId: admin.id,
      now: NOW,
      region: "eu",
    });
    if (!created.ok) throw new Error(created.message);
    await db()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: created.value.id, userId: member.id, role: "member", updatedAt: NOW });
    const eu = regionsFromEnv(env).get("eu").db;
    const artifact = await publishAs(admin.id, created.value.id, eu, env.ARTIFACTS_EU);
    await eu
      .update(schema.artifacts)
      .set({ annotations: "open", accessMode: "workspace" })
      .where(eq(schema.artifacts.id, artifact.artifactId));
    const costs = await commentCosts({ member: member.id, admin: admin.id }, artifact, (run) =>
      counted(run, env.DB_EU),
    );
    expect(costs).toEqual(DEVELOP_WORKSPACE_COMMENTS);
    const access = await counted(async (d) => {
      const result = await updateAccess(d, {
        userId: admin.id,
        artifactId: artifact.artifactId,
        change: { addReaders: ["ana@example.test"] },
        now: NOW,
      });
      if (!result.ok) throw new Error(result.message);
    }, env.DB_EU);
    expect(access).toBe(DEVELOP.accessWorkspace);
  });
});
