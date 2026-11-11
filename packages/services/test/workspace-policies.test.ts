// Workspace policies (premium plan E4, decision 0015): reading, previewing and changing them, how
// access changes, publishes, share links and transfers apply them, the plan, roles and tokens,
// races, the bounded enforcement job and its maintenance scan, and what they cost in D1 calls.
import { env } from "cloudflare:test";
import {
  DEFAULT_POLICY,
  planRequiredMessage,
  type ServiceTokenScope,
  type WorkspacePolicy,
} from "@portifact/contracts";
import { globalDb, type Regions, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { eventBit, POLICY_MESSAGES } from "@portifact/domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import { setAnnotationMode } from "../src/annotations.ts";
import { getApprovalReview, requestApprovalReview } from "../src/approval-reviews.ts";
import { getAuditLog } from "../src/audit.ts";
import { runJob } from "../src/outbox.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import {
  createShareLink,
  openShareLink,
  redeemShareHandoff,
  refreshShareSession,
} from "../src/share-links.ts";
import { transferArtifact } from "../src/transfer.ts";
import {
  applyWorkspacePolicies,
  enforceWorkspacePolicies,
  enforceWorkspacePolicy,
  exportWorkspacePolicies,
  getWorkspacePolicy,
  policyImpact,
  previewWorkspacePolicy,
  setWorkspacePolicy,
} from "../src/workspace-policies.ts";
import { changeMemberRole, listUserWorkspaces } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, sha256, value } from "./fixtures.ts";
import { raceBeforeFirstWrite, raceGlobalBeforeFirstWrite } from "./race.ts";

const hex = () => crypto.randomUUID().replaceAll("-", "");
const regions = (): Regions => regionsFromEnv(env);
const policy = (overrides: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...overrides,
});
const refused = (message: string) => ({ ok: false, code: "policy_refused", message });

async function person(name: string) {
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

async function team(plan: "enterprise" | "team" | "free" = "enterprise") {
  const id = `ws_${hex()}`;
  const slug = `p${hex().slice(0, 20)}`;
  const t = {
    id,
    slug,
    admin: await person("Admin"),
    admin2: await person("Second"),
    editor: await person("Editor"),
    member: await person("Member"),
    outsider: await person("Outsider"),
  };
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: t.admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: t.admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.admin2.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: t.member.id, role: "member", updatedAt: NOW },
    ]);
  if (plan !== "free") await grantPlan(id, plan, { seats: 10 });
  return t;
}
type Team = Awaited<ReturnType<typeof team>>;

function manifest(body: string, digest: string) {
  return [
    {
      path: "index.html",
      kind: "published" as const,
      sha256: digest,
      size: body.length,
      contentType: "text/html",
    },
  ];
}

async function publishIn(userId: string, ownerId: string, now = NOW) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const prepared = value(
    await preparePublish(db(), {
      userId,
      targetOwnerId: ownerId,
      type: "site",
      name: "Plan",
      entrypoint: "index.html",
      baseVersionId: null,
      files: manifest(body, digest),
      now,
    }),
  );
  await env.ARTIFACTS.put(`objects/${ownerId}/${digest}`, body);
  return value(
    await commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now }),
  ).artifactId;
}

const save = (
  t: Team,
  next: WorkspacePolicy,
  options: { userId?: string; revision?: number; confirm?: boolean; now?: number } = {},
  r: Regions = regions(),
) =>
  (async () =>
    setWorkspacePolicy(r, {
      userId: options.userId ?? t.admin.id,
      slug: t.slug,
      policy: next,
      revision: options.revision ?? 0,
      // Confirming accepts what the preview shows at that moment, as the dashboard does.
      confirmed: options.confirm
        ? await policyImpact(db(), t.id, next, options.now ?? NOW)
        : undefined,
      now: options.now ?? NOW,
    }))();
const access = (
  userId: string,
  artifactId: string,
  change: Parameters<typeof updateAccess>[1]["change"],
  database = db(),
) => updateAccess(database, { userId, artifactId, change, now: NOW });
const link = (
  userId: string,
  artifactId: string,
  extra: { password?: string; expiresAt?: number | null; now?: number } = {},
  database = db(),
) =>
  createShareLink(database, {
    userId,
    artifactId,
    label: "For Ana",
    expiresAt: extra.expiresAt ?? null,
    password: extra.password,
    now: extra.now ?? NOW,
  });
const open = (token: string, now = NOW, password?: string) =>
  openShareLink([db()], {
    token,
    password,
    now,
    contentDomain: "portifact.dev",
    customDomains: false,
  });

async function artifactRow(id: string) {
  const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
  return row;
}

async function storedPolicy(t: Team) {
  const [row] = await db()
    .select({ policy: schema.workspaces.policy, revision: schema.workspaces.policyRevision })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, t.id));
  return row;
}

async function token(t: Team, scopes: ServiceTokenScope[]) {
  return value(
    await createServiceToken(db().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: {
        label: "CI",
        role: "editor",
        scopes,
        expiresInDays: 30,
        restriction: { kind: "none" },
      },
      now: NOW,
    }),
  ).token.id;
}

async function outboxJobs(workspaceId: string) {
  return db()
    .select()
    .from(schema.outbox)
    .where(
      and(eq(schema.outbox.topic, "workspace_policy"), eq(schema.outbox.subject, workspaceId)),
    );
}

async function auditEvents(t: Team) {
  const log = value(
    await getAuditLog(db(), {
      actor: { userId: t.admin.id, ownerId: t.id, role: "admin", region: "default" },
      filters: { kinds: ["policy.changed", "policy.enforced"] },
      limit: 100,
      now: NOW + 10 * DAY,
    }),
  );
  return log.events;
}

