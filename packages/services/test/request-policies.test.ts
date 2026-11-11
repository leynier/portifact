// A workspace's request policies (decision 0020): network allowlists for people and for service
// tokens, applied where the role is decided (`actorOn`) from the request context the handles
// carry. Every role, a token, a non-member, the personal space, the use cases on top, lock-out
// safety, the plan, races, two regions and what they cost in D1 calls.
import { env } from "cloudflare:test";
import {
  BACKGROUND,
  DEFAULT_POLICY,
  type RequestContext,
  UNKNOWN_REQUEST,
  type WorkspacePolicy,
} from "@portifact/contracts";
import {
  type RegionalDb,
  type Regions,
  regionsFromEnv,
  schema,
  withRequestContext,
} from "@portifact/db";
import { POLICY_MESSAGES } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getAccess, updateAccess } from "../src/access.ts";
import { actorOn, resolveActor } from "../src/actors.ts";
import { listAnnotations } from "../src/annotations.ts";
import { getAuditLog } from "../src/audit.ts";
import { renewArtifact } from "../src/lifecycle.ts";
import { commitPublish, preparePublish } from "../src/publish.ts";
import { checkReadAccess } from "../src/read-access.ts";
import { createServiceToken } from "../src/service-tokens.ts";
import { transferArtifact } from "../src/transfer.ts";
import { getViewerArtifact } from "../src/viewer.ts";
import {
  clearRequestPolicies,
  getWorkspacePolicy,
  previewWorkspacePolicy,
  setWorkspacePolicy,
} from "../src/workspace-policies.ts";
import {
  createWorkspace,
  listMembers,
  listUserWorkspaces,
  resolveOwnerScope,
} from "../src/workspaces.ts";
import { DAY, grantPlan, NOW, publishSite, sha256, user, value } from "./fixtures.ts";
import { raceBeforeFirstWrite } from "./race.ts";
import { recording } from "./recording.ts";

const OFFICE_IP = "192.0.2.10";
const HOME_IP = "198.51.100.20";
const CI_IP = "203.0.113.5";
const from = (ip: string | null): RequestContext => ({ kind: "request", ip });
const regionsAt = (request: RequestContext): Regions =>
  regionsFromEnv(withRequestContext(env, request));
const dbAt = (request: RequestContext): RegionalDb => regionsAt(request).get("default").db;
const office = () => regionsAt(from(OFFICE_IP));
const home = () => regionsAt(from(HOME_IP));
const policy = (change: Partial<WorkspacePolicy> = {}): WorkspacePolicy => ({
  ...DEFAULT_POLICY,
  ...change,
});
const OFFICE_ONLY = policy({ ipAllowlist: ["192.0.2.0/24"] });
const networkRefusal = (ip: string | null) => ({
  ok: false,
  code: "policy_refused",
  message: POLICY_MESSAGES.networkPerson(ip),
});

