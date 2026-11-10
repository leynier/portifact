// The `workspace` and `domain` access modes and verified email domains (premium plan T2,
// decision 0010): who reads in each mode through every read path, how a mode is set, how a
// workspace proves a domain and what the re-check, removal, transfer, export and a restore do.
import { env } from "cloudflare:test";
import type { AnnotationTarget } from "@portifact/contracts";
import { regionsFromEnv, schema } from "@portifact/db";
import { entitlements } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccess, updateAccess } from "../src/access.ts";
import { exportAccount } from "../src/account-data.ts";
import { createAnnotationThread, type HumanCheck, listAnnotations } from "../src/annotations.ts";
import { applyTombstones, exportTombstones } from "../src/backups.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import {
  checkReadAccess,
  issueReadHandoff,
  readEntryConfirmation,
  redeemReadHandoff,
  refreshReadSession,
} from "../src/read-access.ts";
import { FakeDomains } from "../src/testing/fake-domains.ts";
import { transferArtifact } from "../src/transfer.ts";
import { getViewerArtifact } from "../src/viewer.ts";
import {
  accessAudience,
  addWorkspaceDomain,
  listWorkspaceDomains,
  policyDomains,
  publicSuffixOf,
  recheckEmailDomains,
  removeWorkspaceDomain,
  verifyWorkspaceDomain,
} from "../src/workspace-domains.ts";
import { removeMember } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, session, sha256, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

const HUMAN: HumanCheck = { token: "solved", verify: async () => "passed" };
const DOC: AnnotationTarget = { schema: 1, path: "index.html", anchor: { kind: "document" } };
const HOUR = 3_600_000;

const hex = () => crypto.randomUUID().replaceAll("-", "");

async function person(email: string, verified = true) {
  const id = `u_${hex()}`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: "Someone",
      email,
      emailVerified: verified,
      createdAt: new Date(NOW - 30 * DAY),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

interface Team {
  id: string;
  slug: string;
  /** A domain unique to this test, so tests sharing a database never collide. */
  domain: string;
  admin: { id: string; email: string };
  editor: { id: string; email: string };
  member: { id: string; email: string };
  /** Verified address at the domain, not a member. */
  colleague: { id: string; email: string };
  /** Unverified address at the domain. */
  unverified: { id: string; email: string };
  /** Verified address at a subdomain. */
  subdomain: { id: string; email: string };
  outsider: { id: string; email: string };
}

async function team(plan: "team" | "free" = "team"): Promise<Team> {
  const id = `ws_${hex()}`;
  const slug = `t${hex().slice(0, 20)}`;
  const domain = `acme${hex().slice(0, 10)}.com`;
  const t: Team = {
    id,
    slug,
    domain,
    admin: await person(`admin@${hex().slice(0, 8)}.org`),
    editor: await person(`editor@${hex().slice(0, 8)}.org`),
    member: await person(`member@${hex().slice(0, 8)}.org`),
    colleague: await person(`dana@${domain.toUpperCase()}`),
    unverified: await person(`ulla@${domain}`, false),
    subdomain: await person(`sam@eng.${domain}`),
    outsider: await person(`out@${hex().slice(0, 8)}.org`),
  };
  await db()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Team", createdBy: t.admin.id, updatedAt: NOW });
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: id, userId: t.admin.id, role: "admin", updatedAt: NOW },
      { workspaceId: id, userId: t.editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: id, userId: t.member.id, role: "member", updatedAt: NOW },
    ]);
  if (plan === "team") await grantPlan(id, "team", { seats: 10 });
  return t;
}

async function publishIn(userId: string, ownerId: string) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const prepared = value(
    await preparePublish(db(), {
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
          sha256: await sha256(body),
          size: body.length,
          contentType: "text/html",
        },
      ],
      now: NOW,
    }),
  );
  await env.ARTIFACTS.put(`objects/${ownerId}/${await sha256(body)}`, body);
  return value(
    await commitPublish(db(), env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now: NOW }),
  ).artifactId;
}

/** Adds and verifies the team's domain through the real flow. */
async function verified(t: Team, dns = new FakeDomains(), domain = t.domain) {
  const claim = value(
    await addWorkspaceDomain(db().global, { userId: t.admin.id, slug: t.slug, domain, now: NOW }),
  );
  dns.publishTxt(`_portifact-email.${claim.domain}`, `portifact-email-verify=${claim.token}`);
  return value(
    await verifyWorkspaceDomain(db().global, dns, {
      userId: t.admin.id,
      slug: t.slug,
      domainId: claim.id,
      now: NOW,
    }),
  );
}

async function setMode(t: Team, artifactId: string, mode: "workspace" | "domain" | "restricted") {
  return updateAccess(db(), {
    userId: t.admin.id,
    artifactId,
    change: { mode },
    now: NOW,
  });
}

const reads = async (artifactId: string, userId: string, now = NOW) =>
  (await checkReadAccess(db(), { artifactId, userId, now })).ok;