describe("reading, previewing and changing policies", () => {
  it("starts at the defaults and lets every member read them, admins edit them", async () => {
    const t = await team();
    for (const [who, editable] of [
      [t.admin, true],
      [t.editor, false],
      [t.member, false],
    ] as const) {
      expect(
        value(await getWorkspacePolicy(db().global, { userId: who.id, slug: t.slug, now: NOW })),
      ).toEqual({
        policy: DEFAULT_POLICY,
        revision: 0,
        enabled: true,
        editable,
        domainVerified: false,
        // The test's handles answer no real request: no address to show.
        yourIp: null,
        // Active service tokens are counted for admins only.
        serviceTokens: editable ? 0 : null,
      });
    }
    const missing = { ok: false, code: "not_found", message: "Workspace not found." };
    expect(
      await getWorkspacePolicy(db().global, { userId: t.outsider.id, slug: t.slug, now: NOW }),
    ).toEqual(missing);
    expect(
      await getWorkspacePolicy(db().global, { userId: t.admin.id, slug: "no-such", now: NOW }),
    ).toEqual(missing);
  });

  it("saves a policy, records it and shows it in the workspace list", async () => {
    const t = await team();
    const next = policy({
      publicAccess: "forbidden",
      defaultAccess: "workspace",
      readerDomains: ["Example.TEST", "corp.example"],
      shareLinks: "password_required",
      shareLinkMaxDays: 30,
    });
    const saved = value(await save(t, next));
    const normalized = { ...next, readerDomains: ["corp.example", "example.test"] };
    expect(saved).toMatchObject({ policy: normalized, revision: 1, editable: true });
    expect(await storedPolicy(t)).toEqual({ policy: normalized, revision: 1 });
    const listed = await listUserWorkspaces(db().global, t.member.id);
    expect(listed.find((w) => w.id === t.id)?.policy).toEqual(normalized);
    const events = await auditEvents(t);
    expect(events.map((event) => [event.kind, event.detail])).toEqual([
      [
        "policy.changed",
        {
          fields: [
            "publicAccess",
            "defaultAccess",
            "readerDomains",
            "shareLinks",
            "shareLinkMaxDays",
          ],
          publicAccess: "forbidden",
          defaultAccess: "workspace",
          readerDomains: ["corp.example", "example.test"],
          shareLinks: "password_required",
          shareLinkMaxDays: 30,
          confirmed: false,
        },
      ],
    ]);
    expect(events[0]?.target).toEqual({ type: "policy", id: t.id });
    // A restrictive policy writes its job in the same batch.
    expect(await outboxJobs(t.id)).toHaveLength(1);
    // Going back to the defaults stores null, and changing nothing records nothing.
    value(await save(t, DEFAULT_POLICY, { revision: 1 }));
    expect(await storedPolicy(t)).toEqual({ policy: null, revision: 2 });
    expect(value(await save(t, DEFAULT_POLICY, { revision: 2 })).revision).toBe(2);
    expect(await auditEvents(t)).toHaveLength(2);
    expect(await outboxJobs(t.id)).toHaveLength(1);
  });

  it("refuses editors, members, outsiders and a stale revision; validates the proposal", async () => {
    const t = await team();
    const forbid = policy({ publicAccess: "forbidden" });
    for (const who of [t.editor, t.member]) {
      expect(await save(t, forbid, { userId: who.id })).toEqual({
        ok: false,
        code: "forbidden",
        message: "Your role on this workspace does not allow this.",
      });
    }
    expect(await save(t, forbid, { userId: t.outsider.id })).toEqual({
      ok: false,
      code: "not_found",
      message: "Workspace not found.",
    });
    expect(await save(t, forbid, { revision: 3 })).toMatchObject({ code: "version_conflict" });
    expect(await save(t, policy({ readerDomains: ["not a domain"] }))).toMatchObject({
      code: "invalid_input",
    });
    expect(await save(t, policy({ defaultAccess: "domain" }))).toEqual({
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.defaultDomain,
    });
    // With a verified domain, the domain default is accepted.
    await db()
      .insert(schema.workspaceDomains)
      .values({
        id: `wd_${hex()}`,
        workspaceId: t.id,
        domain: `${hex().slice(0, 8)}.example`,
        token: "t",
        state: "verified",
        createdAt: NOW,
        expiresAt: NOW + DAY,
      });
    expect(value(await save(t, policy({ defaultAccess: "domain" }))).domainVerified).toBe(true);
    expect(await storedPolicy(t)).toMatchObject({ revision: 1 });
  });

  it("refuses a service token, whatever its scopes: policies are not a token's action", async () => {
    const t = await team();
    for (const scopes of [
      ["artifacts:read"],
      ["artifacts:read", "artifacts:write", "artifacts:share"],
    ] as ServiceTokenScope[][]) {
      const id = await token(t, scopes);
      expect(await save(t, policy({ shareLinks: "disabled" }), { userId: id })).toEqual({
        ok: false,
        code: "forbidden",
        message: "Your role on this workspace does not allow this.",
      });
      expect(
        await previewWorkspacePolicy(regions(), {
          userId: id,
          slug: t.slug,
          policy: DEFAULT_POLICY,
          now: NOW,
        }),
      ).toMatchObject({ code: "forbidden" });
    }
  });

  it("needs the plan to set or tighten, never to loosen, and keeps applying after a lapse", async () => {
    const t = await team("team");
    expect(await save(t, policy({ publicAccess: "forbidden" }))).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("policies"),
    });
    // Granted, then lapsed: the policy stays and still binds.
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "enterprise", validUntil: NOW + DAY })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    value(await save(t, policy({ publicAccess: "forbidden", shareLinks: "disabled" })));
    const later = NOW + 2 * DAY;
    expect(
      value(
        await getWorkspacePolicy(db().global, { userId: t.admin.id, slug: t.slug, now: later }),
      ),
    ).toMatchObject({ enabled: false, revision: 1 });
    const artifactId = await publishIn(t.editor.id, t.id);
    expect(await access(t.editor.id, artifactId, { mode: "public" })).toEqual(
      refused(POLICY_MESSAGES.publicForbidden),
    );
    // Tightening again needs the plan; loosening one field never does.
    expect(
      await save(
        t,
        policy({ publicAccess: "forbidden", shareLinks: "disabled", shareLinkMaxDays: 3 }),
        { revision: 1, now: later },
      ),
    ).toMatchObject({ code: "plan_required" });
    expect(
      value(await save(t, policy({ shareLinks: "disabled" }), { revision: 1, now: later })).policy,
    ).toEqual(policy({ shareLinks: "disabled" }));
  });

  it("previews what a save changes and refuses it until confirmed, naming the counts", async () => {
    const t = await team();
    const pub = await publishIn(t.editor.id, t.id);
    value(await access(t.editor.id, pub, { mode: "public" }));
    const listed = await publishIn(t.editor.id, t.id);
    value(
      await access(t.editor.id, listed, {
        addReaders: ["in@corp.example", "out@elsewhere.example"],
      }),
    );
    value(await link(t.editor.id, listed));
    value(await link(t.editor.id, listed, { password: "correct horse" }));
    const strict = policy({
      publicAccess: "forbidden",
      readerDomains: ["corp.example"],
      shareLinks: "password_required",
      shareLinkMaxDays: 1,
    });
    const later = NOW + 2 * DAY;
    const preview = (next: WorkspacePolicy, userId = t.admin.id, now = later) =>
      previewWorkspacePolicy(regions(), { userId, slug: t.slug, policy: next, now });
    expect(value(await preview(strict))).toEqual({
      publicArtifacts: 1,
      readersOutside: 1,
      linksRevoked: 0,
      linksWithoutPassword: 1,
      linksOverLifetime: 1,
      networks: null,
    });
    expect(value(await preview(policy({ shareLinks: "disabled" }))).linksRevoked).toBe(2);
    expect(value(await preview(policy({ shareLinkMaxDays: 1 }))).linksOverLifetime).toBe(2);
    expect(await preview(strict, t.editor.id)).toMatchObject({ code: "forbidden" });
    expect(await preview(policy({ readerDomains: ["bad domain"] }))).toMatchObject({
      code: "invalid_input",
    });
    const unconfirmed = await save(t, strict, { now: later });
    expect(unconfirmed).toMatchObject({ ok: false, code: "policy_refused" });
    expect(unconfirmed.ok ? "" : unconfirmed.message).toContain("1 public artifact would become");
    expect(await storedPolicy(t)).toEqual({ policy: null, revision: 0 });
    // Confirmed: saved, and the job applies it.
    value(await save(t, strict, { confirm: true, now: later }));
    const [job] = await outboxJobs(t.id);
    if (!job) throw new Error("no job");
    expect(
      await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "workspace_policy" }, later),
    ).toBe("done");
    expect(await outboxJobs(t.id)).toEqual([]);
    expect((await artifactRow(pub))?.accessMode).toBe("workspace");
    const readers = await db()
      .select({ email: schema.artifactReaders.email })
      .from(schema.artifactReaders)
      .where(eq(schema.artifactReaders.artifactId, listed));
    expect(readers.map((r) => r.email)).toEqual(["in@corp.example"]);
    const events = await auditEvents(t);
    const enforced = events.filter((event) => event.kind === "policy.enforced");
    expect(enforced.map((event) => event.detail)).toEqual([
      { artifactsNarrowed: 1, readersRemoved: 1, linksRevoked: 0, sessionsEnded: 0 },
    ]);
    expect(enforced[0]?.actor).toEqual({ type: "system" });
    expect(events.find((event) => event.kind === "policy.changed")?.detail).toMatchObject({
      confirmed: true,
    });
  });

  it("answers a personal space like a missing workspace: it has no policies", async () => {
    const solo = await person("Solo");
    expect(
      await getWorkspacePolicy(db().global, { userId: solo.id, slug: "solo", now: NOW }),
    ).toMatchObject({ code: "not_found" });
  });
});

