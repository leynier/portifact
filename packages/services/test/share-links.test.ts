// Share links (premium plan P4, decision 0008): the owner's create, list and revoke with the plan
// gate and role checks, the visitor's open, redeem and refresh, and what keeps a link's answers
// indistinguishable, its token unstored and its revocation permanent.
import { env } from "cloudflare:test";
import { planRequiredMessage, SHARE_LINKS } from "@portifact/contracts";
import { accessSchema, createAccessDb, regionalDb, regionsFromEnv, schema } from "@portifact/db";
import { SHARE_MESSAGES } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccessLog, recordOpenings } from "../src/access-log.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { hashSecret } from "../src/read-access.ts";
import {
  constantTimeEqual,
  createShareLink,
  hashSharePassword,
  listShareLinks,
  openShareLink,
  pruneShareLinks,
  redeemShareHandoff,
  refreshShareSession,
  revokeShareLink,
  verifySharePassword,
} from "../src/share-links.ts";
import { DAY, db, grantPlan, NOW, publishSite, user, value } from "./fixtures.ts";

const MISSING_TOKEN = "A".repeat(43);
const access = () => createAccessDb(env.ACCESS_DB);

afterEach(() => {
  vi.restoreAllMocks();
});

/** An owner on Pro with one published artifact. */
async function owned(plan: "free" | "pro" = "pro") {
  const owner = await user();
  if (plan !== "free") await grantPlan(owner.id, plan);
  const { artifactId } = await publishSite(owner.id);
  return { owner, artifactId };
}

async function create(
  userId: string,
  artifactId: string,
  extra: { expiresAt?: number | null; password?: string; label?: string; now?: number } = {},
) {
  return createShareLink(db(), {
    userId,
    artifactId,
    label: extra.label ?? "For Ana",
    expiresAt: extra.expiresAt ?? null,
    password: extra.password,
    now: extra.now ?? NOW,
  });
}

async function linkRow(id: string) {
  const [row] = await db().select().from(schema.shareLinks).where(eq(schema.shareLinks.id, id));
  return row;
}

async function workspaceWith(admin: string, roles: Record<string, "editor" | "member">) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .insert(schema.workspaces)
    .values({ id, slug: id.slice(3, 23), name: "Team", createdBy: admin, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: admin, role: "admin", updatedAt: NOW },
      ...Object.entries(roles).map(([userId, role]) => ({
        workspaceId: id,
        userId,
        role,
        updatedAt: NOW,
      })),
    ]);
  return id;
}