describe("setting the workspace modes", () => {
  it("refuses a personal artifact with a typed answer, the same for both modes", async () => {
    const owner = await person(`solo@${hex().slice(0, 8)}.org`);
    const artifactId = await publishIn(owner.id, owner.id);
    for (const mode of ["workspace", "domain"] as const) {
      expect(
        await updateAccess(db(), { userId: owner.id, artifactId, change: { mode }, now: NOW }),
      ).toEqual({
        ok: false,
        code: "invalid_input",
        message: "Only workspace artifacts can be shared with a workspace or an email domain.",
      });
    }
  });

  it("needs workspaces in the owner's plan, checked after authorization", async () => {
    const t = await team("free");
    const artifactId = await publishIn(t.admin.id, t.id);
    for (const mode of ["workspace", "domain"] as const) {
      expect(await setMode(t, artifactId, mode)).toEqual({
        ok: false,
        code: "plan_required",
        message: "Using workspaces is part of the Team plan.",
      });
    }
    // A member is forbidden and an outsider gets the missing answer before the plan is read.
    expect(
      await updateAccess(db(), {
        userId: t.member.id,
        artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(
      await updateAccess(db(), {
        userId: t.outsider.id,
        artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "not_found", message: "Artifact not found." });
  });

  it("lets editors and admins set them, and bumps the generation", async () => {
    const t = await team();
    const artifactId = await publishIn(t.editor.id, t.id);
    const before = value(await getAccess(db(), { userId: t.editor.id, artifactId }));
    const changed = value(
      await updateAccess(db(), {
        userId: t.editor.id,
        artifactId,
        change: { mode: "workspace" },
        now: NOW,
      }),
    );
    expect(changed.mode).toBe("workspace");
    expect(changed.policyGeneration).toBe(before.policyGeneration + 1);
    expect(changed.audience).toEqual({ members: 3, domains: [], featureAvailable: true });
  });

  it("refuses domain until the workspace verified a domain", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    expect(await setMode(t, artifactId, "domain")).toEqual({
      ok: false,
      code: "invalid_input",
      message: "Verify an email domain on the workspace's Members page before sharing with it.",
    });
    await verified(t);
    const changed = value(await setMode(t, artifactId, "domain"));
    expect(changed.audience?.domains).toEqual([t.domain]);
  });

  it("never needs the plan to narrow or to repeat the mode an artifact has", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    await verified(t);
    value(await setMode(t, artifactId, "domain"));
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect((await setMode(t, artifactId, "domain")).ok).toBe(true);
    const narrowed = value(await setMode(t, artifactId, "restricted"));
    expect(narrowed.mode).toBe("restricted");
    expect(narrowed.audience?.featureAvailable).toBe(false);
  });
});

describe("reading in the workspace modes", () => {
  it("admits exactly members in workspace mode", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    await verified(t);
    value(await setMode(t, artifactId, "workspace"));
    expect(await reads(artifactId, t.admin.id)).toBe(true);
    expect(await reads(artifactId, t.editor.id)).toBe(true);
    expect(await reads(artifactId, t.member.id)).toBe(true);
    expect(await reads(artifactId, t.colleague.id)).toBe(false);
    expect(await reads(artifactId, t.outsider.id)).toBe(false);
  });

  it("admits members and verified addresses at the exact domain in domain mode", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    await verified(t);
    value(await setMode(t, artifactId, "domain"));
    expect(await reads(artifactId, t.member.id)).toBe(true);
    expect(await reads(artifactId, t.colleague.id)).toBe(true);
    expect(await reads(artifactId, t.unverified.id)).toBe(false);
    expect(await reads(artifactId, t.subdomain.id)).toBe(false);
    expect(await reads(artifactId, t.outsider.id)).toBe(false);
  });

  it("does not let a listed reader in outside restricted", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    value(
      await updateAccess(db(), {
        userId: t.admin.id,
        artifactId,
        change: { addReaders: [t.outsider.email] },
        now: NOW,
      }),
    );
    expect(await reads(artifactId, t.outsider.id)).toBe(true);
    value(await setMode(t, artifactId, "workspace"));
    expect(await reads(artifactId, t.outsider.id)).toBe(false);
  });

  it("falls back to members only while the plan lacks the feature, never wider", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    await verified(t);
    value(await setMode(t, artifactId, "domain"));
    await grantPlan(t.id, "team", { seats: 10, validUntil: NOW + HOUR });
    expect(await reads(artifactId, t.colleague.id, NOW)).toBe(true);
    expect(await reads(artifactId, t.colleague.id, NOW + 2 * HOUR)).toBe(false);
    expect(await reads(artifactId, t.member.id, NOW + 2 * HOUR)).toBe(true);
    const view = value(
      await getAccess(db(), { userId: t.admin.id, artifactId, now: NOW + 2 * HOUR }),
    );
    expect(view.audience?.featureAvailable).toBe(false);
  });

  it("ends a read session within the claims' lifetime when the member or the domain goes", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    const domain = await verified(t);
    value(await setMode(t, artifactId, "domain"));
    const open = async (userId: string) => {
      const authSessionId = await session(userId);
      const code = value(
        await issueReadHandoff(db(), {
          artifactId,
          userId,
          authSessionId,
          state: "s",
          now: NOW,
          customDomains: true,
          confirmed: false,
          requestedHost: null,
          contentDomain: "portifact.dev",
        }),
      ).code;
      const host = `${artifactId}.portifact.dev`;
      return value(
        await redeemReadHandoff(db(), {
          code,
          artifactId,
          states: ["s"],
          now: NOW,
          host,
          devHost: host,
        }),
      ).sessionId;
    };
    const memberSession = await open(t.member.id);
    const colleagueSession = await open(t.colleague.id);
    const refresh = (sessionId: string) =>
      refreshReadSession(db(), { sessionId, artifactId, now: NOW + 61_000 });
    expect((await refresh(memberSession)).ok).toBe(true);
    expect((await refresh(colleagueSession)).ok).toBe(true);

    value(
      await removeMember(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        memberId: t.member.id,
      }),
    );
    value(
      await removeWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: domain.id,
        now: NOW,
      }),
    );
    expect(await refresh(memberSession)).toMatchObject({ ok: false, code: "not_found" });
    expect(await refresh(colleagueSession)).toMatchObject({ ok: false, code: "not_found" });
    // Neither change moved the generation: the renewal did it, within the claims' 60 seconds.
    const [row] = await db()
      .select({ g: schema.artifacts.policyGeneration })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    expect(row?.g).toBe(2);
  });

  it("stops matching an account whose address changes or loses its verification", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    await verified(t);
    value(await setMode(t, artifactId, "domain"));
    expect(await reads(artifactId, t.colleague.id)).toBe(true);
    await db()
      .update(schema.users)
      .set({ emailVerified: false })
      .where(eq(schema.users.id, t.colleague.id));
    expect(await reads(artifactId, t.colleague.id)).toBe(false);
    await db()
      .update(schema.users)
      .set({ emailVerified: true, email: "dana@elsewhere.org" })
      .where(eq(schema.users.id, t.colleague.id));
    expect(await reads(artifactId, t.colleague.id)).toBe(false);
  });

  it("shows members and domain readers in the viewer as readers and lets them comment in their scope", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    await verified(t);
    value(await setMode(t, artifactId, "domain"));
    value(
      await updateAccess(db(), {
        userId: t.admin.id,
        artifactId,
        change: { addReaders: [t.member.email] },
        now: NOW,
      }),
    );
    await db()
      .update(schema.artifacts)
      .set({ annotations: "open" })
      .where(eq(schema.artifacts.id, artifactId));
    for (const who of [t.member, t.colleague]) {
      expect(
        value(
          await getViewerArtifact(db(), {
            artifactId,
            userId: who.id,
            now: NOW,
            customDomains: true,
          }),
        ).role,
      ).toBe("reader");
    }
    expect(
      await getViewerArtifact(db(), {
        artifactId,
        userId: t.outsider.id,
        now: NOW,
        customDomains: true,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
    const [current] = await db()
      .select({ versionId: schema.artifacts.currentVersionId })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.id, artifactId));
    const start = (userId: string, body: string) =>
      createAnnotationThread(db(), {
        userId,
        artifactId,
        versionId: current?.versionId as string,
        target: DOC,
        body,
        humanCheck: HUMAN,
        now: NOW,
      });
    value(await start(t.colleague.id, "From the domain"));
    value(await start(t.member.id, "From a member"));
    const seen = async (userId: string) =>
      value(
        await listAnnotations(db(), {
          userId,
          artifactId,
          limit: 50,
          version: "current",
          now: NOW,
        }),
      ).threads.length;
    // The default scope is `own`: each sees their own thread.
    expect(await seen(t.colleague.id)).toBe(1);
    expect(await seen(t.member.id)).toBe(1);
    // An exception for a listed address keeps working in this mode.
    value(
      await updateAccess(db(), {
        userId: t.admin.id,
        artifactId,
        change: { readerCommentVisibility: [{ email: t.member.email, commentVisibility: "all" }] },
        now: NOW,
      }),
    );
    expect(await seen(t.member.id)).toBe(2);
    expect(
      await listAnnotations(db(), {
        userId: t.outsider.id,
        artifactId,
        limit: 50,
        version: "current",
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("on a custom host", () => {
  it("asks for the visitor's click before a code leaves the app, like an artifact every account reads", async () => {
    for (const mode of ["workspace", "domain"] as const) {
      const t = await team();
      const artifactId = await publishIn(t.admin.id, t.id);
      await verified(t);
      value(await setMode(t, artifactId, mode));
      // The workspace's admin controls this host's DNS and could receive a code there.
      const hostname = `docs-${hex().slice(0, 8)}.example.net`;
      await db().insert(schema.customDomains).values({
        hostname,
        ownerId: t.id,
        artifactId,
        region: "default",
        state: "active",
        token: "domain-token",
        verifiedAt: NOW,
        checkedAt: NOW,
      });
      await db()
        .update(schema.artifacts)
        .set({ customHost: hostname })
        .where(eq(schema.artifacts.id, artifactId));
      // A member in workspace mode, someone with an address at the company in domain mode.
      const reader = mode === "workspace" ? t.member : t.colleague;
      const input = (requestedHost: string | null, confirmed: boolean) => ({
        customDomains: true,
        confirmed,
        artifactId,
        userId: reader.id,
        authSessionId: "",
        state: "c".repeat(43),
        now: NOW,
        requestedHost,
        contentDomain: "portifact.dev",
      });
      const authSessionId = await session(reader.id);
      const entry = (host: string | null, confirmed: boolean) => ({
        ...input(host, confirmed),
        authSessionId,
      });
      expect(await readEntryConfirmation(db(), entry(hostname, false)), mode).toBe(hostname);
      expect(await issueReadHandoff(db(), entry(hostname, false)), mode).toMatchObject({
        ok: false,
      });
      expect(
        await db().select().from(schema.readHandoffs).where(eq(schema.readHandoffs.host, hostname)),
        mode,
      ).toEqual([]);
      expect(value(await issueReadHandoff(db(), entry(hostname, true))).host, mode).toBe(hostname);
      // The viewer frames it on `.dev`, so its review codes never reach the custom host either.
      const viewed = value(
        await getViewerArtifact(db(), {
          artifactId,
          userId: reader.id,
          now: NOW,
          customDomains: true,
        }),
      );
      expect(viewed.customHost, mode).toBeNull();
    }
  });
});

describe("transfers", () => {
  it("reset the workspace modes to restricted, keeping the reader list", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    value(
      await updateAccess(db(), {
        userId: t.admin.id,
        artifactId,
        change: { addReaders: [t.outsider.email], mode: "workspace" },
        now: NOW,
      }),
    );
    const moved = value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId,
        workspace: null,
        now: NOW,
      }),
    );
    expect(moved.ownerId).toBe(t.admin.id);
    expect(moved.accessMode).toBe("restricted");
    expect(await reads(artifactId, t.member.id)).toBe(false);
    expect(await reads(artifactId, t.outsider.id)).toBe(true);
  });

  it("keep the other modes as they are", async () => {
    const t = await team();
    const artifactId = await publishIn(t.admin.id, t.id);
    value(
      await updateAccess(db(), {
        userId: t.admin.id,
        artifactId,
        change: { mode: "authenticated" },
        now: NOW,
      }),
    );
    const moved = value(
      await transferArtifact(db(), env.ARTIFACTS, {
        userId: t.admin.id,
        artifactId,
        workspace: null,
        now: NOW,
      }),
    );
    expect(moved.accessMode).toBe("authenticated");
  });
});

describe("verifying a domain", () => {
  it("is for admins: editors and members are forbidden, outsiders find no workspace", async () => {
    const t = await team();
    const add = (userId: string) =>
      addWorkspaceDomain(db().global, { userId, slug: t.slug, domain: t.domain, now: NOW });
    expect(await add(t.editor.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await add(t.member.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await add(t.outsider.id)).toEqual({
      ok: false,
      code: "not_found",
      message: "Workspace not found.",
    });
    expect(
      await listWorkspaceDomains(db().global, { userId: t.outsider.id, slug: t.slug, now: NOW }),
    ).toEqual({ ok: false, code: "not_found", message: "Workspace not found." });
    expect(
      await listWorkspaceDomains(db().global, { userId: t.member.id, slug: t.slug, now: NOW }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("needs the plan to add and verify, never to list or remove", async () => {
    const t = await team("free");
    expect(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: t.domain,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "plan_required" });
    const list = value(
      await listWorkspaceDomains(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(list.available).toBe(false);
  });

  it("refuses providers, shared suffixes and Portifact, and normalizes case and IDN", async () => {
    const t = await team();
    for (const domain of [
      "gmail.com",
      "co.uk",
      "someone.github.io",
      "portifact.com",
      "acme.local",
    ]) {
      expect(
        await addWorkspaceDomain(db().global, {
          userId: t.admin.id,
          slug: t.slug,
          domain,
          now: NOW,
        }),
        domain,
      ).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: "app.portifact.example",
        now: NOW,
        ownHosts: ["portifact.example"],
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    const idn = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: `BÜCHER${hex().slice(0, 6)}.com`,
        now: NOW,
      }),
    );
    expect(idn.domain).toMatch(/^xn--bcher[0-9a-f]{6}-[a-z0-9]+\.com$/);
    expect(idn.display).toMatch(/^bücher[0-9a-f]{6}\.com$/);
    const upper = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: t.domain.toUpperCase(),
        now: NOW,
      }),
    );
    expect(upper.domain).toBe(t.domain);
    expect(upper.display).toBeNull();
  });

  it("uses a fresh token per claim, and a lapsed claim gets a new one", async () => {
    const t = await team();
    const add = (now: number) =>
      addWorkspaceDomain(db().global, { userId: t.admin.id, slug: t.slug, domain: t.domain, now });
    const first = value(await add(NOW));
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);
    expect(value(await add(NOW + HOUR)).token).toBe(first.token);
    const later = value(await add(NOW + 8 * DAY));
    expect(later.id).toBe(first.id);
    expect(later.token).not.toBe(first.token);
    const dns = new FakeDomains();
    dns.publishTxt(`_portifact-email.${t.domain}`, `portifact-email-verify=${first.token}`);
    expect(
      await verifyWorkspaceDomain(db().global, dns, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: first.id,
        now: NOW + 8 * DAY,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("verifies only with this claim's record, and a DNS failure counts nothing", async () => {
    const t = await team();
    const claim = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: t.domain,
        now: NOW,
      }),
    );
    const dns = new FakeDomains();
    const verify = () =>
      verifyWorkspaceDomain(db().global, dns, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: claim.id,
        now: NOW,
      });
    expect(await verify()).toMatchObject({ ok: false, code: "invalid_input" });
    // Custom domains' record and token prove nothing here.
    dns.publishTxt(`_portifact.${t.domain}`, `portifact-email-verify=${claim.token}`);
    expect(await verify()).toMatchObject({ ok: false, code: "invalid_input" });
    dns.failing.txt = true;
    expect(await verify()).toMatchObject({ ok: false, code: "capacity_unavailable" });
    dns.failing.txt = false;
    dns.publishTxt(`_portifact-email.${t.domain}`, `portifact-email-verify=${claim.token}`);
    const done = value(await verify());
    expect(done.state).toBe("verified");
    expect(done.checkedAt).toBe(NOW);
    expect(value(await verify()).verifiedAt).toBe(NOW);
  });

  it("does not let a second workspace verify a released domain whose old record lingers", async () => {
    const a = await team();
    const b = await team();
    const dns = new FakeDomains();
    const held = await verified(a, dns);
    value(
      await removeWorkspaceDomain(db().global, {
        userId: a.admin.id,
        slug: a.slug,
        domainId: held.id,
        now: NOW,
      }),
    );
    // A's record is still published; B's claim has its own token.
    const claim = value(
      await addWorkspaceDomain(db().global, {
        userId: b.admin.id,
        slug: b.slug,
        domain: a.domain,
        now: NOW,
      }),
    );
    expect(claim.token).not.toBe(held.token);
    expect(
      await verifyWorkspaceDomain(db().global, dns, {
        userId: b.admin.id,
        slug: b.slug,
        domainId: claim.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("refuses a takeover while the holder's record stands, and takes over once it is gone", async () => {
    const a = await team();
    const b = await team();
    const dns = new FakeDomains();
    const held = await verified(a, dns);
    const claim = value(
      await addWorkspaceDomain(db().global, {
        userId: b.admin.id,
        slug: b.slug,
        domain: a.domain,
        now: NOW,
      }),
    );
    const name = `_portifact-email.${a.domain}`;
    dns.publishTxt(name, `portifact-email-verify=${claim.token}`);
    const verifyB = () =>
      verifyWorkspaceDomain(db().global, dns, {
        userId: b.admin.id,
        slug: b.slug,
        domainId: claim.id,
        now: NOW,
      });
    expect(await verifyB()).toEqual({
      ok: false,
      code: "version_conflict",
      message: "Another workspace still proves this domain in its DNS. Remove its record first.",
    });
    dns.records.set(name, [`portifact-email-verify=${claim.token}`]);
    expect(value(await verifyB()).state).toBe("verified");
    const [gone] = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.id, held.id));
    expect(gone).toBeUndefined();
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(
        and(eq(schema.tombstones.kind, "workspace_domain"), eq(schema.tombstones.id, held.id)),
      );
    expect(tombstone).toBeDefined();
  });

  it("verifies one of two concurrent claims of the same domain", async () => {
    const a = await team();
    const b = await team();
    const dns = new FakeDomains();
    const claims = await Promise.all(
      [a, b].map(async (t) =>
        value(
          await addWorkspaceDomain(db().global, {
            userId: t.admin.id,
            slug: t.slug,
            domain: a.domain,
            now: NOW,
          }),
        ),
      ),
    );
    for (const claim of claims) {
      dns.publishTxt(`_portifact-email.${a.domain}`, `portifact-email-verify=${claim.token}`);
    }
    const results = await Promise.all(
      [a, b].map((t, i) =>
        verifyWorkspaceDomain(db().global, dns, {
          userId: t.admin.id,
          slug: t.slug,
          domainId: claims[i]?.id ?? "",
          now: NOW,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "version_conflict" });
    const holders = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(
        and(
          eq(schema.workspaceDomains.domain, a.domain),
          eq(schema.workspaceDomains.state, "verified"),
        ),
      );
    expect(holders).toHaveLength(1);
  });

  it("caps the domains per workspace", async () => {
    const t = await team();
    for (let i = 0; i < 10; i++) {
      value(
        await addWorkspaceDomain(db().global, {
          userId: t.admin.id,
          slug: t.slug,
          domain: `d${i}${t.domain}`,
          now: NOW,
        }),
      );
    }
    expect(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: `extra${t.domain}`,
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "A workspace can have at most 10 email domains.",
    });
  });

  it("does nothing for an admin demoted before the write", async () => {
    const t = await team();
    const claim = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: t.domain,
        now: NOW,
      }),
    );
    await db()
      .update(schema.workspaceMembers)
      .set({ role: "admin" })
      .where(eq(schema.workspaceMembers.userId, t.editor.id));
    await db()
      .update(schema.workspaceMembers)
      .set({ role: "member" })
      .where(eq(schema.workspaceMembers.userId, t.admin.id));
    expect(
      await removeWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: claim.id,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("the daily re-check", () => {
  it("counts misses, resets on a found record and removes at the third miss", async () => {
    const t = await team();
    const dns = new FakeDomains();
    const domain = await verified(t, dns);
    const artifactId = await publishIn(t.admin.id, t.id);
    value(await setMode(t, artifactId, "domain"));
    const name = `_portifact-email.${t.domain}`;
    const row = async () =>
      (
        await db()
          .select()
          .from(schema.workspaceDomains)
          .where(eq(schema.workspaceDomains.id, domain.id))
      )[0];
    // Not due within a day of the last check.
    await recheckEmailDomains(db().global, dns, NOW + HOUR);
    expect((await row())?.checkedAt).toBe(NOW);

    dns.clearTxt(name);
    await recheckEmailDomains(db().global, dns, NOW + DAY + 1);
    expect(await row()).toMatchObject({ failedChecks: 1, problem: "txt_missing" });
    dns.failing.txt = true;
    await recheckEmailDomains(db().global, dns, NOW + 2 * DAY + 2);
    expect(await row()).toMatchObject({ failedChecks: 1 });
    dns.failing.txt = false;
    dns.publishTxt(name, `portifact-email-verify=${domain.token}`);
    await recheckEmailDomains(db().global, dns, NOW + 2 * DAY + 3);
    expect(await row()).toMatchObject({ failedChecks: 0, problem: null });

    dns.clearTxt(name);
    for (let day = 3; day <= 5; day++) {
      await recheckEmailDomains(db().global, dns, NOW + day * DAY + 4 + day);
    }
    expect(await row()).toBeUndefined();
    expect(await reads(artifactId, t.colleague.id, NOW + 5 * DAY + 5)).toBe(false);
    expect(await reads(artifactId, t.member.id, NOW + 5 * DAY + 5)).toBe(true);
  });

  it("counts a day once when two runs overlap", async () => {
    const t = await team();
    const dns = new FakeDomains();
    const domain = await verified(t, dns);
    dns.clearTxt(`_portifact-email.${t.domain}`);
    await Promise.all([
      recheckEmailDomains(db().global, dns, NOW + DAY + 1),
      recheckEmailDomains(db().global, dns, NOW + DAY + 1),
    ]);
    const [row] = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.id, domain.id));
    expect(row?.failedChecks).toBe(1);
  });

  it("drops claims that were never proven within seven days", async () => {
    const t = await team();
    const claim = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: t.domain,
        now: NOW,
      }),
    );
    await recheckEmailDomains(db().global, new FakeDomains(), NOW + 7 * DAY);
    const rows = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.id, claim.id));
    expect(rows).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("removes a domain a restore brought back, by its row", async () => {
    const t = await team();
    const domain = await verified(t);
    const [snapshot] = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.id, domain.id));
    value(
      await removeWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: domain.id,
        now: NOW,
      }),
    );
    const markers = (await exportTombstones(regionsFromEnv(env))).filter(
      (marker) => marker.kind === "workspace_domain",
    );
    expect(markers.map((marker) => marker.id)).toContain(domain.id);
    // The restore rewinds the removal; a later, different claim of the same name survives.
    if (snapshot) await db().insert(schema.workspaceDomains).values(snapshot);
    const applied = await applyTombstones(db(), markers, NOW + DAY);
    expect(applied.domains).toBeGreaterThanOrEqual(1);
    const left = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.id, domain.id));
    expect(left).toEqual([]);
    const again = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: t.domain,
        now: NOW + DAY,
      }),
    );
    await applyTombstones(db(), markers, NOW + DAY);
    const kept = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.id, again.id));
    expect(kept).toHaveLength(1);
  });

  it("goes with the workspace", async () => {
    const t = await team();
    await verified(t);
    // As a deletion does: its row first, so the last-admin trigger lets the memberships go.
    await db().insert(schema.workspaceDeletions).values({ workspaceId: t.id, requestedAt: NOW });
    await db().delete(schema.workspaces).where(eq(schema.workspaces.id, t.id));
    const rows = await db()
      .select()
      .from(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.workspaceId, t.id));
    expect(rows).toEqual([]);
  });

  it("lists a workspace's domains in the export only for its admins, never the token", async () => {
    const t = await team();
    const domain = await verified(t);
    const exported = async (userId: string) =>
      value(await exportAccount(db(), { userId, now: NOW })).workspaces.find(
        (w) => w.slug === t.slug,
      );
    const admin = await exported(t.admin.id);
    expect(admin?.domains).toEqual([
      { domain: t.domain, state: "verified", verifiedAt: new Date(NOW).toISOString() },
    ]);
    expect(JSON.stringify(admin)).not.toContain(domain.token);
    expect((await exported(t.editor.id))?.domains).toBeUndefined();
    expect((await exported(t.member.id))?.domains).toBeUndefined();
  });
});