describe("applying the policies", () => {
  it("refuses public access to everyone, admins and tokens included, and keeps other modes", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    value(await save(t, policy({ publicAccess: "forbidden" })));
    for (const who of [t.admin.id, t.editor.id]) {
      expect(await access(who, artifactId, { mode: "public" })).toEqual(
        refused(POLICY_MESSAGES.publicForbidden),
      );
    }
    for (const scopes of [
      ["artifacts:read", "artifacts:write"],
      ["artifacts:read", "artifacts:write", "artifacts:share"],
    ] as ServiceTokenScope[][]) {
      const tokenId = await token(t, scopes);
      expect(await access(tokenId, artifactId, { mode: "public" })).toEqual(
        refused(POLICY_MESSAGES.publicForbidden),
      );
    }
    expect(value(await access(t.editor.id, artifactId, { mode: "authenticated" })).mode).toBe(
      "authenticated",
    );
    // A member has no access role at all: the role answers first, an outsider sees nothing.
    expect(await access(t.member.id, artifactId, { mode: "public" })).toMatchObject({
      code: "forbidden",
    });
    expect(await access(t.outsider.id, artifactId, { mode: "public" })).toMatchObject({
      code: "not_found",
    });
  });

  it("refuses readers outside the allowlist; removing and the workspace mode are unaffected", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    value(await save(t, policy({ readerDomains: ["corp.example"] })));
    expect(await access(t.editor.id, artifactId, { addReaders: ["eve@evil.example"] })).toEqual(
      refused(POLICY_MESSAGES.readerOutside("eve@evil.example", ["corp.example"])),
    );
    expect(
      value(await access(t.editor.id, artifactId, { addReaders: ["ana@corp.example"] })).readers,
    ).toEqual(["ana@corp.example"]);
    expect(
      value(await access(t.editor.id, artifactId, { removeReaders: ["ana@corp.example"] })).readers,
    ).toEqual([]);
    expect(value(await access(t.editor.id, artifactId, { mode: "workspace" })).mode).toBe(
      "workspace",
    );
  });

  it("starts new artifacts with the default access, and never changes existing ones", async () => {
    const t = await team();
    const before = await publishIn(t.editor.id, t.id);
    value(await save(t, policy({ defaultAccess: "workspace" })));
    const after = await publishIn(t.editor.id, t.id);
    expect((await artifactRow(before))?.accessMode).toBe("restricted");
    expect((await artifactRow(after))?.accessMode).toBe("workspace");
    const tokenId = await token(t, ["artifacts:read", "artifacts:write"]);
    expect((await artifactRow(await publishIn(tokenId, t.id)))?.accessMode).toBe("workspace");
    // A personal artifact keeps the account's own defaults.
    expect((await artifactRow(await publishIn(t.editor.id, t.editor.id)))?.accessMode).toBe(
      "restricted",
    );
  });

  it("checks share links when they are created", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    value(await save(t, policy({ shareLinks: "password_required", shareLinkMaxDays: 7 })));
    expect(await link(t.editor.id, artifactId, { expiresAt: NOW + DAY })).toEqual(
      refused(POLICY_MESSAGES.passwordRequired),
    );
    expect(await link(t.editor.id, artifactId, { password: "correct horse" })).toEqual(
      refused(POLICY_MESSAGES.lifetime(7)),
    );
    expect(
      await link(t.editor.id, artifactId, { password: "correct horse", expiresAt: NOW + 8 * DAY }),
    ).toEqual(refused(POLICY_MESSAGES.lifetime(7)));
    value(
      await link(t.editor.id, artifactId, { password: "correct horse", expiresAt: NOW + 7 * DAY }),
    );
    value(await save(t, policy({ shareLinks: "disabled" }), { revision: 1, confirm: true }));
    expect(await link(t.admin.id, artifactId, { password: "x", expiresAt: NOW + DAY })).toEqual(
      refused(POLICY_MESSAGES.linksDisabled),
    );
  });

  it("stops old links at open time, then revokes them in bounded steps when disabled", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const plain = value(await link(t.editor.id, artifactId)).token;
    const guarded = value(await link(t.editor.id, artifactId, { password: "correct horse" })).token;
    expect((await open(plain)).kind).toBe("opened");
    value(await save(t, policy({ shareLinks: "password_required" }), { confirm: true }));
    expect(await open(plain)).toEqual({ kind: "unavailable" });
    expect((await open(guarded, NOW, "correct horse")).kind).toBe("opened");
    value(
      await save(t, policy({ shareLinks: "password_required", shareLinkMaxDays: 2 }), {
        revision: 1,
        confirm: true,
      }),
    );
    expect((await open(guarded, NOW + DAY, "correct horse")).kind).toBe("opened");
    expect(await open(guarded, NOW + 2 * DAY, "correct horse")).toEqual({ kind: "refused" });
    // Disabling revokes every active link through the job, in steps of at most `limit`.
    value(await link(t.editor.id, artifactId, { password: "p", expiresAt: NOW + DAY }));
    value(await save(t, policy({ shareLinks: "disabled" }), { revision: 2, confirm: true }));
    expect(await open(guarded, NOW, "correct horse")).toEqual({ kind: "refused" });
    const first = await enforceWorkspacePolicy(db(), t.id, NOW, 2);
    expect(first).toEqual({
      outcome: "pending",
      counts: { artifactsNarrowed: 0, readersRemoved: 0, linksRevoked: 2, sessionsEnded: 0 },
    });
    expect((await enforceWorkspacePolicy(db(), t.id, NOW, 2)).counts.linksRevoked).toBe(1);
    expect(await enforceWorkspacePolicy(db(), t.id, NOW, 2)).toEqual({
      outcome: "done",
      counts: { artifactsNarrowed: 0, readersRemoved: 0, linksRevoked: 0, sessionsEnded: 0 },
    });
    const rows = await db()
      .select({ revokedAt: schema.shareLinks.revokedAt })
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.artifactId, artifactId));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.revokedAt === NOW)).toBe(true);
  });

  it("ends the link sessions of links a policy stops", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const created = value(await link(t.editor.id, artifactId));
    await db()
      .insert(schema.shareSessions)
      .values({
        id: `s_${hex()}`,
        linkId: created.link.id,
        artifactId,
        expiresAt: NOW + DAY,
        createdAt: NOW,
      });
    value(await save(t, policy({ shareLinks: "password_required" }), { confirm: true }));
    expect((await enforceWorkspacePolicy(db(), t.id, NOW)).counts.sessionsEnded).toBe(1);
    expect(
      await db()
        .select()
        .from(schema.shareSessions)
        .where(eq(schema.shareSessions.linkId, created.link.id)),
    ).toEqual([]);
  });

  it("refuses transfers into a workspace whose policies the artifact breaks", async () => {
    const t = await team();
    const owner = t.editor.id;
    await grantPlan(owner, "pro");
    value(await save(t, policy({ publicAccess: "forbidden", readerDomains: ["corp.example"] })));
    const move = (id: string, userId = owner, slug = t.slug) =>
      transferArtifact(db(), env.ARTIFACTS, { userId, artifactId: id, workspace: slug, now: NOW });
    const pub = await publishIn(owner, owner);
    value(await access(owner, pub, { mode: "public" }));
    expect(await move(pub)).toEqual(refused(POLICY_MESSAGES.transferPublic));
    const withReader = await publishIn(owner, owner);
    value(await access(owner, withReader, { addReaders: ["eve@evil.example"] }));
    expect(await move(withReader)).toEqual(
      refused(POLICY_MESSAGES.transferReaders(["corp.example"])),
    );
    value(await access(owner, withReader, { removeReaders: ["eve@evil.example"] }));
    value(await access(owner, withReader, { addReaders: ["ana@corp.example"] }));
    expect(value(await move(withReader)).ownerId).toBe(t.id);

    const t2 = await team();
    value(await save(t2, policy({ shareLinks: "disabled" })));
    await grantPlan(t2.editor.id, "pro");
    const linked = await publishIn(t2.editor.id, t2.editor.id);
    value(await link(t2.editor.id, linked));
    expect(await move(linked, t2.editor.id, t2.slug)).toEqual(
      refused(POLICY_MESSAGES.transferLinks),
    );
  });
});

