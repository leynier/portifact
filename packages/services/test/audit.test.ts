// The audit log (premium plan T10): every recorded change writes its event in its own batch, with
// the right actor, owner, target and detail; refusals, failed validation and lost races write
// none; retries write one; reading is for the owner's admins on a plan with `audit`; events are
// kept 90 days, go with their owner and never hold addresses, tokens or comment text.
import { env } from "cloudflare:test";
import {
  AUDIT_LIMITS,
  type AuditKind,
  planRequiredMessage,
  txtRecordName,
  txtRecordValue,
  type WorkspaceRole,
} from "@portifact/contracts";
import { globalDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { type Actor, personalActor } from "@portifact/domain";
import { png } from "@portifact/domain/testing/images";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { updateAccess } from "../src/access.ts";
import {
  exportAccount,
  processAccountDeletions,
  requestAccountDeletion,
} from "../src/account-data.ts";
import { GLOBAL_AUDIT_KINDS, getAuditLog, pruneAuditEvents } from "../src/audit.ts";
import { applyTombstones } from "../src/backups.ts";
import { deleteBrand, removeBrandLogo, setBrandLogo, updateBrand } from "../src/branding.ts";
import { addCustomDomain, removeCustomDomain, verifyCustomDomain } from "../src/custom-domains.ts";
import {
  acceptInvitation,
  type InvitationMessage,
  type InvitationSender,
  inviteMember,
  revokeInvitation,
} from "../src/invitations.ts";
import {
  archiveArtifact,
  deleteArtifact,
  pinArtifact,
  renewArtifact,
  restoreArtifact,
  unpinArtifact,
} from "../src/lifecycle.ts";
import { purgeArchived } from "../src/maintenance.ts";
import { removeOwnerPlan, setOwnerPlan } from "../src/plans.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { createShareLink, revokeShareLink } from "../src/share-links.ts";
import { FakeDomains } from "../src/testing/fake-domains.ts";
import { transferArtifact } from "../src/transfer.ts";
import { rollbackArtifact } from "../src/versions.ts";
import { webhookKeys } from "../src/webhook-keys.ts";
import { createWebhook, removeWebhook, updateWebhook } from "../src/webhooks.ts";
import {
  advanceWorkspaceDeletion,
  changeMemberRole,
  createWorkspace,
  deleteWorkspace,
  leaveWorkspace,
  removeMember,
  resolveOwnerScope,
} from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, publishSite, session, sha256, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite, raceGlobalBeforeFirstWrite } from "./race.ts";

const global = () => db().global;
const SECRET = "Secret comment words that never leave";
const BATCH = AUDIT_LIMITS.pruneBatch;
const CONTENT = "portifact.dev";
const KEYS = () => webhookKeys({ current: "test-only webhook sealing key, long enough to use" });
type User = { id: string; email: string };

async function events(ownerId: string) {
  return db()
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.ownerId, ownerId))
    .orderBy(asc(schema.auditEvents.at), asc(schema.auditEvents.id));
}

async function kinds(ownerId: string): Promise<string[]> {
  return (await events(ownerId)).map((row) => row.kind);
}

/** The single event of a kind for an owner, failing when there is not exactly one. */
async function only(ownerId: string, kind: AuditKind) {
  const found = (await events(ownerId)).filter((row) => row.kind === kind);
  expect(found, kind).toHaveLength(1);
  return found[0] as (typeof found)[number];
}

async function teamPlan(): Promise<User> {
  const owner = await user("Ada");
  await grantPlan(owner.id, "team");
  return owner;
}

interface Team {
  id: string;
  slug: string;
  admin: User;
  editor: User;
  member: User;
  outsider: User;
}

async function team(plan: "team" | "pro" | null = "team"): Promise<Team> {
  const [admin, editor, member, outsider] = [
    await user("Ada"),
    await user("Ed"),
    await user("Mia"),
    await user("Otto"),
  ];
  const slug = `a-${crypto.randomUUID().slice(0, 8)}`;
  const created = value(
    await createWorkspace(global(), { slug, name: "Team", adminUserId: admin.id, now: NOW }),
  );
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: created.id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: created.id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  if (plan) await grantPlan(created.id, plan, { seats: 10 });
  return { id: created.id, slug, admin, editor, member, outsider };
}

const at = (userId: string, artifactId: string, now = NOW) => ({ userId, artifactId, now });