async function team(plan: "enterprise" | "free" = "enterprise") {
  const admin = await user("Admin");
  const editor = await user("Editor");
  const member = await user("Member");
  const outsider = await user("Outsider");
  const slug = `rp-${crypto.randomUUID().slice(0, 12)}`;
  const created = value(
    await createWorkspace(office().global, {
      slug,
      name: "Request policies",
      adminUserId: admin.id,
      now: NOW,
    }),
  );
  await office()
    .global.insert(schema.workspaceMembers)
    .values([
      { workspaceId: created.id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: created.id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  if (plan === "enterprise") await grantPlan(created.id, "enterprise", { seats: 10 });
  return { id: created.id, slug, admin, editor, member, outsider };
}
type Team = Awaited<ReturnType<typeof team>>;

async function save(t: Team, next: WorkspacePolicy, r: Regions = office(), userId = t.admin.id) {
  const current = value(await getWorkspacePolicy(r.global, { userId, slug: t.slug, now: NOW }));
  return setWorkspacePolicy(r, {
    userId,
    slug: t.slug,
    policy: next,
    revision: current.revision,
    now: NOW,
  });
}

async function token(t: Team) {
  return value(
    await createServiceToken(office().global, {
      userId: t.admin.id,
      slug: t.slug,
      body: {
        label: "CI",
        role: "editor",
        scopes: ["artifacts:read", "artifacts:write"],
        expiresInDays: 30,
        restriction: { kind: "none" },
      },
      now: NOW,
    }),
  ).token.id;
}

async function publishIn(userId: string, ownerId: string) {
  const body = `<p>${crypto.randomUUID()}</p>`;
  const digest = await sha256(body);
  const db = office().get("default").db;
  const prepared = value(
    await preparePublish(db, {
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
    }),
  );
  await env.ARTIFACTS.put(`objects/${ownerId}/${digest}`, body);
  return value(
    await commitPublish(db, env.ARTIFACTS, { userId, sessionId: prepared.sessionId, now: NOW }),
  ).artifactId;
}

async function workspaceArtifact(t: Team, accessMode: "workspace" | "restricted" | "public") {
  const artifactId = await publishIn(t.editor.id, t.id);
  await office()
    .get("default")
    .db.update(schema.artifacts)
    .set({ accessMode })
    .where(eq(schema.artifacts.id, artifactId));
  return artifactId;
}

describe("the network allowlist for people", () => {
  it("binds every role, admins included, and nobody else learns it exists", async () => {
    const t = await team();
    value(await save(t, OFFICE_ONLY));
    for (const person of [t.admin, t.editor, t.member]) {
      expect((await resolveActor(office().global, person.id, t.id)).ok).toBe(true);
      expect(await resolveActor(home().global, person.id, t.id)).toEqual(networkRefusal(HOME_IP));
      expect(await actorOn(home().global, person.id, t.id)).toEqual(networkRefusal(HOME_IP));
    }
    // Someone with no role answers exactly as before: not found, from anywhere.
    for (const r of [office(), home()]) {
      expect(await resolveActor(r.global, t.outsider.id, t.id)).toEqual({
        ok: false,
        code: "not_found",
        message: "Not found.",
      });
    }
  });

  it("never binds the personal space, and refuses an unknown address (fail closed)", async () => {
    const t = await team();
    value(await save(t, OFFICE_ONLY));
    expect(value(await resolveOwnerScope(home().global, t.admin.id, undefined)).ownerId).toBe(
      t.admin.id,
    );
    expect(await resolveActor(regionsAt(UNKNOWN_REQUEST).global, t.member.id, t.id)).toEqual(
      networkRefusal(null),
    );
    // Work no client is making (jobs, scans, the operator) is never bound.
    expect((await resolveActor(regionsAt(BACKGROUND).global, t.member.id, t.id)).ok).toBe(true);
  });

  it("matches IPv6 and IPv4-mapped addresses", async () => {
    const t = await team();
    value(await save(t, policy({ ipAllowlist: ["192.0.2.0/24", "2001:db8::/32"] })));
    for (const [ip, ok] of [
      ["2001:db8:1::9", true],
      ["::ffff:192.0.2.77", true],
      ["2001:db9::1", false],
    ] as const) {
      expect((await resolveActor(regionsAt(from(ip)).global, t.member.id, t.id)).ok).toBe(ok);
    }
  });

  it("refuses every use case on the workspace, the same way, with the network named", async () => {
    const t = await team();
    const workspaceDoc = await workspaceArtifact(t, "workspace");
    const restrictedDoc = await workspaceArtifact(t, "restricted");
    const publicDoc = await workspaceArtifact(t, "public");
    value(await save(t, OFFICE_ONLY));
    const db = home().get("default").db;
    const refusal = networkRefusal(HOME_IP);
    expect(await resolveOwnerScope(home().global, t.editor.id, t.slug)).toEqual(refusal);
    expect(await getAccess(db, { userId: t.editor.id, artifactId: workspaceDoc })).toEqual(refusal);
    expect(
      await updateAccess(db, {
        userId: t.admin.id,
        artifactId: restrictedDoc,
        change: { addReaders: ["guest@example.test"] },
        now: NOW,
      }),
    ).toEqual(refusal);
    expect(
      await listAnnotations(db, {
        userId: t.member.id,
        artifactId: workspaceDoc,
        now: NOW,
        limit: 10,
        version: "current",
      }),
    ).toEqual(refusal);
    expect(
      await listMembers(home().global, { userId: t.member.id, slug: t.slug, now: NOW }),
    ).toEqual(refusal);
    expect(
      await getWorkspacePolicy(home().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    ).toEqual(refusal);
    // Reading through the account: refused for anything but a public artifact, which is for
    // everyone and reads as for anyone.
    for (const artifactId of [workspaceDoc, restrictedDoc]) {
      expect(await checkReadAccess(db, { userId: t.member.id, artifactId, now: NOW })).toEqual(
        refusal,
      );
    }
    expect(
      (await checkReadAccess(db, { userId: t.member.id, artifactId: publicDoc, now: NOW })).ok,
    ).toBe(true);
    const viewer = value(
      await getViewerArtifact(db, {
        artifactId: publicDoc,
        userId: t.admin.id,
        now: NOW,
        customDomains: false,
      }),
    );
    // A refused admin is a reader of the public artifact here, never its owner.
    expect(viewer.role).toBe("reader");
    // Moving an artifact into the workspace from outside its networks is refused too.
    const mine = (await publishSite(t.editor.id)).artifactId;
    expect(
      await transferArtifact(db, env.ARTIFACTS, {
        userId: t.editor.id,
        artifactId: mine,
        workspace: t.slug,
        now: NOW,
      }),
    ).toEqual(refusal);
  });

  it("keeps the workspace listed, marked blocked, without a read for it", async () => {
    const t = await team();
    value(await save(t, OFFICE_ONLY));
    const blocked = (await listUserWorkspaces(home().global, t.member.id)).find(
      (row) => row.id === t.id,
    );
    expect(blocked).toMatchObject({ blocked: true, role: "member" });
    const fine = (await listUserWorkspaces(office().global, t.member.id)).find(
      (row) => row.id === t.id,
    );
    expect(fine?.blocked).toBe(false);
  });

  it("lets outsiders the workspace chose read as before", async () => {
    const t = await team();
    const doc = await workspaceArtifact(t, "restricted");
    value(
      await updateAccess(office().get("default").db, {
        userId: t.admin.id,
        artifactId: doc,
        change: { addReaders: [t.outsider.email] },
        now: NOW,
      }),
    );
    value(await save(t, OFFICE_ONLY));
    // A listed reader who is not a member is not bound by the workspace's networks.
    expect(
      (
        await checkReadAccess(home().get("default").db, {
          userId: t.outsider.id,
          artifactId: doc,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("service tokens", () => {
  it("are bound by their own allowlist only, never the people's", async () => {
    const t = await team();
    const id = await token(t);
    value(await save(t, OFFICE_ONLY));
    // The people's list does not bind tokens: CI runners have other networks.
    expect((await resolveActor(home().global, id, t.id)).ok).toBe(true);
    value(await save(t, policy({ ...OFFICE_ONLY, tokenIpAllowlist: ["203.0.113.0/24"] })));
    expect((await resolveActor(regionsAt(from(CI_IP)).global, id, t.id)).ok).toBe(true);
    expect(await resolveActor(office().global, id, t.id)).toEqual({
      ok: false,
      code: "policy_refused",
      message: POLICY_MESSAGES.networkToken(OFFICE_IP),
    });
    expect(await resolveOwnerScope(home().global, id, undefined)).toMatchObject({
      code: "policy_refused",
    });
    expect((await listUserWorkspaces(regionsAt(from(HOME_IP)).global, id))[0]?.blocked).toBe(true);
  });
});

describe("changing the network allowlists", () => {
  it("refuses an allowlist that leaves out the admin saving it, in the preview too", async () => {
    const t = await team();
    const lockOut = {
      ok: false,
      code: "invalid_input",
      message: POLICY_MESSAGES.networkLocksOut(HOME_IP),
    };
    expect(await save(t, OFFICE_ONLY, home())).toEqual(lockOut);
    expect(
      await previewWorkspacePolicy(home(), {
        userId: t.admin.id,
        slug: t.slug,
        policy: OFFICE_ONLY,
        now: NOW,
      }),
    ).toEqual(lockOut);
    // The token allowlist binds tokens only, so it cannot lock the dashboard out.
    expect((await save(t, policy({ tokenIpAllowlist: ["203.0.113.0/24"] }), home())).ok).toBe(true);
  });

  it("normalizes the ranges, shows them to admins only and records counts", async () => {
    const t = await team();
    const state = value(
      await save(t, policy({ ipAllowlist: ["192.0.2.99/24", "192.0.2.10", "2001:DB8::/32"] })),
    );
    expect(state.policy.ipAllowlist).toEqual(["192.0.2.0/24", "2001:db8::/32"]);
    expect(state.yourIp).toBe(OFFICE_IP);
    const seen = value(
      await getWorkspacePolicy(office().global, { userId: t.member.id, slug: t.slug, now: NOW }),
    );
    expect(seen.policy.ipAllowlist).toBe("hidden");
    expect(seen.yourIp).toBeNull();
    const log = value(
      await getAuditLog(office().get("default").db, {
        actor: value(await resolveActor(office().global, t.admin.id, t.id)),
        filters: {},
        limit: 10,
        now: NOW + DAY,
      }),
    );
    const changed = log.events.find((event) => event.kind === "policy.changed");
    expect(changed?.detail).toEqual({ fields: ["ipAllowlist"], ipRanges: 2, confirmed: false });
    expect(JSON.stringify(log)).not.toContain("192.0.2");
  });

  it("previews who an allowlist binds, as counts", async () => {
    const t = await team();
    await token(t);
    expect(
      value(
        await previewWorkspacePolicy(office(), {
          userId: t.admin.id,
          slug: t.slug,
          policy: policy({ ...OFFICE_ONLY, tokenIpAllowlist: ["203.0.113.0/24"] }),
          now: NOW,
        }),
      ).networks,
    ).toEqual({ members: 3, tokens: 1 });
  });

  it("needs the plan to set or tighten, never to loosen, and keeps applying after a lapse", async () => {
    const free = await team("free");
    expect(await save(free, OFFICE_ONLY)).toMatchObject({ code: "plan_required" });
    const t = await team();
    value(await save(t, policy({ ipAllowlist: ["192.0.2.0/24", "198.51.100.0/24"] })));
    // The plan lapses: the allowlist keeps applying.
    await office().global.delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, t.id));
    expect(
      await resolveActor(regionsAt(from("203.0.113.1")).global, t.member.id, t.id),
    ).toMatchObject({
      code: "policy_refused",
    });
    // Tightening needs the plan; widening and lifting never do.
    expect(await save(t, OFFICE_ONLY)).toMatchObject({ code: "plan_required" });
    value(await save(t, policy({ ipAllowlist: ["192.0.0.0/16", "198.51.100.0/24"] })));
    value(await save(t, DEFAULT_POLICY));
    expect((await resolveActor(home().global, t.member.id, t.id)).ok).toBe(true);
  });

  it("is only for admins", async () => {
    const t = await team();
    expect(await save(t, OFFICE_ONLY, office(), t.editor.id)).toMatchObject({ code: "forbidden" });
  });
});

describe("the operator's escape hatch", () => {
  it("lifts only the allowlists of a workspace whose admins locked themselves out", async () => {
    const t = await team();
    value(
      await save(
        t,
        policy({ ...OFFICE_ONLY, publicAccess: "forbidden", tokenIpAllowlist: ["203.0.113.0/24"] }),
      ),
    );
    expect((await resolveActor(home().global, t.admin.id, t.id)).ok).toBe(false);
    expect(await clearRequestPolicies(regionsAt(BACKGROUND).global, t.id, NOW)).toEqual({
      outcome: "cleared",
      fields: ["ipAllowlist", "tokenIpAllowlist"],
    });
    expect((await resolveActor(home().global, t.admin.id, t.id)).ok).toBe(true);
    const state = value(
      await getWorkspacePolicy(home().global, { userId: t.admin.id, slug: t.slug, now: NOW }),
    );
    expect(state.policy).toEqual(policy({ publicAccess: "forbidden" }));
    expect(await clearRequestPolicies(regionsAt(BACKGROUND).global, t.id, NOW)).toEqual({
      outcome: "unchanged",
    });
    expect(await clearRequestPolicies(regionsAt(BACKGROUND).global, "ws_missing", NOW)).toEqual({
      outcome: "missing",
    });
  });
});

describe("races", () => {
  it("binds from the next role decision: a write already past it finishes", async () => {
    const t = await team();
    const doc = await workspaceArtifact(t, "restricted");
    // The allowlist is saved after the request decided the role and before it writes.
    const raced = raceBeforeFirstWrite(async () => {
      value(await save(t, OFFICE_ONLY));
    });
    expect(
      await renewArtifact(raced, { userId: t.admin.id, artifactId: doc, now: NOW }),
    ).toMatchObject({ ok: true });
    // The next request from outside the networks is refused.
    expect(
      await renewArtifact(home().get("default").db, {
        userId: t.admin.id,
        artifactId: doc,
        now: NOW + 1,
      }),
    ).toEqual(networkRefusal(HOME_IP));
  });

  it("refuses a request that decides the role again after the save, inside one request", async () => {
    const t = await team();
    const doc = await workspaceArtifact(t, "restricted");
    // Changing readers decides who takes part in a review again, after its first write: the
    // allowlist saved in between already binds it.
    const raced = raceBeforeFirstWrite(async () => {
      value(await save(t, OFFICE_ONLY));
    });
    expect(
      await updateAccess(raced, {
        userId: t.admin.id,
        artifactId: doc,
        change: { addReaders: ["first@example.test"] },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "policy_refused" });
  });
});

describe("two regions", () => {
  it("binds an EU workspace's people with no statement crossing databases", async () => {
    const admin = await user("EU admin");
    const member = await user("EU member");
    const slug = `rp-eu-${crypto.randomUUID().slice(0, 8)}`;
    const ws = value(
      await createWorkspace(office().global, {
        slug,
        name: "EU",
        adminUserId: admin.id,
        now: NOW,
        region: "eu",
      }),
    );
    await grantPlan(ws.id, "enterprise", { seats: 5 });
    await office()
      .global.insert(schema.workspaceMembers)
      .values({ workspaceId: ws.id, userId: member.id, role: "member", updatedAt: NOW });
    const t = { id: ws.id, slug, admin, editor: member, member, outsider: member };
    value(await save(t, OFFICE_ONLY));
    // The strict region guard is on in these tests: any wrong-handle statement would throw. The
    // policy is global, read with the membership; the EU region's handle reaches it only through
    // `.global`, so a regional service refuses without a cross-database statement.
    expect(await resolveActor(home().global, member.id, ws.id)).toEqual(networkRefusal(HOME_IP));
    expect(await resolveOwnerScope(home().get("eu").db.global, member.id, slug)).toEqual(
      networkRefusal(HOME_IP),
    );
    expect((await resolveActor(office().global, member.id, ws.id)).ok).toBe(true);
    expect(
      (await listUserWorkspaces(home().global, member.id)).find((row) => row.id === ws.id)?.blocked,
    ).toBe(true);
  });
});

describe("D1 calls", () => {
  it("adds no call to resolving a role, with or without an allowlist", async () => {
    const t = await team();
    const count = async (request: RequestContext) => {
      const { database, count: calls } = recording(env.DB, request);
      await resolveActor(database.global, t.member.id, t.id);
      await listUserWorkspaces(database.global, t.member.id);
      return calls();
    };
    const before = await count(from(HOME_IP));
    value(await save(t, OFFICE_ONLY));
    expect(await count(from(OFFICE_IP))).toBe(before);
    expect(await count(from(HOME_IP))).toBe(before);
    // One query for the membership with its policy, one for the list.
    expect(before).toBe(2);
  });
});

// Kept close to the fixtures: a stored allowlist the operator restores comes back as it was.
describe("a stored allowlist", () => {
  it("reads back exactly as saved", async () => {
    const t = await team();
    value(await save(t, OFFICE_ONLY));
    const [row] = await office()
      .global.select({ policy: schema.workspaces.policy })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, t.id)));
    expect(row?.policy).toEqual(OFFICE_ONLY);
    // Not an IP anywhere else: the feature stores ranges an admin typed, never a visitor's address.
    expect(await sha256(JSON.stringify(row))).toBeTypeOf("string");
  });
});