describe("races", () => {
  it("a public change that read the policy before it tightened is narrowed by the job", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const raced = raceBeforeFirstWrite(async () => {
      value(await save(t, policy({ publicAccess: "forbidden" })));
    });
    // The request read the old policy: its write goes through, then the policy wins.
    value(await access(t.editor.id, artifactId, { mode: "public" }, raced));
    expect((await artifactRow(artifactId))?.accessMode).toBe("public");
    const [job] = await outboxJobs(t.id);
    if (!job) throw new Error("no job");
    expect(await runJob(db(), env.ARTIFACTS, { id: job.id, topic: "workspace_policy" }, NOW)).toBe(
      "done",
    );
    expect((await artifactRow(artifactId))?.accessMode).toBe("workspace");
  });

  it("the maintenance scan catches what slipped past the job", async () => {
    const t = await team();
    value(await save(t, policy({ publicAccess: "forbidden" })));
    const artifactId = await publishIn(t.editor.id, t.id);
    // As if a request that read the old policy wrote after the job ran.
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "public" })
      .where(eq(schema.artifacts.id, artifactId));
    for (let i = 0; i < 100; i += 1) {
      await enforceWorkspacePolicies(db(), NOW);
      if ((await artifactRow(artifactId))?.accessMode === "workspace") break;
    }
    expect((await artifactRow(artifactId))?.accessMode).toBe("workspace");
  });

  it("a share link created while links were disabled meanwhile never opens", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const raced = raceBeforeFirstWrite(async () => {
      value(await save(t, policy({ shareLinks: "disabled" })));
    });
    const created = value(await link(t.editor.id, artifactId, {}, raced));
    expect(await open(created.token)).toEqual({ kind: "unavailable" });
  });

  it("an admin demoted before the write changes nothing", async () => {
    const t = await team();
    const raced = raceGlobalBeforeFirstWrite(async () => {
      value(
        await changeMemberRole(db().global, {
          userId: t.admin2.id,
          slug: t.slug,
          memberId: t.admin.id,
          role: "editor",
          now: NOW,
        }),
      );
    });
    const racedRegions: Regions = { ...regions(), global: raced };
    expect(await save(t, policy({ publicAccess: "forbidden" }), {}, racedRegions)).toEqual({
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    });
    expect(await storedPolicy(t)).toEqual({ policy: null, revision: 0 });
    expect(await outboxJobs(t.id)).toEqual([]);
    expect(await auditEvents(t)).toEqual([]);
  });

  it("of two concurrent saves from the same revision, the later one conflicts", async () => {
    const t = await team();
    const raced = raceGlobalBeforeFirstWrite(async () => {
      value(await save(t, policy({ shareLinks: "disabled" }), { userId: t.admin2.id }));
    });
    const racedRegions: Regions = { ...regions(), global: raced };
    expect(await save(t, policy({ publicAccess: "forbidden" }), {}, racedRegions)).toMatchObject({
      code: "version_conflict",
    });
    expect(await storedPolicy(t)).toEqual({
      policy: policy({ shareLinks: "disabled" }),
      revision: 1,
    });
  });
});