describe("the audit log of email domains", () => {
  const audit = async (workspaceId: string) =>
    (
      await db()
        .global.select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.ownerId, workspaceId))
        .orderBy(schema.auditEvents.at, schema.auditEvents.id)
    ).map((row) => [row.kind, row.actorType, row.actorId, row.targetId, row.detail]);

  it("records proving and removing a domain once, and nothing for a claim never proved", async () => {
    const t = await team();
    const dns = new FakeDomains();
    const claim = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: t.domain,
        now: NOW,
      }),
    );
    const verify = (now: number) =>
      verifyWorkspaceDomain(db().global, dns, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: claim.id,
        now,
      });
    // No record yet: refused, nothing recorded.
    expect((await verify(NOW)).ok).toBe(false);
    expect(await audit(t.id)).toEqual([]);
    dns.publishTxt(`_portifact-email.${t.domain}`, `portifact-email-verify=${claim.token}`);
    value(await verify(NOW + 1));
    // Verifying what is verified changes nothing.
    value(await verify(NOW + 2));
    const proved = ["email_domain.verified", "user", t.admin.id, claim.id, { domain: t.domain }];
    expect(await audit(t.id)).toEqual([proved]);
    const remove = (domainId: string, now: number) =>
      removeWorkspaceDomain(db().global, { userId: t.admin.id, slug: t.slug, domainId, now });
    value(await remove(claim.id, NOW + 3));
    expect((await remove(claim.id, NOW + 4)).ok).toBe(false);
    expect(await audit(t.id)).toEqual([
      proved,
      [
        "email_domain.removed",
        "user",
        t.admin.id,
        claim.id,
        { domain: t.domain, reason: "removed" },
      ],
    ]);
    // A claim removed before it was proved granted nothing and records nothing.
    const pending = value(
      await addWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domain: `other${t.domain}`,
        now: NOW + 5,
      }),
    );
    value(await remove(pending.id, NOW + 6));
    expect(await audit(t.id)).toHaveLength(2);
    expect(JSON.stringify(await audit(t.id))).not.toContain(claim.token);
  });

  it("tells the workspace that lost a domain to another one, in the same batch", async () => {
    const [a, b] = [await team(), await team()];
    const dns = new FakeDomains();
    const held = await verified(a, dns);
    const claim = value(
      await addWorkspaceDomain(db().global, {
        userId: b.admin.id,
        slug: b.slug,
        domain: a.domain,
        now: NOW,
      }),
    );
    dns.records.set(`_portifact-email.${a.domain}`, [`portifact-email-verify=${claim.token}`]);
    value(
      await verifyWorkspaceDomain(db().global, dns, {
        userId: b.admin.id,
        slug: b.slug,
        domainId: claim.id,
        now: NOW + 1,
      }),
    );
    expect((await audit(a.id)).at(-1)).toEqual([
      "email_domain.removed",
      "system",
      null,
      held.id,
      { domain: a.domain, reason: "claimed" },
    ]);
    expect(await audit(b.id)).toEqual([
      ["email_domain.verified", "user", b.admin.id, claim.id, { domain: a.domain }],
    ]);
  });

  it("records the daily check removing a domain, and nothing for a miss it only counts", async () => {
    const t = await team();
    const dns = new FakeDomains();
    const domain = await verified(t, dns);
    dns.clearTxt(`_portifact-email.${t.domain}`);
    await recheckEmailDomains(db().global, dns, NOW + DAY + 1);
    expect(await audit(t.id)).toHaveLength(1);
    for (let day = 2; day <= 4; day++) {
      await recheckEmailDomains(db().global, dns, NOW + day * DAY + day);
    }
    const events = await audit(t.id);
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject([
      "email_domain.removed",
      "system",
      null,
      domain.id,
      { domain: t.domain, reason: "record_missing" },
    ]);
  });

  it("records nothing when the admin was demoted before the write", async () => {
    const t = await team();
    const dns = new FakeDomains();
    const domain = await verified(t, dns);
    await db()
      .insert(schema.workspaceMembers)
      .values({ workspaceId: t.id, userId: t.outsider.id, role: "admin", updatedAt: NOW });
    const raced = raceGlobalBeforeFirstWrite(async () => {
      await db()
        .update(schema.workspaceMembers)
        .set({ role: "editor" })
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, t.id),
            eq(schema.workspaceMembers.userId, t.admin.id),
          ),
        );
    });
    expect(
      (
        await removeWorkspaceDomain(raced, {
          userId: t.admin.id,
          slug: t.slug,
          domainId: domain.id,
          now: NOW + 1,
        })
      ).ok,
    ).toBe(false);
    expect((await audit(t.id)).map(([kind]) => kind)).toEqual(["email_domain.verified"]);
  });
});