describe("createShareLink", () => {
  it("is refused on free with plan_required and allowed on pro", async () => {
    const { owner, artifactId } = await owned("free");
    expect(await create(owner.id, artifactId)).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("shareLinks"),
    });
    await grantPlan(owner.id, "pro");
    const created = value(await create(owner.id, artifactId));
    expect(created.link).toMatchObject({
      label: "For Ana",
      hasPassword: false,
      expiresAt: null,
      lastUsedAt: null,
      state: "active",
    });
    expect(created.link.id).toMatch(/^sl_[0-9a-f]{32}$/);
  });

  it("returns a 256-bit token once and stores only its hash", async () => {
    const { owner, artifactId } = await owned();
    const created = value(await create(owner.id, artifactId));
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await linkRow(created.link.id);
    expect(row?.tokenHash).toBe(await hashSecret(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);
    const other = value(await create(owner.id, artifactId));
    expect(other.token).not.toBe(created.token);
  });

  it("hashes a password with a salt and the iteration count, never storing it", async () => {
    const { owner, artifactId } = await owned();
    const created = value(await create(owner.id, artifactId, { password: "correct horse" }));
    expect(created.link.hasPassword).toBe(true);
    const row = await linkRow(created.link.id);
    expect(row?.passwordIterations).toBe(SHARE_LINKS.passwordIterations);
    expect(row?.passwordSalt).toHaveLength(24);
    expect(JSON.stringify(row)).not.toContain("correct horse");
  });

  it("checks the expiry", async () => {
    const { owner, artifactId } = await owned();
    expect(await create(owner.id, artifactId, { expiresAt: NOW - 1 })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      await create(owner.id, artifactId, { expiresAt: NOW + SHARE_LINKS.maxExpiryDays * DAY + 1 }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const link = value(await create(owner.id, artifactId, { expiresAt: NOW + DAY })).link;
    expect(link.expiresAt).toBe(NOW + DAY);
  });

  it("keeps at most 20 active links; revoked and expired ones do not count", async () => {
    const { owner, artifactId } = await owned();
    const first = value(await create(owner.id, artifactId, { expiresAt: NOW + 1000 })).link;
    for (let i = 1; i < SHARE_LINKS.activePerArtifact; i += 1) {
      value(await create(owner.id, artifactId));
    }
    expect(await create(owner.id, artifactId)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "An artifact can have at most 20 active share links. Revoke one first.",
    });
    // Once the first one expires, there is room again.
    value(await create(owner.id, artifactId, { now: NOW + 1000 }));
    expect(first.state).toBe("active");
    const links = value(
      await listShareLinks(db(), { userId: owner.id, artifactId, now: NOW + 1000 }),
    );
    const revoke = links.links.find((link) => link.state === "active");
    value(
      await revokeShareLink(db(), {
        userId: owner.id,
        artifactId,
        linkId: revoke?.id as string,
        now: NOW + 1000,
      }),
    );
    value(await create(owner.id, artifactId, { now: NOW + 1000 }));
  });

  it("answers a stranger and a missing artifact the same, and refuses a member", async () => {
    const { artifactId } = await owned();
    const stranger = await user();
    const missing = await create(stranger.id, "zzzzzzzzzz");
    expect(await create(stranger.id, artifactId)).toEqual(missing);
    expect(missing).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });

    const admin = await user();
    const editor = await user();
    const member = await user();
    const workspace = await workspaceWith(admin.id, {
      [editor.id]: "editor",
      [member.id]: "member",
    });
    const shared = value(
      await (async () => {
        const { preparePublish, commitPublish } = await import("../src/publish.ts");
        const body = `<p>${crypto.randomUUID()}</p>`;
        const digest = await hashSecret(body);
        const prepared = value(
          await preparePublish(db(), {
            userId: editor.id,
            targetOwnerId: workspace,
            type: "site",
            name: "Team plan",
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
          }),
        );
        await env.ARTIFACTS.put(`objects/${workspace}/${digest}`, body);
        return commitPublish(db(), env.ARTIFACTS, {
          userId: editor.id,
          sessionId: prepared.sessionId,
          now: NOW,
        });
      })(),
    ).artifactId;

    // The workspace's plan decides, not the editor's.
    await grantPlan(editor.id, "enterprise");
    expect(await create(editor.id, shared)).toMatchObject({ ok: false, code: "plan_required" });
    await grantPlan(workspace, "team");
    await grantPlan(editor.id, "free");
    expect((await create(editor.id, shared)).ok).toBe(true);
    expect((await create(admin.id, shared)).ok).toBe(true);
    expect(await create(member.id, shared)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await create(stranger.id, shared)).toEqual(missing);
  });
});