describe("the job and the scan", () => {
  it("is bounded, idempotent and resumable", async () => {
    const t = await team();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await publishIn(t.editor.id, t.id);
      value(await access(t.editor.id, id, { mode: "public" }));
      ids.push(id);
    }
    value(await save(t, policy({ publicAccess: "forbidden" }), { confirm: true }));
    const counts: number[] = [];
    let outcome = "pending";
    while (outcome === "pending") {
      const step = await enforceWorkspacePolicy(db(), t.id, NOW, 2);
      counts.push(step.counts.artifactsNarrowed);
      outcome = step.outcome;
    }
    expect(counts).toEqual([2, 2, 1]);
    for (const id of ids) {
      const row = await artifactRow(id);
      expect(row?.accessMode).toBe("workspace");
    }
    // Running again changes nothing and records nothing.
    const before = (await auditEvents(t)).length;
    expect((await enforceWorkspacePolicy(db(), t.id, NOW)).outcome).toBe("done");
    expect(await auditEvents(t)).toHaveLength(before);
  });

  it("is stale for a workspace that is gone and done for one without restrictions", async () => {
    expect((await enforceWorkspacePolicy(db(), `ws_${hex()}`, NOW)).outcome).toBe("stale");
    const t = await team();
    expect((await enforceWorkspacePolicy(db(), t.id, NOW)).outcome).toBe("done");
    expect(await policyImpact(db(), t.id, DEFAULT_POLICY, NOW)).toEqual({
      publicArtifacts: 0,
      readersOutside: 0,
      linksRevoked: 0,
      linksWithoutPassword: 0,
      linksOverLifetime: 0,
    });
  });
});