function recorder(): InvitationSender & { sent: InvitationMessage[] } {
  const sent: InvitationMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

async function read(
  actor: Actor,
  filters = {},
  extra: { cursor?: string | undefined; limit?: number } = {},
) {
  return getAuditLog(db(), {
    actor,
    filters,
    cursor: extra.cursor,
    limit: extra.limit ?? 50,
    now: NOW + DAY,
  });
}

const workspaceActor = (t: Team, who: User, role: WorkspaceRole): Actor => ({
  userId: who.id,
  ownerId: t.id,
  role,
  region: "default",
});

describe("lifecycle events", () => {
  it("records each transition with the actor, the artifact and nothing else", async () => {
    const owner = await teamPlan();
    const { artifactId } = await publishSite(owner.id);
    value(await renewArtifact(db(), at(owner.id, artifactId, NOW + 1)));
    value(await pinArtifact(db(), at(owner.id, artifactId, NOW + 2)));
    value(await unpinArtifact(db(), at(owner.id, artifactId, NOW + 3)));
    value(await archiveArtifact(db(), at(owner.id, artifactId, NOW + 4)));
    value(await restoreArtifact(db(), at(owner.id, artifactId, NOW + 5)));
    value(await deleteArtifact(db(), env.ARTIFACTS, at(owner.id, artifactId, NOW + 6)));
    const rows = await events(owner.id);
    expect(rows.map((row) => row.kind)).toEqual([
      "artifact.published",
      "artifact.renewed",
      "artifact.pinned",
      "artifact.unpinned",
      "artifact.archived",
      "artifact.restored",
      "artifact.deleted",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        ownerId: owner.id,
        actorType: "user",
        actorId: owner.id,
        targetId: artifactId,
        artifactId,
      });
    }
    expect(rows[0]?.detail).toEqual({ version: 1, first: true });
    expect(rows.slice(1).map((row) => row.detail)).toEqual([{}, {}, {}, {}, {}, {}]);
  });

  it("records nothing for a refusal, a plan gate or a repeated no-op", async () => {
    const free = await user();
    const { artifactId } = await publishSite(free.id);
    expect(await pinArtifact(db(), at(free.id, artifactId))).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("pin"),
    });
    value(await archiveArtifact(db(), at(free.id, artifactId, NOW + 1)));
    expect((await archiveArtifact(db(), at(free.id, artifactId, NOW + 2))).ok).toBe(false);
    const stranger = await user();
    expect((await renewArtifact(db(), at(stranger.id, artifactId))).ok).toBe(false);
    expect(await kinds(free.id)).toEqual(["artifact.published", "artifact.archived"]);
    expect(await kinds(stranger.id)).toEqual([]);

    const paid = await teamPlan();
    const pinned = await publishSite(paid.id);
    value(await pinArtifact(db(), at(paid.id, pinned.artifactId, NOW + 1)));
    value(await pinArtifact(db(), at(paid.id, pinned.artifactId, NOW + 2)));
    expect(await kinds(paid.id)).toEqual(["artifact.published", "artifact.pinned"]);
  });

  it("records nothing when a concurrent change wins the race", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    const raced = raceBeforeFirstWrite(async () => {
      await db()
        .update(schema.artifacts)
        .set({ lifecycleGeneration: 999 })
        .where(eq(schema.artifacts.id, artifactId));
    });
    expect(await archiveArtifact(raced, at(owner.id, artifactId))).toMatchObject({
      code: "version_conflict",
    });
    expect(await kinds(owner.id)).toEqual(["artifact.published"]);
  });
});

describe("publish and rollback events", () => {
  it("records each version once, even when a commit is retried, and rollbacks with their numbers", async () => {
    const owner = await user();
    const first = await publishSite(owner.id, { "index.html": "<p>one</p>" });
    const body = "<p>two</p>";
    const prepared = value(
      await preparePublish(db(), {
        userId: owner.id,
        type: "site",
        name: "Plan",
        entrypoint: "index.html",
        baseVersionId: first.versionId,
        artifactId: first.artifactId,
        files: [
          {
            path: "index.html",
            kind: "published",
            sha256: await sha256(body),
            size: body.length,
            contentType: "text/html",
          },
        ],
        now: NOW + 1,
      }),
    );
    await env.ARTIFACTS.put(`objects/${owner.id}/${await sha256(body)}`, body);
    const commit = { userId: owner.id, sessionId: prepared.sessionId, now: NOW + 1 };
    const second = value(await commitPublish(db(), env.ARTIFACTS, commit));
    value(await commitPublish(db(), env.ARTIFACTS, commit));
    value(
      await rollbackArtifact(db(), {
        userId: owner.id,
        artifactId: first.artifactId,
        versionId: first.versionId,
        baseVersionId: second.versionId,
        now: NOW + 2,
      }),
    );
    expect((await events(owner.id)).map((row) => [row.kind, row.detail])).toEqual([
      ["artifact.published", { version: 1, first: true }],
      ["artifact.published", { version: 2, first: false }],
      ["artifact.rolled_back", { version: 3, from: 1 }],
    ]);
  });

  it("records no rollback when it is refused", async () => {
    const owner = await user();
    const first = await publishSite(owner.id);
    expect(
      (
        await rollbackArtifact(db(), {
          userId: owner.id,
          artifactId: first.artifactId,
          versionId: first.versionId,
          baseVersionId: first.versionId,
          now: NOW + 1,
        })
      ).ok,
    ).toBe(false);
    expect(await kinds(owner.id)).toEqual(["artifact.published"]);
  });
});

describe("access events", () => {
  it("records counts and domains of readers, never their addresses", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(
      await updateAccess(db(), {
        ...at(owner.id, artifactId),
        change: {
          addReaders: ["ana@corp.example", "bo@corp.example", "cy@other.example"],
          bar: false,
          commentVisibility: "everyone",
        },
      }),
    );
    value(
      await updateAccess(db(), {
        ...at(owner.id, artifactId, NOW + 1),
        change: { removeReaders: ["cy@other.example"], mode: "authenticated" },
      }),
    );
    const rows = (await events(owner.id)).filter((row) => row.kind === "access.changed");
    expect(rows.map((row) => row.detail)).toEqual([
      {
        readersAdded: 3,
        readerDomains: ["corp.example", "other.example"],
        bar: false,
        commentVisibility: "everyone",
      },
      { mode: "authenticated", readersRemoved: 1, readerDomains: ["other.example"] },
    ]);
    expect(JSON.stringify(rows)).not.toContain("@");
  });

  it("records nothing for a change that changes nothing, a refusal or a lost race", async () => {
    const owner = await user();
    const { artifactId } = await publishSite(owner.id);
    value(await updateAccess(db(), { ...at(owner.id, artifactId), change: { bar: true } }));
    const editorless = await user();
    expect(
      (
        await updateAccess(db(), {
          ...at(editorless.id, artifactId),
          change: { mode: "authenticated" },
        })
      ).ok,
    ).toBe(false);
    const raced = raceBeforeFirstWrite(async () => {
      await db()
        .update(schema.artifacts)
        .set({ policyGeneration: 99 })
        .where(eq(schema.artifacts.id, artifactId));
    });
    expect(
      await updateAccess(raced, { ...at(owner.id, artifactId), change: { mode: "authenticated" } }),
    ).toMatchObject({ code: "version_conflict" });
    expect(await kinds(owner.id)).toEqual(["artifact.published"]);
  });
});