describe("listShareLinks and revokeShareLink", () => {
  it("lists live links newest first without the token, and hides revoked ones", async () => {
    const { owner, artifactId } = await owned();
    const older = value(await create(owner.id, artifactId, { label: "older", now: NOW - 10 }));
    const newer = value(
      await create(owner.id, artifactId, { label: "newer", password: "longenough" }),
    );
    const listing = value(await listShareLinks(db(), { userId: owner.id, artifactId, now: NOW }));
    expect(listing.enabled).toBe(true);
    expect(listing.links.map((link) => link.label)).toEqual(["newer", "older"]);
    expect(listing.links[0]?.hasPassword).toBe(true);
    expect(JSON.stringify(listing)).not.toContain(older.token);
    expect(JSON.stringify(listing)).not.toContain(newer.token);

    expect(
      value(
        await revokeShareLink(db(), {
          userId: owner.id,
          artifactId,
          linkId: older.link.id,
          now: NOW,
        }),
      ),
    ).toEqual({ id: older.link.id });
    const after = value(await listShareLinks(db(), { userId: owner.id, artifactId, now: NOW }));
    expect(after.links.map((link) => link.label)).toEqual(["newer"]);
    expect(
      await revokeShareLink(db(), {
        userId: owner.id,
        artifactId,
        linkId: older.link.id,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      code: "not_found",
      message: "Share link not found.",
    });
  });

  it("lists and revokes without the plan, saying links are paused", async () => {
    const { owner, artifactId } = await owned();
    const link = value(await create(owner.id, artifactId)).link;
    await grantPlan(owner.id, "free");
    const listing = value(await listShareLinks(db(), { userId: owner.id, artifactId, now: NOW }));
    expect(listing.enabled).toBe(false);
    expect(listing.links).toHaveLength(1);
    expect(
      (await revokeShareLink(db(), { userId: owner.id, artifactId, linkId: link.id, now: NOW })).ok,
    ).toBe(true);
  });

  it("does not revoke another artifact's link, nor for someone else", async () => {
    const { owner, artifactId } = await owned();
    const other = await owned();
    const link = value(await create(other.owner.id, other.artifactId)).link;
    expect(
      await revokeShareLink(db(), { userId: owner.id, artifactId, linkId: link.id, now: NOW }),
    ).toMatchObject({ ok: false, code: "not_found" });
    expect(
      await revokeShareLink(db(), {
        userId: owner.id,
        artifactId: other.artifactId,
        linkId: link.id,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
    expect(
      await listShareLinks(db(), { userId: owner.id, artifactId: other.artifactId, now: NOW }),
    ).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
    expect((await linkRow(link.id))?.revokedAt).toBeNull();
  });
});

describe("openShareLink", () => {
  it("opens a link without a password, stores only the code's hash and the day it was used", async () => {
    const { owner, artifactId } = await owned();
    const { link, token } = value(await create(owner.id, artifactId));
    const opened = await openShareLink([db()], {
      customDomains: true,
      token,
      now: NOW + 5 * 3_600_000,
      contentDomain: "portifact.dev",
    });
    if (opened.kind !== "opened") throw new Error(opened.kind);
    expect(opened.artifactId).toBe(artifactId);
    const [handoff] = await db()
      .select()
      .from(schema.shareHandoffs)
      .where(eq(schema.shareHandoffs.codeHash, await hashSecret(opened.code)));
    expect(handoff).toMatchObject({ linkId: link.id, artifactId, usedAt: null });
    expect(handoff?.expiresAt).toBe(NOW + 5 * 3_600_000 + SHARE_LINKS.handoffTtlSeconds * 1000);
    expect((await linkRow(link.id))?.lastUsedAt).toBe(Date.parse("2026-11-08T00:00:00Z"));
  });

  it("asks for a password, refuses a wrong one and opens with the right one", async () => {
    const { owner, artifactId } = await owned();
    const { token } = value(await create(owner.id, artifactId, { password: "correct horse" }));
    expect(
      await openShareLink([db()], {
        customDomains: true,
        token,
        now: NOW,
        contentDomain: "portifact.dev",
      }),
    ).toEqual({ kind: "password_required" });
    expect(
      await openShareLink([db()], {
        customDomains: true,
        token,
        password: "wrong horse",
        now: NOW,
        contentDomain: "portifact.dev",
      }),
    ).toEqual({
      kind: "refused",
    });
    expect(
      (
        await openShareLink([db()], {
          customDomains: true,
          token,
          password: "correct horse",
          now: NOW,
          contentDomain: "portifact.dev",
        })
      ).kind,
    ).toBe("opened");
  });

  it("answers unknown, expired, revoked and paused links exactly alike", async () => {
    const { owner, artifactId } = await owned();
    const expired = value(await create(owner.id, artifactId, { expiresAt: NOW + 1 }));
    const revoked = value(await create(owner.id, artifactId, { password: "longenough" }));
    value(
      await revokeShareLink(db(), {
        userId: owner.id,
        artifactId,
        linkId: revoked.link.id,
        now: NOW,
      }),
    );
    const later = NOW + 10;
    for (const token of [MISSING_TOKEN, expired.token, revoked.token]) {
      expect(
        await openShareLink([db()], {
          customDomains: true,
          token,
          now: later,
          contentDomain: "portifact.dev",
        }),
      ).toEqual({ kind: "unavailable" });
      expect(
        await openShareLink([db()], {
          customDomains: true,
          token,
          password: "longenough",
          now: later,
          contentDomain: "portifact.dev",
        }),
      ).toEqual({
        kind: "refused",
      });
    }
  });

  it("stops while the plan lacks share links and works again when it returns", async () => {
    const { owner, artifactId } = await owned();
    const { token } = value(await create(owner.id, artifactId));
    await grantPlan(owner.id, "free");
    expect(
      await openShareLink([db()], {
        customDomains: true,
        token,
        now: NOW,
        contentDomain: "portifact.dev",
      }),
    ).toEqual({ kind: "unavailable" });
    await grantPlan(owner.id, "pro", { validUntil: NOW - 1 });
    expect(
      await openShareLink([db()], {
        customDomains: true,
        token,
        now: NOW,
        contentDomain: "portifact.dev",
      }),
    ).toEqual({ kind: "unavailable" });
    await grantPlan(owner.id, "pro");
    expect(
      (
        await openShareLink([db()], {
          customDomains: true,
          token,
          now: NOW,
          contentDomain: "portifact.dev",
        })
      ).kind,
    ).toBe("opened");
  });

  it("refuses links of archived, suspended and expired artifacts", async () => {
    for (const change of [
      { state: "archived" as const, archivedAt: NOW - 1 },
      { state: "suspended" as const },
      { expiresAt: NOW - 1 },
    ]) {
      const { owner, artifactId } = await owned();
      const { token } = value(await create(owner.id, artifactId));
      await db().update(schema.artifacts).set(change).where(eq(schema.artifacts.id, artifactId));
      expect(
        await openShareLink([db()], {
          customDomains: true,
          token,
          now: NOW,
          contentDomain: "portifact.dev",
        }),
      ).toEqual({ kind: "unavailable" });
    }
  });

  it("derives exactly once for a missing link, a link without a password and a wrong one", async () => {
    const { owner, artifactId } = await owned();
    const plain = value(await create(owner.id, artifactId));
    const locked = value(await create(owner.id, artifactId, { password: "correct horse" }));
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    for (const token of [MISSING_TOKEN, plain.token, locked.token]) {
      derive.mockClear();
      await openShareLink([db()], {
        customDomains: true,
        token,
        password: "some guess",
        now: NOW,
        contentDomain: "portifact.dev",
      });
      expect(derive).toHaveBeenCalledTimes(1);
      expect(derive.mock.calls[0]?.[0]).toMatchObject({
        iterations: SHARE_LINKS.passwordIterations,
      });
    }
    derive.mockClear();
    await openShareLink([db()], {
      customDomains: true,
      token: MISSING_TOKEN,
      now: NOW,
      contentDomain: "portifact.dev",
    });
    expect(derive).not.toHaveBeenCalled();
  });
});

describe("passwords", () => {
  it("verify only the right password, and never without a stored hash", async () => {
    const stored = await hashSharePassword("correct horse", 1000);
    expect(await verifySharePassword("correct horse", stored)).toBe(true);
    expect(await verifySharePassword("correct horsf", stored)).toBe(false);
    expect(await verifySharePassword("", stored)).toBe(false);
    expect(await verifySharePassword("anything", null)).toBe(false);
    const again = await hashSharePassword("correct horse", 1000);
    expect(again.salt).not.toBe(stored.salt);
    expect(again.hash).not.toBe(stored.hash);
  });

  it("compare in constant time over the longer input", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([0]))).toBe(false);
  });
});

describe("redeemShareHandoff and refreshShareSession", () => {
  async function opened(extra: { expiresAt?: number | null } = {}) {
    const { owner, artifactId } = await owned();
    const { link, token } = value(await create(owner.id, artifactId, extra));
    const result = await openShareLink([db()], {
      customDomains: true,
      token,
      now: NOW,
      contentDomain: "portifact.dev",
    });
    if (result.kind !== "opened") throw new Error(result.kind);
    return { owner, artifactId, link, code: result.code };
  }

  it("redeems a code once, for its own artifact only", async () => {
    const { artifactId, link, code } = await opened();
    const other = await owned();
    expect(
      await redeemShareHandoff(db(), {
        code,
        artifactId: other.artifactId,
        now: NOW,
        host: `${other.artifactId}.portifact.dev`,
        devHost: `${other.artifactId}.portifact.dev`,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const session = value(
      await redeemShareHandoff(db(), {
        code,
        artifactId,
        now: NOW,
        host: `${artifactId}.portifact.dev`,
        devHost: `${artifactId}.portifact.dev`,
      }),
    );
    expect(session.linkId).toBe(link.id);
    expect(session.expiresAt).toBe(NOW + SHARE_LINKS.sessionTtlSeconds * 1000);
    expect(
      await redeemShareHandoff(db(), {
        code,
        artifactId,
        now: NOW,
        host: `${artifactId}.portifact.dev`,
        devHost: `${artifactId}.portifact.dev`,
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    const sessions = await db()
      .select()
      .from(schema.shareSessions)
      .where(eq(schema.shareSessions.linkId, link.id));
    expect(sessions).toHaveLength(1);
  });

  it("refuses an expired code and a code whose link was revoked meanwhile", async () => {
    const first = await opened();
    expect(
      await redeemShareHandoff(db(), {
        code: first.code,
        artifactId: first.artifactId,
        now: NOW + SHARE_LINKS.handoffTtlSeconds * 1000,
        host: `${first.artifactId}.portifact.dev`,
        devHost: `${first.artifactId}.portifact.dev`,
      }),
    ).toMatchObject({ ok: false });
    const second = await opened();
    value(
      await revokeShareLink(db(), {
        userId: second.owner.id,
        artifactId: second.artifactId,
        linkId: second.link.id,
        now: NOW,
      }),
    );
    expect(
      await redeemShareHandoff(db(), {
        code: second.code,
        artifactId: second.artifactId,
        now: NOW,
        host: `${second.artifactId}.portifact.dev`,
        devHost: `${second.artifactId}.portifact.dev`,
      }),
    ).toMatchObject({ ok: false });
  });

  it("ends the session with the link's expiry and renews it while the link lives", async () => {
    const { owner, artifactId, link, code } = await opened({ expiresAt: NOW + 3_600_000 });
    const session = value(
      await redeemShareHandoff(db(), {
        code,
        artifactId,
        now: NOW,
        host: `${artifactId}.portifact.dev`,
        devHost: `${artifactId}.portifact.dev`,
      }),
    );
    expect(session.expiresAt).toBe(NOW + 3_600_000);
    const input = { sessionId: session.sessionId, artifactId, linkId: link.id };
    expect(value(await refreshShareSession(db(), { ...input, now: NOW + 60_000 }))).toEqual({
      expiresAt: NOW + 3_600_000,
    });
    expect(await refreshShareSession(db(), { ...input, now: NOW + 3_600_000 })).toMatchObject({
      ok: false,
      message: SHARE_MESSAGES.unavailable,
    });
    expect(
      await refreshShareSession(db(), {
        ...input,
        linkId: "sl_00000000000000000000000000000000",
        now: NOW,
      }),
    ).toMatchObject({ ok: false });
    value(await revokeShareLink(db(), { userId: owner.id, artifactId, linkId: link.id, now: NOW }));
    expect(await refreshShareSession(db(), { ...input, now: NOW + 1 })).toMatchObject({
      ok: false,
    });
  });
});

describe("pruneShareLinks", () => {
  it("deletes spent codes and sessions, and old links, tombstoning the revoked ones", async () => {
    const { owner, artifactId } = await owned();
    const revoked = value(await create(owner.id, artifactId, { label: "revoked" })).link;
    const expired = value(
      await create(owner.id, artifactId, { label: "expired", expiresAt: NOW + 1 }),
    ).link;
    const live = value(await create(owner.id, artifactId, { label: "live" }));
    const opened = await openShareLink([db()], {
      customDomains: true,
      token: live.token,
      now: NOW,
      contentDomain: "portifact.dev",
    });
    if (opened.kind !== "opened") throw new Error(opened.kind);
    value(
      await redeemShareHandoff(db(), {
        code: opened.code,
        artifactId,
        now: NOW,
        host: `${artifactId}.portifact.dev`,
        devHost: `${artifactId}.portifact.dev`,
      }),
    );
    value(
      await revokeShareLink(db(), { userId: owner.id, artifactId, linkId: revoked.id, now: NOW }),
    );

    const later = NOW + 31 * DAY;
    await pruneShareLinks(db(), later);
    expect(await linkRow(revoked.id)).toBeUndefined();
    expect(await linkRow(expired.id)).toBeUndefined();
    expect(await linkRow(live.link.id)).toBeDefined();
    const tombstones = await db()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.kind, "share_link"));
    expect(tombstones.map((row) => row.id)).toContain(revoked.id);
    expect(tombstones.map((row) => row.id)).not.toContain(expired.id);
    const leftover = await db()
      .select()
      .from(schema.shareSessions)
      .where(eq(schema.shareSessions.artifactId, artifactId));
    expect(leftover).toEqual([]);
    const codes = await db()
      .select()
      .from(schema.shareHandoffs)
      .where(eq(schema.shareHandoffs.artifactId, artifactId));
    expect(codes).toEqual([]);
  });
});

describe("restores, purges and the access log", () => {
  it("exports revoked links and revokes them again after a restore", async () => {
    const { owner, artifactId } = await owned();
    const { link, token } = value(await create(owner.id, artifactId));
    value(await revokeShareLink(db(), { userId: owner.id, artifactId, linkId: link.id, now: NOW }));
    const markers = await exportTombstones(regionsFromEnv(env));
    expect(markers).toContainEqual({ kind: "share_link", id: link.id, deletedAt: NOW });
    // A Time Travel restore to before the revocation brings the link back.
    await db()
      .update(schema.shareLinks)
      .set({ revokedAt: null })
      .where(eq(schema.shareLinks.id, link.id));
    expect(
      (
        await openShareLink([db()], {
          customDomains: true,
          token,
          now: NOW,
          contentDomain: "portifact.dev",
        })
      ).kind,
    ).toBe("opened");
    const result = await applyTombstones(db(), markers, NOW + 1);
    expect(result.shareLinks).toBeGreaterThanOrEqual(1);
    expect(
      await openShareLink([db()], {
        customDomains: true,
        token,
        now: NOW + 2,
        contentDomain: "portifact.dev",
      }),
    ).toEqual({ kind: "unavailable" });
    expect((await applyTombstones(db(), markers, NOW + 3)).shareLinks).toBe(0);
  });

  it("goes with its artifact", async () => {
    const { owner, artifactId } = await owned();
    const { link } = value(await create(owner.id, artifactId));
    await db().delete(schema.artifacts).where(eq(schema.artifacts.id, artifactId));
    expect(await linkRow(link.id)).toBeUndefined();
  });

  it("records openings per link, without an identity, and shows the label to the owner", async () => {
    const { owner, artifactId } = await owned();
    await db()
      .update(schema.artifacts)
      .set({ accessMode: "restricted" })
      .where(eq(schema.artifacts.id, artifactId));
    const { link } = value(await create(owner.id, artifactId, { label: "Board" }));
    const other = await owned();
    const foreign = value(await create(other.owner.id, other.artifactId)).link;
    const written = await recordOpenings(db(), access(), [
      { artifactId, userId: link.id, linkId: link.id, at: NOW },
      // A link of another artifact, or a link ID that does not match its key, is dropped.
      { artifactId, userId: foreign.id, linkId: foreign.id, at: NOW },
      { artifactId, userId: "u_someone", linkId: link.id, at: NOW },
    ]);
    expect(written).toBe(1);
    const rows = await access()
      .select()
      .from(accessSchema.accessEvents)
      .where(and(eq(accessSchema.accessEvents.artifactId, artifactId)));
    expect(rows).toEqual([
      expect.objectContaining({ userId: link.id, linkId: link.id, email: "", ownerId: owner.id }),
    ]);
    const log = value(
      await getAccessLog(db(), access(), { userId: owner.id, artifactId, limit: 10, now: NOW }),
    );
    expect(log.entries).toEqual([
      { email: "", openedAt: NOW, shareLink: { id: link.id, label: "Board" } },
    ]);
  });
});

describe("links in another region", () => {
  it("finds a link in the region that holds it and writes the code there", async () => {
    // A second region with its own database; the plan stays in the global one.
    const second = regionalDb(env.SECOND_DB, db().global);
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const artifactId = "r2gn2rtfct";
    await second.insert(schema.artifacts).values({
      id: artifactId,
      ownerId: owner.id,
      type: "site",
      name: "Elsewhere",
      state: "active",
      accessMode: "restricted",
      currentVersionId: "v_elsewhere",
      expiresAt: NOW + DAY,
    });
    const token = "R".repeat(43);
    const linkId = `sl_${"e".repeat(32)}`;
    await second.insert(schema.shareLinks).values({
      id: linkId,
      artifactId,
      tokenHash: await hashSecret(token),
      label: "Elsewhere",
      createdBy: owner.id,
      createdAt: NOW,
    });

    const opened = await openShareLink([db(), second], {
      customDomains: true,
      token,
      now: NOW,
      contentDomain: "portifact.dev",
    });
    if (opened.kind !== "opened") throw new Error(opened.kind);
    expect(opened.artifactId).toBe(artifactId);
    const codeHash = await hashSecret(opened.code);
    const inSecond = await second
      .select()
      .from(schema.shareHandoffs)
      .where(eq(schema.shareHandoffs.codeHash, codeHash));
    const inDefault = await db()
      .select()
      .from(schema.shareHandoffs)
      .where(eq(schema.shareHandoffs.codeHash, codeHash));
    expect(inSecond).toHaveLength(1);
    expect(inDefault).toEqual([]);
    // The artifact origin redeems it in the artifact's region.
    expect(
      (
        await redeemShareHandoff(second, {
          code: opened.code,
          artifactId,
          now: NOW,
          host: `${artifactId}.portifact.dev`,
          devHost: `${artifactId}.portifact.dev`,
        })
      ).ok,
    ).toBe(true);
    // A token no region holds still costs one derivation and answers like any other.
    expect(
      await openShareLink([db(), second], {
        customDomains: true,
        token: "Q".repeat(43),
        now: NOW,
        contentDomain: "portifact.dev",
      }),
    ).toEqual({
      kind: "unavailable",
    });
  });
});

describe("the account behind links", () => {
  it("exports the owner's links without their token or hash", async () => {
    const { exportAccount } = await import("../src/account-data.ts");
    const { owner, artifactId } = await owned();
    const live = value(
      await create(owner.id, artifactId, { label: "Board", password: "longenough" }),
    );
    const gone = value(await create(owner.id, artifactId, { label: "Old", expiresAt: NOW + DAY }));
    value(
      await revokeShareLink(db(), { userId: owner.id, artifactId, linkId: gone.link.id, now: NOW }),
    );
    const exported = value(await exportAccount(db(), { userId: owner.id, now: NOW }));
    const artifact = exported.artifacts.find((a) => a.id === artifactId);
    const sorted = [...(artifact?.shareLinks ?? [])].sort((a, b) => a.label.localeCompare(b.label));
    expect(sorted).toEqual([
      {
        label: "Board",
        state: "active",
        hasPassword: true,
        createdAt: new Date(NOW).toISOString(),
        expiresAt: null,
      },
      {
        label: "Old",
        state: "revoked",
        hasPassword: false,
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + DAY).toISOString(),
      },
    ]);
    const text = JSON.stringify(exported);
    expect(text).not.toContain(live.token);
    expect(text).not.toContain(await hashSecret(live.token));
  });

  it("forgets who created a link when that account is deleted, also after a restore", async () => {
    const { advanceAccountDeletion } = await import("../src/account-data.ts");
    const admin = await user();
    const editor = await user();
    const workspace = await workspaceWith(admin.id, { [editor.id]: "editor" });
    await grantPlan(workspace, "team");
    const { artifactId } = await publishSite(admin.id);
    // A workspace artifact: moved by row, as nothing moves artifacts between owners yet.
    await db()
      .update(schema.artifacts)
      .set({ ownerId: workspace })
      .where(eq(schema.artifacts.id, artifactId));
    const { link } = value(await create(editor.id, artifactId));
    expect((await linkRow(link.id))?.createdBy).toBe(editor.id);

    await db().insert(schema.accountDeletions).values({ userId: editor.id, requestedAt: NOW });
    await advanceAccountDeletion(regionsFromEnv(env), editor.id, NOW);
    expect((await linkRow(link.id))?.createdBy).toBeNull();

    // A restore brings the old value back; re-applying the account's tombstone clears it again.
    await db()
      .update(schema.shareLinks)
      .set({ createdBy: editor.id })
      .where(eq(schema.shareLinks.id, link.id));
    await applyTombstones(db(), [{ kind: "account", id: editor.id, deletedAt: NOW }], NOW);
    expect((await linkRow(link.id))?.createdBy).toBeNull();
  });
});