describe("a restore", () => {
  it("exports the policies and sets them again after a rewind, never lifting one", async () => {
    const [t, rewound, extra] = [await team(), await team(), await team()];
    const strict = policy({ publicAccess: "forbidden", shareLinks: "disabled" });
    value(await save(t, strict));
    value(await save(rewound, policy({ defaultAccess: "workspace" })));
    const exported = (await exportWorkspacePolicies(db().global)).filter((item) =>
      [t.id, rewound.id].includes(item.workspaceId),
    );
    expect(exported).toEqual(
      [
        { workspaceId: t.id, policy: strict },
        { workspaceId: rewound.id, policy: policy({ defaultAccess: "workspace" }) },
      ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    );
    // The restore rewinds one workspace to before its policy; another gets one the file lacks.
    await db()
      .update(schema.workspaces)
      .set({ policy: null, policyRevision: 0 })
      .where(eq(schema.workspaces.id, t.id));
    value(await save(extra, policy({ shareLinks: "password_required" })));
    const gone = { workspaceId: `ws_${hex()}`, policy: strict };
    const result = await applyWorkspacePolicies(db().global, [...exported, gone], NOW + DAY);
    if (!result.ok) throw new Error(result.message);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.extra).toContain(extra.id);
    expect(result.extra).not.toContain(t.id);
    expect(await storedPolicy(t)).toEqual({ policy: strict, revision: 1 });
    const events = await auditEvents(t);
    expect(events.at(0)?.actor).toEqual({ type: "operator" });
    expect(await outboxJobs(t.id)).toHaveLength(2);
    // Running it again changes nothing.
    expect(await applyWorkspacePolicies(db().global, exported, NOW + DAY)).toMatchObject({
      ok: true,
      applied: 0,
    });
  });
});

describe("cost on the write path", () => {
  function recording() {
    const trips: string[][] = [];
    const queries = new WeakMap<object, string>();
    const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, {
        get(target, property, receiver) {
          const real = Reflect.get(target, property, receiver);
          if (typeof real !== "function") return real;
          if (property === "bind") {
            return (...args: unknown[]) => wrap(real.apply(target, args), query);
          }
          if (["all", "raw", "run", "first"].includes(String(property))) {
            return (...args: unknown[]) => {
              trips.push([query]);
              return real.apply(target, args);
            };
          }
          return real.bind(target);
        },
      });
      queries.set(wrapped, query);
      return wrapped;
    };
    const d1 = new Proxy(env.DB, {
      get(target, property, receiver) {
        const real = Reflect.get(target, property, receiver);
        if (property === "prepare") {
          return (query: string) => wrap(target.prepare(query), query);
        }
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) => {
            trips.push(statements.map((s) => queries.get(s) ?? "?"));
            // biome-ignore lint/suspicious/noExplicitAny: the proxies stand in for D1 statements
            return target.batch(statements as any);
          };
        }
        return typeof real === "function" ? real.bind(target) : real;
      },
    });
    return { database: regionalDb(d1, globalDb(d1)), trips };
  }

  /**
   * The D1 calls of the three write paths a policy applies to, measured on develop before this
   * change with the same scenario (a workspace artifact, an editor). The policy is read in the
   * membership's own query, so neither the defaults nor a restrictive policy add one.
   */
  const BASELINE = { preparePublish: 11, updateAccess: 11, createShareLink: 4, openShareLink: 3 };

  it.each([
    ["the defaults", DEFAULT_POLICY],
    [
      "a restrictive policy",
      policy({
        publicAccess: "forbidden",
        defaultAccess: "workspace",
        readerDomains: ["corp.example"],
        shareLinks: "password_required",
        shareLinkMaxDays: 30,
      }),
    ],
  ] as const)("adds no round trip with %s", async (_name, next) => {
    const t = await team();
    if (next !== DEFAULT_POLICY) value(await save(t, next));
    const artifactId = await publishIn(t.editor.id, t.id);
    const counted = async (
      run: (database: ReturnType<typeof recording>["database"]) => Promise<unknown>,
    ) => {
      const { database, trips } = recording();
      await run(database);
      return trips.length;
    };
    const body = `<p>${crypto.randomUUID()}</p>`;
    const digest = await sha256(body);
    const preparePublishTrips = await counted(async (d) =>
      value(
        await preparePublish(d, {
          userId: t.editor.id,
          targetOwnerId: t.id,
          type: "site",
          name: "Plan",
          entrypoint: "index.html",
          baseVersionId: null,
          files: manifest(body, digest),
          now: NOW,
        }),
      ),
    );
    const updateAccessTrips = await counted(async (d) =>
      value(await access(t.editor.id, artifactId, { addReaders: ["ana@corp.example"] }, d)),
    );
    let shareToken = "";
    const createShareLinkTrips = await counted(async (d) => {
      shareToken = value(
        await link(t.editor.id, artifactId, { password: "correct horse", expiresAt: NOW + DAY }, d),
      ).token;
    });
    // The share link entry reads the owner's plan and, now, its policies in one round trip.
    const openShareLinkTrips = await counted(async (d) =>
      openShareLink([d], {
        token: shareToken,
        password: "correct horse",
        now: NOW,
        contentDomain: "portifact.dev",
        customDomains: false,
      }),
    );
    expect({
      preparePublish: preparePublishTrips,
      updateAccess: updateAccessTrips,
      createShareLink: createShareLinkTrips,
      openShareLink: openShareLinkTrips,
    }).toEqual(BASELINE);
  });
});

// Review fixes (PR 186): the job and the scan at real sizes, the confirmation, the trail a change
// by policy leaves, link sessions and the domain default.
async function addReaders(artifactId: string, emails: string[]) {
  // Chunks of 20 rows (4 values each): well under D1's 100 bound parameters.
  for (let i = 0; i < emails.length; i += 20) {
    await db()
      .insert(schema.artifactReaders)
      .values(emails.slice(i, i + 20).map((email) => ({ artifactId, email, createdAt: NOW })));
  }
}

async function runUntilDone(workspaceId: string, now = NOW) {
  const counts = { artifactsNarrowed: 0, readersRemoved: 0, linksRevoked: 0, sessionsEnded: 0 };
  for (let step = 0; step < 50; step += 1) {
    const result = await enforceWorkspacePolicy(db(), workspaceId, now);
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      counts[key] += result.counts[key];
    }
    if (result.outcome !== "pending") return { outcome: result.outcome, counts, steps: step + 1 };
  }
  throw new Error("the job never finished");
}