describe("share link events", () => {
  it("records creating and revoking, once, and nothing on a plan without links", async () => {
    const owner = await teamPlan();
    const { artifactId } = await publishSite(owner.id);
    const { link, token } = value(
      await createShareLink(db(), {
        ...at(owner.id, artifactId),
        label: "For Ana at ana@corp.example",
        expiresAt: NOW + DAY,
        password: "correct horse",
      }),
    );
    value(await revokeShareLink(db(), { ...at(owner.id, artifactId, NOW + 1), linkId: link.id }));
    expect((await revokeShareLink(db(), { ...at(owner.id, artifactId), linkId: link.id })).ok).toBe(
      false,
    );
    const rows = (await events(owner.id)).filter((row) => row.kind.startsWith("share_link"));
    expect(rows.map((row) => [row.kind, row.targetId, row.artifactId, row.detail])).toEqual([
      ["share_link.created", link.id, artifactId, { password: true, expires: true }],
      ["share_link.revoked", link.id, artifactId, {}],
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain("Ana");

    const free = await user();
    const other = await publishSite(free.id);
    expect(
      (
        await createShareLink(db(), {
          ...at(free.id, other.artifactId),
          label: "x",
          expiresAt: null,
        })
      ).ok,
    ).toBe(false);
    expect(await kinds(free.id)).toEqual(["artifact.published"]);
  });
});

describe("custom domain events", () => {
  it("records attaching and removing in the global database, with the user who did it", async () => {
    const owner = await teamPlan();
    const { artifactId } = await publishSite(owner.id);
    const fake = new FakeDomains();
    const regions = () => regionsFromEnv(env);
    const hostname = `docs-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const claim = value(
      await addCustomDomain(regions(), fake, {
        userId: owner.id,
        artifactId,
        hostname,
        contentDomain: CONTENT,
        now: NOW,
      }),
    );
    fake.publishTxt(txtRecordName(hostname), txtRecordValue(claim.token));
    value(await verifyCustomDomain(regions(), fake, { userId: owner.id, hostname, now: NOW }));
    value(await verifyCustomDomain(regions(), fake, { userId: owner.id, hostname, now: NOW + 1 }));
    value(await removeCustomDomain(regions(), { userId: owner.id, hostname, now: NOW + 2 }));
    const rows = (await events(owner.id)).filter((row) => row.kind.startsWith("domain."));
    expect(rows.map((row) => [row.kind, row.actorId, row.artifactId, row.detail])).toEqual([
      ["domain.attached", owner.id, artifactId, { hostname }],
      ["domain.removed", owner.id, artifactId, { hostname, reason: "removed" }],
    ]);
  });
});

describe("webhook events", () => {
  it("records creating, changing and removing with the host only", async () => {
    const owner = await teamPlan();
    const actor = personalActor(owner.id);
    const { webhook, secret } = value(
      await createWebhook(db(), {
        actor,
        service: { enabled: true },
        via: "dashboard",
        webhook: {
          url: "https://hooks.example.com/in?token=abc",
          format: "generic",
          events: ["artifact.published"],
        },
        keys: await KEYS(),
        now: NOW,
      }),
    );
    value(
      await updateWebhook(db(), {
        actor,
        webhookId: webhook.id,
        update: { enabled: false },
        service: { enabled: true },
        now: NOW + 1,
      }),
    );
    // The events it already has, and a second disable, change nothing and record nothing.
    for (const update of [{ events: ["artifact.published" as const] }, { enabled: false }]) {
      const same = value(
        await updateWebhook(db(), {
          actor,
          webhookId: webhook.id,
          update,
          service: { enabled: true },
          now: NOW + 1,
        }),
      );
      expect(same.id).toBe(webhook.id);
    }
    value(await removeWebhook(db(), { actor, webhookId: webhook.id, now: NOW + 2 }));
    expect((await removeWebhook(db(), { actor, webhookId: webhook.id, now: NOW + 3 })).ok).toBe(
      false,
    );
    const rows = await events(owner.id);
    expect(rows.map((row) => [row.kind, row.targetId, row.detail])).toEqual([
      [
        "webhook.created",
        webhook.id,
        { host: "hooks.example.com", format: "generic", events: ["artifact.published"] },
      ],
      ["webhook.changed", webhook.id, { enabled: false }],
      ["webhook.removed", webhook.id, {}],
    ]);
    expect(JSON.stringify(rows)).not.toContain("token=abc");
    expect(JSON.stringify(rows)).not.toContain(String(secret));
  });
});

describe("webhook races", () => {
  async function hook(owner: User) {
    return value(
      await createWebhook(db(), {
        actor: personalActor(owner.id),
        service: { enabled: true },
        via: "dashboard",
        webhook: {
          url: "https://hooks.example.com/in",
          format: "generic",
          events: ["artifact.published"],
        },
        keys: await KEYS(),
        now: NOW,
      }),
    ).webhook;
  }
  const disable = (handle: ReturnType<typeof db>, owner: User, webhookId: string) =>
    updateWebhook(handle, {
      actor: personalActor(owner.id),
      webhookId,
      update: { enabled: false },
      service: { enabled: true },
      now: NOW + 1,
    });

  it("records two disables at once as one change, and both answer the webhook", async () => {
    const owner = await teamPlan();
    const webhook = await hook(owner);
    const raced = raceBeforeFirstWrite(async () => {
      value(await disable(db(), owner, webhook.id));
    });
    expect(value(await disable(raced, owner, webhook.id)).id).toBe(webhook.id);
    expect(await kinds(owner.id)).toEqual(["webhook.created", "webhook.changed"]);
  });

  it("answers like a missing webhook when it was removed meanwhile, and records nothing", async () => {
    const owner = await teamPlan();
    const webhook = await hook(owner);
    const raced = raceBeforeFirstWrite(async () => {
      await db().delete(schema.webhooks).where(eq(schema.webhooks.id, webhook.id));
    });
    expect(await disable(raced, owner, webhook.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await kinds(owner.id)).toEqual(["webhook.created"]);
  });
});

describe("brand events", () => {
  it("records saving, the logo and removing, and nothing when a save changes nothing", async () => {
    const owner = await teamPlan();
    const actor = personalActor(owner.id);
    const brand = { name: "Acme", accentColor: "#1a2b3c", link: "https://acme.example.com" };
    const blockedHosts = ["app.portifact.test"];
    value(await updateBrand(db(), { actor, update: brand, blockedHosts, now: NOW }));
    value(await updateBrand(db(), { actor, update: brand, blockedHosts, now: NOW + 1 }));
    value(await setBrandLogo(db(), env.ARTIFACTS, { actor, bytes: png(), now: NOW + 2 }));
    value(await removeBrandLogo(db(), { actor, now: NOW + 3 }));
    value(await deleteBrand(db(), { actor, now: NOW + 4 }));
    expect((await events(owner.id)).map((row) => [row.kind, row.detail])).toEqual([
      ["brand.changed", { fields: ["name", "accent", "link"] }],
      ["brand.changed", { fields: ["logo"] }],
      ["brand.removed", { fields: ["logo"] }],
      ["brand.removed", { fields: ["all"] }],
    ]);
  });
});

describe("transfer events", () => {
  it("records the move out of the source and into the target, on the same batch", async () => {
    const t = await team();
    const { artifactId } = await publishSite(t.admin.id);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId,
        workspace: t.slug,
        now: NOW + 1,
      }),
    );
    expect((await only(t.admin.id, "artifact.transferred_out")).detail).toEqual({
      to: "workspace",
    });
    expect(await only(t.id, "artifact.transferred_in")).toMatchObject({
      actorId: t.admin.id,
      artifactId,
      detail: { from: "personal" },
    });
    // A retry finds the artifact moved and records nothing more.
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId,
        workspace: t.slug,
        now: NOW + 2,
      }),
    );
    expect((await kinds(t.id)).filter((kind) => kind.startsWith("artifact."))).toEqual([
      "artifact.transferred_in",
    ]);
  });

  it("stops showing the old owner the artifact's name once it moved", async () => {
    const t = await team();
    await grantPlan(t.admin.id, "team");
    const { artifactId } = await publishSite(t.admin.id);
    const named = async () =>
      value(await read(personalActor(t.admin.id))).events.map((event) => [
        event.kind,
        event.artifact,
      ]);
    const before = (await named())[0]?.[1] as { id: string; name: string | null };
    expect(before.id).toBe(artifactId);
    expect(before.name).not.toBeNull();
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId,
        workspace: t.slug,
        now: NOW + 1,
      }),
    );
    // What the workspace calls it from now on is not the old owner's to see.
    await db()
      .update(schema.artifacts)
      .set({ name: "Workspace codename" })
      .where(eq(schema.artifacts.id, artifactId));
    expect(await named()).toEqual([
      ["artifact.transferred_out", { id: artifactId, name: null }],
      ["artifact.published", { id: artifactId, name: null }],
    ]);
    const inWorkspace = value(await read(workspaceActor(t, t.admin, "admin")));
    expect(inWorkspace.events.find((e) => e.kind === "artifact.transferred_in")?.artifact).toEqual({
      id: artifactId,
      name: "Workspace codename",
    });
  });
});

describe("member events", () => {
  it("records the first admin, invitations, joining, role changes, removal and leaving", async () => {
    const t = await team();
    const invitee = await user("Grace");
    const sender = recorder();
    const invitation = value(
      await inviteMember(
        global(),
        { userId: t.admin.id, slug: t.slug, email: invitee.email, role: "editor", now: NOW + 1 },
        sender,
      ),
    );
    value(
      await acceptInvitation(global(), {
        userId: invitee.id,
        key: { token: (sender.sent[0] as InvitationMessage).token },
        now: NOW + 2,
      }),
    );
    const second = value(
      await inviteMember(
        global(),
        {
          userId: t.admin.id,
          slug: t.slug,
          email: "later@corp.example",
          role: "member",
          now: NOW + 3,
        },
        recorder(),
      ),
    );
    value(
      await revokeInvitation(global(), {
        userId: t.admin.id,
        slug: t.slug,
        invitationId: second.id,
        now: NOW + 4,
      }),
    );
    value(
      await changeMemberRole(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.member.id,
        role: "editor",
        now: NOW + 5,
      }),
    );
    value(
      await removeMember(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.editor.id,
        now: NOW + 6,
      }),
    );
    value(await leaveWorkspace(global(), { userId: invitee.id, slug: t.slug, now: NOW + 7 }));
    const rows = await events(t.id);
    expect(
      rows.map((row) => [row.kind, row.actorType, row.actorId, row.targetId, row.detail]),
    ).toEqual([
      ["member.joined", "operator", null, t.admin.id, { role: "admin" }],
      [
        "member.invited",
        "user",
        t.admin.id,
        invitation.id,
        { role: "editor", emailDomain: "example.test" },
      ],
      ["member.joined", "user", invitee.id, invitee.id, { role: "editor" }],
      [
        "member.invited",
        "user",
        t.admin.id,
        second.id,
        { role: "member", emailDomain: "corp.example" },
      ],
      ["member.invitation_revoked", "user", t.admin.id, second.id, {}],
      ["member.role_changed", "user", t.admin.id, t.member.id, { from: "member", to: "editor" }],
      ["member.removed", "user", t.admin.id, t.editor.id, { role: "editor" }],
      ["member.left", "user", invitee.id, invitee.id, { role: "editor" }],
    ]);
    // A second accept, a refused removal and an outsider's attempt record nothing.
    expect(
      (
        await acceptInvitation(global(), {
          userId: invitee.id,
          key: { token: (sender.sent[0] as InvitationMessage).token },
          now: NOW + 8,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await removeMember(global(), {
          userId: t.member.id,
          slug: t.slug,
          memberId: t.admin.id,
          now: NOW + 9,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await leaveWorkspace(global(), { userId: t.admin.id, slug: t.slug, now: NOW + 10 })).ok,
    ).toBe(false);
    expect(await events(t.id)).toHaveLength(rows.length);
  });

  it("withdraws the invitation's event when its email cannot be sent", async () => {
    const t = await team();
    const failing: InvitationSender = {
      async send() {
        throw new Error("send failed");
      },
    };
    await expect(
      inviteMember(
        global(),
        { userId: t.admin.id, slug: t.slug, email: "x@corp.example", role: "member", now: NOW },
        failing,
      ),
    ).rejects.toThrow("send failed");
    expect((await kinds(t.id)).filter((kind) => kind === "member.invited")).toEqual([]);
  });

  it("records nothing when the admin loses the role before the write", async () => {
    const t = await team();
    const demote = async () => {
      await db()
        .update(schema.workspaceMembers)
        .set({ role: "member" })
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, t.id),
            eq(schema.workspaceMembers.userId, t.admin.id),
          ),
        );
      await db()
        .update(schema.workspaceMembers)
        .set({ role: "admin" })
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, t.id),
            eq(schema.workspaceMembers.userId, t.editor.id),
          ),
        );
    };
    const result = await changeMemberRole(raceGlobalBeforeFirstWrite(demote), {
      userId: t.admin.id,
      slug: t.slug,
      memberId: t.member.id,
      role: "editor",
      now: NOW + 1,
    });
    expect(result.ok).toBe(false);
    expect(await kinds(t.id)).toEqual(["member.joined"]);
  });
});

describe("plan events", () => {
  it("records a grant once per change and a removal once, with the operator as actor", async () => {
    const owner = await user();
    const grant = {
      ownerId: owner.id,
      plan: "team" as const,
      seats: 3,
      validUntil: NOW + 30 * DAY,
      overrides: null,
      grantedBy: "operator@portifact.example",
      note: "Pilot for ana@corp.example",
      now: NOW,
    };
    value(await setOwnerPlan(global(), grant));
    value(await setOwnerPlan(global(), { ...grant, now: NOW + 1 }));
    value(await setOwnerPlan(global(), { ...grant, seats: 4, now: NOW + 2 }));
    value(await removeOwnerPlan(global(), { ownerId: owner.id, now: NOW + 3 }));
    value(await removeOwnerPlan(global(), { ownerId: owner.id, now: NOW + 4 }));
    const rows = await events(owner.id);
    expect(rows.map((row) => [row.kind, row.actorType, row.actorId, row.detail])).toEqual([
      [
        "plan.granted",
        "operator",
        null,
        { plan: "team", seats: 3, validUntil: new Date(NOW + 30 * DAY).toISOString() },
      ],
      [
        "plan.granted",
        "operator",
        null,
        { plan: "team", seats: 4, validUntil: new Date(NOW + 30 * DAY).toISOString() },
      ],
      ["plan.removed", "operator", null, {}],
    ]);
    expect(JSON.stringify(rows)).not.toContain("@");
    // An owner that does not exist gets no plan and no event.
    expect((await setOwnerPlan(global(), { ...grant, ownerId: "u_missing" })).ok).toBe(false);
    expect(await events("u_missing")).toEqual([]);
  });
});

/** A database over the D1 binding that records the statements of every round trip. */
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
  const global = globalDb(d1);
  return { database: regionalDb(d1, global), trips };
}

describe("cost on the write path", () => {
  it("never sends an event on its own round trip: it rides in the batch of its change", async () => {
    const owner = await teamPlan();
    const { artifactId } = await publishSite(owner.id);
    const t = await team();
    const runs: [
      string,
      (database: ReturnType<typeof recording>["database"]) => Promise<unknown>,
    ][] = [
      ["renew", (d) => renewArtifact(d, at(owner.id, artifactId, NOW + 1))],
      ["pin", (d) => pinArtifact(d, at(owner.id, artifactId, NOW + 2))],
      ["unpin", (d) => unpinArtifact(d, at(owner.id, artifactId, NOW + 3))],
      [
        "access",
        (d) => updateAccess(d, { ...at(owner.id, artifactId, NOW + 4), change: { bar: false } }),
      ],
      [
        "link",
        (d) =>
          createShareLink(d, { ...at(owner.id, artifactId, NOW + 5), label: "x", expiresAt: null }),
      ],
      [
        "role",
        (d) =>
          changeMemberRole(d.global, {
            userId: t.admin.id,
            slug: t.slug,
            memberId: t.member.id,
            role: "editor",
            now: NOW + 6,
          }),
      ],
      ["archive", (d) => archiveArtifact(d, at(owner.id, artifactId, NOW + 7))],
    ];
    for (const [name, run] of runs) {
      const { database, trips } = recording();
      value((await run(database)) as { ok: true; value: unknown });
      const withEvent = trips.filter((trip) => trip.some((q) => q.includes('"audit_events"')));
      expect(withEvent, name).toHaveLength(1);
      // The event shares its round trip with the change it records.
      expect((withEvent[0] as string[]).length, name).toBeGreaterThan(1);
    }
  });
});

describe("reading the audit log", () => {
  it("is for admins on a plan with the feature; editors and members are refused", async () => {
    const t = await team();
    const page = value(await read(workspaceActor(t, t.admin, "admin")));
    expect(page.owner).toEqual({ kind: "workspace", slug: t.slug, name: "Team" });
    expect(page.retentionDays).toBe(90);
    expect(page.events.map((event) => event.kind)).toEqual(["member.joined"]);
    expect(page.events[0]?.actor).toEqual({ type: "operator" });
    expect(page.events[0]?.target).toEqual({
      type: "member",
      id: t.admin.id,
      member: { type: "member", id: t.admin.id, name: "Ada" },
    });
    const forbidden = {
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    };
    expect(await read(workspaceActor(t, t.editor, "editor"))).toEqual(forbidden);
    expect(await read(workspaceActor(t, t.member, "member"))).toEqual(forbidden);
    // Someone who is not a member never gets an actor: the scope answers like a missing one.
    expect((await resolveOwnerScope(global(), t.outsider.id, t.slug)).ok).toBe(false);
  });

  it("answers plan_required without the feature, and a personal space on a paid plan sees its own", async () => {
    const pro = await team("pro");
    expect(await read(workspaceActor(pro, pro.admin, "admin"))).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("audit"),
    });
    const free = await user();
    expect((await read(personalActor(free.id))).ok).toBe(false);
    const paid = await teamPlan();
    await publishSite(paid.id);
    const own = value(await read(personalActor(paid.id)));
    expect(own.owner).toEqual({ kind: "personal" });
    expect(own.events.map((event) => [event.kind, event.actor])).toEqual([
      ["artifact.published", { type: "member", id: paid.id, name: "Ada" }],
    ]);
    expect(own.events[0]?.artifact).toMatchObject({ name: "Plan" });
  });

  it("filters by kind, actor, target and dates, and pages across both databases", async () => {
    const t = await team();
    const { artifactId } = await publishSite(t.admin.id);
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId,
        workspace: t.slug,
        now: NOW + 1000,
      }),
    );
    value(
      await changeMemberRole(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.member.id,
        role: "editor",
        now: NOW + 2000,
      }),
    );
    value(await archiveArtifact(db(), at(t.editor.id, artifactId, NOW + 3000)));
    const admin = workspaceActor(t, t.admin, "admin");
    const all = value(await read(admin));
    expect(all.events.map((event) => event.kind)).toEqual([
      "artifact.archived",
      "member.role_changed",
      "artifact.transferred_in",
      "member.joined",
    ]);
    expect(
      value(await read(admin, { kinds: ["member.role_changed"] })).events.map((e) => e.kind),
    ).toEqual(["member.role_changed"]);
    expect(value(await read(admin, { actor: t.editor.id })).events.map((e) => e.kind)).toEqual([
      "artifact.archived",
    ]);
    expect(value(await read(admin, { target: artifactId })).events).toHaveLength(2);
    expect(value(await read(admin, { target: t.member.id })).events).toHaveLength(1);
    const range = value(
      await read(admin, {
        from: new Date(NOW + 1500).toISOString(),
        to: new Date(NOW + 3000).toISOString(),
      }),
    );
    expect(range.events.map((e) => e.kind)).toEqual(["member.role_changed"]);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = value(await read(admin, {}, { cursor, limit: 1 }));
      seen.push(...page.events.map((event) => event.kind));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.events.map((event) => event.kind));

    expect(await read(admin, {}, { cursor: "not a cursor" })).toMatchObject({
      code: "invalid_input",
    });
    expect(
      await read(admin, {
        from: new Date(NOW + 2).toISOString(),
        to: new Date(NOW + 1).toISOString(),
      }),
    ).toMatchObject({ code: "invalid_input" });
  });

  it("shows someone who left as a removed member, never by name or address", async () => {
    const t = await team();
    value(
      await changeMemberRole(global(), {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.editor.id,
        role: "admin",
        now: NOW + 1,
      }),
    );
    value(await leaveWorkspace(global(), { userId: t.admin.id, slug: t.slug, now: NOW + 2 }));
    const page = value(await read(workspaceActor(t, t.editor, "admin")));
    const left = page.events.find((event) => event.kind === "member.left");
    expect(left?.actor).toEqual({ type: "removed_member", id: t.admin.id });
    expect(JSON.stringify(page)).not.toContain(t.admin.email);
    expect(JSON.stringify(page)).not.toContain("Ada");
  });
});

describe("retention", () => {
  it("lists 90 days, and the scan deletes older events unless the plan keeps them longer", async () => {
    const owner = await teamPlan();
    const kept = await user();
    await grantPlan(kept.id, "enterprise", { overrides: { limits: { auditRetentionDays: 365 } } });
    const old = NOW - 100 * DAY;
    await publishSite(owner.id, undefined, old);
    await publishSite(kept.id, undefined, old);
    await publishSite(owner.id, undefined, NOW);
    expect(value(await read(personalActor(owner.id))).events).toHaveLength(1);
    expect(value(await read(personalActor(kept.id))).events).toHaveLength(1);
    expect(await pruneAuditEvents(db(), global(), NOW + DAY)).toBeGreaterThanOrEqual(1);
    expect(await events(owner.id)).toHaveLength(1);
    expect(await events(kept.id)).toHaveLength(1);
    await pruneAuditEvents(db(), global(), NOW + 300 * DAY);
    expect(await events(kept.id)).toEqual([]);
  });
});

describe("events go with their owner", () => {
  it("erases an account's events when its deletion finishes", async () => {
    const owner = await user();
    await publishSite(owner.id);
    value(
      await setOwnerPlan(global(), {
        ownerId: owner.id,
        plan: "team",
        seats: 1,
        validUntil: null,
        overrides: null,
        grantedBy: "test",
        note: null,
        now: NOW,
      }),
    );
    expect(await events(owner.id)).toHaveLength(2);
    const sessionId = await session(owner.id);
    value(
      await requestAccountDeletion(db(), {
        userId: owner.id,
        sessionId,
        confirmEmail: owner.email,
        now: NOW,
      }),
    );
    for (let i = 0; i < 10; i += 1) {
      await purgeArchived(db(), env.ARTIFACTS, NOW + 1, 500);
      if ((await processAccountDeletions(db(), env.ARTIFACTS, NOW + 1, 100)).processed === 0) break;
    }
    expect(await events(owner.id)).toEqual([]);
  });

  it("erases a workspace's events when its deletion finishes, and after a restore", async () => {
    const t = await team();
    expect(await events(t.id)).not.toEqual([]);
    value(await deleteWorkspace(db(), { workspaceId: t.id, now: NOW + 1 }));
    expect(await advanceWorkspaceDeletion(db(), env.ARTIFACTS, t.id, NOW + 2)).toBe("finished");
    expect(await events(t.id)).toEqual([]);

    // A restore brings events of a deleted owner back; re-applying the tombstones erases them.
    await db()
      .insert(schema.auditEvents)
      .values({
        id: "ae_restored000000000000000",
        ownerId: t.id,
        at: NOW,
        kind: "member.left",
        actorType: "user",
        actorId: t.member.id,
        targetId: t.member.id,
        detail: { role: "member" },
      });
    await applyTombstones(db(), [], NOW + 3);
    expect(await events(t.id)).toEqual([]);
  });

  it("puts a personal space's events in the account export", async () => {
    const owner = await user("Ada");
    const { artifactId } = await publishSite(owner.id);
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    expect(exported.account.auditEvents).toEqual([
      expect.objectContaining({
        kind: "artifact.published",
        actor: { type: "member", id: owner.id, name: "Ada" },
        artifact: { id: artifactId, name: "Plan" },
      }),
    ]);
  });
});

describe("what events never hold", () => {
  it("has no address, token, secret, URL or comment text in any event a scenario writes", async () => {
    const t = await team();
    const owner = t.admin;
    const { artifactId } = await publishSite(owner.id, { "index.html": `<p>${SECRET}</p>` });
    value(
      await updateAccess(db(), {
        ...at(owner.id, artifactId),
        change: { addReaders: ["reader@corp.example"], mode: "restricted" },
      }),
    );
    await grantPlan(owner.id, "team");
    const { token } = value(
      await createShareLink(db(), {
        ...at(owner.id, artifactId),
        label: SECRET,
        expiresAt: null,
        password: "hunter2 password",
      }),
    );
    const { secret } = value(
      await createWebhook(db(), {
        actor: personalActor(owner.id),
        service: { enabled: true },
        via: "dashboard",
        webhook: {
          url: "https://hooks.example.com/path?token=xyz",
          format: "generic",
          events: ["artifact.published"],
        },
        keys: await KEYS(),
        now: NOW,
      }),
    );
    const sender = recorder();
    value(
      await inviteMember(
        global(),
        { userId: owner.id, slug: t.slug, email: "invitee@corp.example", role: "member", now: NOW },
        sender,
      ),
    );
    value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: owner.id,
        artifactId,
        workspace: t.slug,
        now: NOW + 1,
      }),
    );
    const everything = JSON.stringify(await db().select().from(schema.auditEvents));
    for (const forbidden of [
      "@",
      token,
      String(secret),
      (sender.sent[0] as InvitationMessage).token,
      SECRET,
      "hunter2",
      "https://",
      "token=",
      "/path",
    ]) {
      expect(everything).not.toContain(forbidden);
    }
  });
});

describe("a member who deletes their account", () => {
  it("leaves each workspace with a member.left by the system, and no name or address", async () => {
    const [t, other] = [await team(), await team()];
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: other.id, userId: t.editor.id, role: "member", updatedAt: NOW });
    const sessionId = await session(t.editor.id);
    value(
      await requestAccountDeletion(db(), {
        userId: t.editor.id,
        sessionId,
        confirmEmail: t.editor.email,
        now: NOW + 5,
      }),
    );
    for (const [workspace, role] of [
      [t, "editor"],
      [other, "member"],
    ] as const) {
      expect(await only(workspace.id, "member.left")).toMatchObject({
        at: NOW + 5,
        actorType: "system",
        actorId: null,
        targetId: t.editor.id,
        artifactId: null,
        detail: { role },
      });
    }
    const [first, second] = [await only(t.id, "member.left"), await only(other.id, "member.left")];
    expect(first.id).toMatch(/^ae_[0-9a-f]{24}$/);
    expect(first.id).not.toBe(second.id);
    const page = value(await read(workspaceActor(t, t.admin, "admin")));
    const left = page.events.find((event) => event.kind === "member.left");
    expect(left).toMatchObject({
      actor: { type: "system" },
      target: { type: "member", member: { type: "removed_member", id: t.editor.id } },
    });
    expect(JSON.stringify(page)).not.toContain(t.editor.email);
  });

  it("records nothing when the deletion is refused", async () => {
    const t = await team();
    const sessionId = await session(t.admin.id);
    expect(
      await requestAccountDeletion(db(), {
        userId: t.admin.id,
        sessionId,
        confirmEmail: t.admin.email,
        now: NOW + 5,
      }),
    ).toMatchObject({ ok: false, code: "sole_workspace_admin" });
    expect(await kinds(t.id)).not.toContain("member.left");
  });
});

describe("edges of reading and pruning", () => {
  async function insert(
    ownerId: string,
    rows: { id: string; at: number; kind: AuditKind; actorId?: string; detail?: object }[],
  ) {
    for (let i = 0; i < rows.length; i += 10) {
      await db()
        .insert(schema.auditEvents)
        .values(
          rows.slice(i, i + 10).map((row) => ({
            id: row.id,
            ownerId,
            at: row.at,
            kind: row.kind,
            actorType: "user" as const,
            actorId: row.actorId ?? ownerId,
            targetId: ownerId,
            detail: row.detail ?? {},
          })),
        );
    }
  }

  it("lists which kinds live in the global database", () => {
    expect([...GLOBAL_AUDIT_KINDS].sort()).toEqual(
      [
        "email_domain.verified",
        "email_domain.removed",
        "group.created",
        "group.renamed",
        "group.deleted",
        "group.sync_stopped",
        "group.member_added",
        "group.member_removed",
        "sso.created",
        "sso.changed",
        "sso.removed",
        "scim_token.created",
        "scim_token.revoked",
        "member.provisioned",
        "scim.changed",
        "policy.changed",
        "service_token.created",
        "service_token.revoked",
        "domain.attached",
        "domain.removed",
        "member.invited",
        "member.invitation_revoked",
        "member.joined",
        "member.role_changed",
        "member.removed",
        "member.left",
        "plan.granted",
        "plan.removed",
      ].sort(),
    );
  });

  it("orders events at the same moment by ID, newest first, across both databases and the export", async () => {
    const owner = await teamPlan();
    await insert(owner.id, [
      { id: "ae_a", at: NOW, kind: "artifact.renewed" },
      { id: "ae_c", at: NOW, kind: "plan.removed" },
      { id: "ae_b", at: NOW, kind: "artifact.archived" },
      { id: "ae_d", at: NOW - 1, kind: "plan.removed" },
    ]);
    const page = value(await read(personalActor(owner.id)));
    expect(page.events.map((e) => e.id)).toEqual(["ae_c", "ae_b", "ae_a", "ae_d"]);
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    expect(exported.account.auditEvents.map((e) => e.id)).toEqual(["ae_c", "ae_b", "ae_a", "ae_d"]);
    const first = value(await read(personalActor(owner.id), {}, { limit: 2 }));
    expect(first.events.map((e) => e.id)).toEqual(["ae_c", "ae_b"]);
    const second = value(
      await read(personalActor(owner.id), {}, { cursor: first.nextCursor ?? "", limit: 2 }),
    );
    expect(second.events.map((e) => e.id)).toEqual(["ae_a", "ae_d"]);
    expect(second.nextCursor).toBeNull();
    const exact = value(await read(personalActor(owner.id), {}, { limit: 4 }));
    expect(exact.nextCursor).toBeNull();
  });

  it("clamps the page between one and the cap", async () => {
    const owner = await teamPlan();
    await insert(
      owner.id,
      Array.from({ length: 101 }, (_, i) => ({
        id: `ae_${String(i).padStart(4, "0")}`,
        at: NOW - i,
        kind: "artifact.renewed" as const,
      })),
    );
    expect(value(await read(personalActor(owner.id), {}, { limit: 0 })).events).toHaveLength(1);
    const capped = value(await read(personalActor(owner.id), {}, { limit: 1000 }));
    expect(capped.events).toHaveLength(100);
    expect(capped.nextCursor).not.toBeNull();
  });

  it("shows another account in a personal space as a removed member", async () => {
    const owner = await teamPlan();
    const other = await user("Zed");
    await insert(owner.id, [{ id: "ae_x", at: NOW, kind: "artifact.renewed", actorId: other.id }]);
    expect(value(await read(personalActor(owner.id))).events[0]?.actor).toEqual({
      type: "removed_member",
      id: other.id,
    });
  });

  it("prunes in bounded batches, a run at a time", async () => {
    const owner = await user();
    const old = NOW - 100 * DAY;
    await insert(
      owner.id,
      Array.from({ length: 2 * BATCH + 50 }, (_, i) => ({
        id: `ae_old${String(i).padStart(4, "0")}`,
        at: old - i,
        kind: "artifact.renewed" as const,
      })),
    );
    await insert(owner.id, [{ id: "ae_new", at: NOW, kind: "artifact.renewed" }]);
    expect(await pruneAuditEvents(db(), global(), NOW, 1)).toBe(BATCH);
    expect(await events(owner.id)).toHaveLength(BATCH + 51);
    expect(await pruneAuditEvents(db(), global(), NOW)).toBe(BATCH + 50);
    expect((await events(owner.id)).map((row) => row.id)).toEqual(["ae_new"]);
  });
});