describe("the Public Suffix List", () => {
  it("places ICANN and private suffixes", () => {
    expect(publicSuffixOf("acme.co.uk")).toEqual({ suffix: "co.uk", icann: true, private: false });
    expect(publicSuffixOf("x.github.io")).toEqual({
      suffix: "github.io",
      icann: false,
      private: true,
    });
    expect(publicSuffixOf("acme.corp")).toEqual({ suffix: "corp", icann: false, private: false });
    expect(publicSuffixOf("1.2.3.4")).toBeNull();
    expect(publicSuffixOf("")).toBeNull();
  });
});

describe("exact answers of the domain services", () => {
  const add = (t: Team, domain: string, now = NOW) =>
    addWorkspaceDomain(db().global, { userId: t.admin.id, slug: t.slug, domain, now });
  const verify = (t: Team, dns: FakeDomains, domainId: string, now = NOW) =>
    verifyWorkspaceDomain(db().global, dns, { userId: t.admin.id, slug: t.slug, domainId, now });

  it("answers each refusal with its code and message", async () => {
    const t = await team();
    const dns = new FakeDomains();
    const missing = `wd_${"0".repeat(32)}`;
    expect(await verify(t, dns, missing)).toEqual({
      ok: false,
      code: "not_found",
      message: "Domain not found.",
    });
    expect(
      await removeWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: missing,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "not_found", message: "Domain not found." });
    expect(await add(t, "not a domain")).toEqual({
      ok: false,
      code: "invalid_input",
      message: "Enter only the domain, like example.com.",
    });
    const claim = value(await add(t, t.domain));
    expect(await verify(t, dns, claim.id, NOW + 7 * DAY)).toEqual({
      ok: false,
      code: "invalid_input",
      message: "This claim expired. Add the domain again for a new record.",
    });
    expect(await verify(t, dns, claim.id, NOW + 7 * DAY - 1)).toEqual({
      ok: false,
      code: "invalid_input",
      message:
        "The TXT record was not found with this domain's value. DNS changes can take a while to appear; try again later.",
    });
    dns.failing.txt = true;
    expect(await verify(t, dns, claim.id)).toEqual({
      ok: false,
      code: "capacity_unavailable",
      message: "DNS could not be checked right now. Try again shortly.",
    });
    dns.failing.txt = false;
    // An admin's plan lapsing stops adding and verifying, never listing.
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(await verify(t, dns, claim.id)).toEqual({
      ok: false,
      code: "plan_required",
      message: "Using workspaces is part of the Team plan.",
    });
    const list = value(
      await listWorkspaceDomains(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(list.available).toBe(false);
    expect(list.domains.map((d) => d.id)).toEqual([claim.id]);
  });

  it("returns the claim it already has, renewing only a lapsed one", async () => {
    const t = await team();
    const claim = value(await add(t, t.domain));
    expect(value(await add(t, t.domain, claim.expiresAt - 1))).toEqual(claim);
    const renewed = value(await add(t, t.domain, claim.expiresAt));
    expect(renewed.token).not.toBe(claim.token);
    expect(renewed.expiresAt).toBe(claim.expiresAt + 7 * DAY);
    const dns = new FakeDomains();
    dns.publishTxt(`_portifact-email.${t.domain}`, `portifact-email-verify=${renewed.token}`);
    const done = value(await verify(t, dns, renewed.id, claim.expiresAt));
    expect(value(await add(t, t.domain, NOW + 30 * DAY))).toEqual(done);
    expect(value(await verify(t, dns, done.id, NOW + 30 * DAY))).toEqual(done);
    expect(
      await removeWorkspaceDomain(db().global, {
        userId: t.admin.id,
        slug: t.slug,
        domainId: done.id,
        now: NOW,
      }),
    ).toEqual({ ok: true, value: true });
    const list = value(
      await listWorkspaceDomains(db().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(list).toMatchObject({ available: true, domains: [] });
  });

  it("counts what a re-check did", async () => {
    const t = await team();
    const dns = new FakeDomains();
    await verified(t, dns);
    const other = await team();
    await verified(other, dns);
    dns.clearTxt(`_portifact-email.${other.domain}`);
    await db()
      .update(schema.workspaceDomains)
      .set({ failedChecks: 2 })
      .where(eq(schema.workspaceDomains.workspaceId, other.id));
    const result = await recheckEmailDomains(db().global, dns, NOW + DAY + 1, 500);
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.unavailable).toBe(0);
    dns.failing.txt = true;
    const failing = await recheckEmailDomains(db().global, dns, NOW + 3 * DAY, 500);
    expect(failing.checked).toBe(0);
    expect(failing.unavailable).toBeGreaterThanOrEqual(1);
  });

  it("gives canRead only the owner's matching domains, and only in domain mode", async () => {
    const t = await team();
    await verified(t);
    const team_ = entitlements({ plan: "team", seats: 5, validUntil: null, overrides: null }, NOW);
    const free = entitlements(null, NOW);
    const base = {
      mode: "domain" as const,
      ownerId: t.id,
      actor: null,
      verifiedEmails: [`dana@${t.domain}`, "x@other.org", "not-an-address"],
      entitlements: team_,
    };
    expect(await policyDomains(db().global, base)).toEqual({
      featureAvailable: true,
      verified: [t.domain],
    });
    expect(await policyDomains(db().global, { ...base, verifiedEmails: ["x@other.org"] })).toEqual({
      featureAvailable: true,
      verified: [],
    });
    expect(await policyDomains(db().global, { ...base, verifiedEmails: ["bad"] })).toEqual({
      featureAvailable: true,
      verified: [],
    });
    expect(await policyDomains(db().global, { ...base, entitlements: free })).toEqual({
      featureAvailable: false,
      verified: [],
    });
    expect(
      await policyDomains(db().global, {
        ...base,
        actor: { userId: t.member.id, ownerId: t.id, role: "member", region: "default" },
      }),
    ).toEqual({ featureAvailable: true, verified: [] });
    expect(await policyDomains(db().global, { ...base, mode: "workspace" })).toBeUndefined();
    expect(await policyDomains(db().global, { ...base, ownerId: t.admin.id })).toBeUndefined();
    expect(await accessAudience(db().global, t.id, team_)).toEqual({
      members: 3,
      domains: [t.domain],
      featureAvailable: true,
    });
    expect(await accessAudience(db().global, t.admin.id, team_)).toBeNull();
  });
});