async function accessEvents(workspaceId: string) {
  return db()
    .select()
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.ownerId, workspaceId),
        eq(schema.auditEvents.kind, "access.changed"),
      ),
    );
}

const MAX_DOMAINS = Array.from({ length: 20 }, (_, i) => `d${i}.example`);

describe("the job at real sizes", () => {
  it("narrows more public artifacts than one batch, with each artifact's own trail", async () => {
    const t = await team();
    const ids: string[] = [];
    ids.push(await publishIn(t.editor.id, t.id));
    // The fixture grants the plan row only; its limit columns are the free defaults (50 active).
    await db()
      .update(schema.accountUsage)
      .set({ activeLimit: 1_000 })
      .where(eq(schema.accountUsage.ownerId, t.id));
    for (let i = 1; i < 55; i += 1) ids.push(await publishIn(t.editor.id, t.id));
    for (let i = 0; i < ids.length; i += 50) {
      await db()
        .update(schema.artifacts)
        .set({ accessMode: "public" })
        .where(inArray(schema.artifacts.id, ids.slice(i, i + 50)));
    }
    value(await save(t, policy({ publicAccess: "forbidden" }), { confirm: true }));
    const done = await runUntilDone(t.id);
    expect(done.outcome).toBe("done");
    expect(done.counts.artifactsNarrowed).toBe(55);
    const rows = await db()
      .select({ mode: schema.artifacts.accessMode })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.ownerId, t.id));
    expect(rows.every((row) => row.mode === "workspace")).toBe(true);
    const events = await accessEvents(t.id);
    expect(events).toHaveLength(55);
    expect(events[0]).toMatchObject({
      actorType: "system",
      actorId: null,
      detail: { mode: "workspace", policy: "publicAccess" },
    });
    expect(new Set(events.map((event) => event.artifactId))).toEqual(new Set(ids));
  });

  it("removes 500 readers of one artifact outside the widest allowlist", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const outside = Array.from({ length: 495 }, (_, i) => `r${i}@outside.example`);
    const inside = Array.from({ length: 5 }, (_, i) => `r${i}@d${i}.example`);
    await addReaders(artifactId, [...outside, ...inside]);
    const before = (await artifactRow(artifactId))?.policyGeneration ?? 0;
    value(await save(t, policy({ readerDomains: MAX_DOMAINS }), { confirm: true }));
    const done = await runUntilDone(t.id);
    expect(done.counts.readersRemoved).toBe(495);
    const left = await db()
      .select({ email: schema.artifactReaders.email })
      .from(schema.artifactReaders)
      .where(eq(schema.artifactReaders.artifactId, artifactId));
    expect(left.map((row) => row.email).sort()).toEqual([...inside].sort());
    expect((await artifactRow(artifactId))?.policyGeneration).toBeGreaterThan(before);
    const events = await accessEvents(t.id);
    expect(
      events.reduce(
        (sum, e) => sum + Number((e.detail as { readersRemoved?: number }).readersRemoved ?? 0),
        0,
      ),
    ).toBe(495);
    expect(events.every((e) => (e.detail as { policy?: string }).policy === "readerDomains")).toBe(
      true,
    );
  });

  it("revokes share links past one batch", async () => {
    const t = await team();
    const ids: string[] = [];
    for (let a = 0; a < 3; a += 1) {
      const artifactId = await publishIn(t.editor.id, t.id);
      for (let i = 0; i < 20; i += 1) ids.push(value(await link(t.editor.id, artifactId)).link.id);
    }
    value(await save(t, policy({ shareLinks: "disabled" }), { confirm: true }));
    const done = await runUntilDone(t.id);
    expect(done.counts.linksRevoked).toBe(60);
    const live = await db()
      .select({ id: schema.shareLinks.id })
      .from(schema.shareLinks)
      .where(
        and(inArray(schema.shareLinks.id, ids.slice(0, 50)), isNull(schema.shareLinks.revokedAt)),
      );
    expect(live).toEqual([]);
  });

  it("fires the webhook event and drops approval reviewers with their reader row", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    value(await access(t.editor.id, artifactId, { addReaders: ["eve@outside.example"] }));
    value(
      await setAnnotationMode(db(), {
        userId: t.editor.id,
        artifactId,
        mode: "open",
        now: NOW,
      }),
    );
    value(
      await requestApprovalReview(db(), {
        userId: t.admin.id,
        artifactId,
        reviewers: ["eve@outside.example"],
        requiredApprovals: null,
        showStatus: false,
        now: NOW,
      }),
    );
    const webhookId = `wh_${hex()}`;
    await db()
      .insert(schema.webhooks)
      .values({
        id: webhookId,
        ownerId: t.id,
        host: "hooks.example.com",
        format: "generic",
        events: eventBit("artifact.access_changed"),
        keyId: "k1",
        urlBox: "sealed",
        secretBox: "sealed",
        createdVia: "session",
      });
    value(await save(t, policy({ readerDomains: ["corp.example"] }), { confirm: true }));
    await runUntilDone(t.id);
    const marks = await db()
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.webhookId, webhookId));
    expect(marks.map((mark) => [mark.artifactId, mark.type])).toEqual([
      [artifactId, "artifact.access_changed"],
    ]);
    const review = value(
      await getApprovalReview(db(), { userId: t.admin.id, artifactId, now: NOW + 1 }),
    );
    expect(review.request?.reviewers.find((r) => r.email === "eve@outside.example")?.active).toBe(
      false,
    );
  });
});

describe("transfers with many readers", () => {
  it("moves an artifact with 500 readers inside the allowlist and refuses one outside", async () => {
    const t = await team();
    const owner = t.editor.id;
    await grantPlan(owner, "pro");
    value(await save(t, policy({ readerDomains: MAX_DOMAINS })));
    const move = (id: string) =>
      transferArtifact(db(), env.ARTIFACTS, {
        userId: owner,
        artifactId: id,
        workspace: t.slug,
        now: NOW,
      });
    const allowed = await publishIn(owner, owner);
    await addReaders(
      allowed,
      Array.from({ length: 500 }, (_, i) => `r${i}@d${i % 20}.example`),
    );
    expect(value(await move(allowed)).ownerId).toBe(t.id);
    const refusedOne = await publishIn(owner, owner);
    await addReaders(refusedOne, [
      ...Array.from({ length: 499 }, (_, i) => `r${i}@d${i % 20}.example`),
      "eve@outside.example",
    ]);
    expect(await move(refusedOne)).toEqual(
      refused(POLICY_MESSAGES.transferReaders([...MAX_DOMAINS].sort())),
    );
  });
});

describe("the scan", () => {
  async function bareWorkspace(stored: unknown) {
    const id = `ws_${hex()}`;
    await db()
      .insert(schema.workspaces)
      .values({
        id,
        slug: `s${hex().slice(0, 20)}`,
        name: "W",
        createdBy: "u",
        updatedAt: NOW,
        policy: stored,
      });
    return id;
  }

  it("finds a violation in one run past many workspaces, and one failing workspace stops nothing", async () => {
    for (let i = 0; i < 30; i += 1) await bareWorkspace(policy({ publicAccess: "forbidden" }));
    const broken = await bareWorkspace({ publicAccess: "maybe" });
    const t = await team();
    value(await save(t, policy({ publicAccess: "forbidden" })));
    const artifactId = await publishIn(t.editor.id, t.id);
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "public" })
      .where(eq(schema.artifacts.id, artifactId));
    const result = await enforceWorkspacePolicies(db(), NOW);
    expect((await artifactRow(artifactId))?.accessMode).toBe("workspace");
    expect(result.failed).toBeGreaterThanOrEqual(1);
    await db().delete(schema.workspaces).where(eq(schema.workspaces.id, broken));
  });
});

describe("the confirmation is for what the admin saw", () => {
  it("refuses a confirmed save whose counts grew since the preview", async () => {
    const t = await team();
    const first = await publishIn(t.editor.id, t.id);
    value(await access(t.editor.id, first, { mode: "public" }));
    const strict = policy({ publicAccess: "forbidden" });
    const seen = value(
      await previewWorkspacePolicy(regions(), {
        userId: t.admin.id,
        slug: t.slug,
        policy: strict,
        now: NOW,
      }),
    );
    expect(seen.publicArtifacts).toBe(1);
    const second = await publishIn(t.editor.id, t.id);
    value(await access(t.editor.id, second, { mode: "public" }));
    const stale = await setWorkspacePolicy(regions(), {
      userId: t.admin.id,
      slug: t.slug,
      policy: strict,
      revision: 0,
      confirmed: seen,
      now: NOW,
    });
    expect(stale).toEqual(refused(POLICY_MESSAGES.impactChanged));
    const fresh = value(
      await previewWorkspacePolicy(regions(), {
        userId: t.admin.id,
        slug: t.slug,
        policy: strict,
        now: NOW,
      }),
    );
    expect(
      value(
        await setWorkspacePolicy(regions(), {
          userId: t.admin.id,
          slug: t.slug,
          policy: strict,
          revision: 0,
          confirmed: fresh,
          now: NOW,
        }),
      ).revision,
    ).toBe(1);
  });
});

describe("link sessions after a policy", () => {
  it("refuses a code issued before the save and redeemed after the job", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const created = value(await link(t.editor.id, artifactId));
    const opened = await open(created.token);
    if (opened.kind !== "opened") throw new Error(opened.kind);
    value(await save(t, policy({ shareLinks: "password_required" }), { confirm: true }));
    await runUntilDone(t.id);
    const redeem = (now: number) =>
      redeemShareHandoff(db(), {
        code: opened.code,
        artifactId,
        now,
        host: opened.host,
        devHost: `${artifactId}.portifact.dev`,
      });
    expect(await redeem(NOW + 1)).toEqual({
      ok: false,
      code: "invalid_input",
      message: "This link has expired or was already used.",
    });
  });

  it("refuses to renew a link session the policy stops", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const created = value(await link(t.editor.id, artifactId));
    const opened = await open(created.token);
    if (opened.kind !== "opened") throw new Error(opened.kind);
    const session = value(
      await redeemShareHandoff(db(), {
        code: opened.code,
        artifactId,
        now: NOW,
        host: opened.host,
        devHost: `${artifactId}.portifact.dev`,
      }),
    );
    // The policy is saved; the job has not run yet.
    value(await save(t, policy({ shareLinks: "password_required" }), { confirm: true }));
    expect(
      await refreshShareSession(db(), {
        sessionId: session.sessionId,
        artifactId,
        linkId: session.linkId,
        now: NOW + 1,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("the domain default without a verified domain", () => {
  it("starts new artifacts shared with the workspace, never wider, and restricted without the plan", async () => {
    const t = await team();
    const domainId = `wd_${hex()}`;
    await db()
      .insert(schema.workspaceDomains)
      .values({
        id: domainId,
        workspaceId: t.id,
        domain: `${hex().slice(0, 8)}.example`,
        token: "t",
        state: "verified",
        createdAt: NOW,
        expiresAt: NOW + DAY,
      });
    value(await save(t, policy({ defaultAccess: "domain" })));
    expect((await artifactRow(await publishIn(t.editor.id, t.id)))?.accessMode).toBe("domain");
    await db().delete(schema.workspaceDomains).where(eq(schema.workspaceDomains.id, domainId));
    expect((await artifactRow(await publishIn(t.editor.id, t.id)))?.accessMode).toBe("workspace");
    await db()
      .update(schema.ownerPlans)
      .set({ plan: "free" })
      .where(eq(schema.ownerPlans.ownerId, t.id));
    expect((await artifactRow(await publishIn(t.editor.id, t.id)))?.accessMode).toBe("restricted");
  });
});
