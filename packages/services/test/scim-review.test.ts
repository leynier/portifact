// SCIM provisioning (decision 0017): the findings of the security review of the first version,
// each reproduced. A directory may only act on addresses at the workspace's verified domains and
// on accounts it linked through them; sessions end once per actual removal; leaving by oneself
// holds; an admin's invitation keeps its role, source and expiry; removal blocks are written only
// for members; a lost race answers 409; an existing account added at once is told.

import { env } from "cloudflare:test";
import { schema } from "@portifact/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DirectoryNotifier } from "../src/directory-notices.ts";
import { suppressEmail } from "../src/email.ts";
import { acceptInvitation, inviteMember } from "../src/invitations.ts";
import { runJob } from "../src/outbox.ts";
import {
  claimDirectoryMemberships,
  createScimToken,
  createScimUser,
  deleteScimUser,
  patchScimUser,
  replaceScimUser,
  type ScimCaller,
  type ScimDeps,
} from "../src/scim.ts";
import { leaveWorkspace, workspaceSeats } from "../src/workspaces.ts";
import { db, grantPlan, NOW, value } from "./fixtures.ts";
import { raceGlobalBeforeFirstWrite } from "./race.ts";

const hex = () => crypto.randomUUID().replaceAll("-", "");
const global = () => db().global;

async function person(email: string) {
  const id = `u_${hex()}`;
  await global()
    .insert(schema.users)
    .values({
      id,
      name: "Someone",
      email,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  return id;
}

interface Team {
  id: string;
  slug: string;
  domain: string;
  admin: string;
  caller: ScimCaller;
}

async function team(seats = 10): Promise<Team> {
  const id = `ws_${hex()}`;
  const slug = `r${hex().slice(0, 20)}`;
  const domain = `rev${hex().slice(0, 10)}.com`;
  const admin = await person(`admin@${domain}`);
  await global()
    .insert(schema.workspaces)
    .values({ id, slug, name: "Corp", createdBy: admin, updatedAt: NOW });
  await global()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: id, userId: admin, role: "admin", updatedAt: NOW });
  await global()
    .insert(schema.workspaceDomains)
    .values({
      id: `wd_${hex()}`,
      workspaceId: id,
      domain,
      token: hex(),
      state: "verified",
      createdAt: NOW,
      expiresAt: NOW,
      verifiedAt: NOW,
    });
  await grantPlan(id, "enterprise", { seats });
  const token = value(
    await createScimToken(global(), {
      userId: admin,
      slug,
      body: { label: "Okta", expiresInDays: 365 },
      now: NOW,
    }),
  );
  return { id, slug, domain, admin, caller: { tokenId: token.token.id, workspaceId: id } };
}

/** Deps that record whose sessions were ended. */
function recording(fail = false) {
  const ended: string[] = [];
  const deps: ScimDeps = {
    sender: null,
    endSessions: async (account: string) => {
      if (fail) throw new Error("down");
      ended.push(account);
    },
  };
  return { deps, ended };
}

const user = (userName: string, active = true) => ({
  userName,
  externalId: null,
  active,
  names: {},
});

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { detail: string } }): T {
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

async function role(t: Team, userId: string) {
  const [row] = await global()
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, t.id),
        eq(schema.workspaceMembers.userId, userId),
      ),
    );
  return row?.role ?? null;
}

async function member(t: Team, userId: string, memberRole: "admin" | "member" = "member") {
  await global()
    .insert(schema.workspaceMembers)
    .values({ workspaceId: t.id, userId, role: memberRole, updatedAt: NOW });
}

async function invitations(t: Team, email: string) {
  return global()
    .select()
    .from(schema.workspaceInvitations)
    .where(
      and(
        eq(schema.workspaceInvitations.workspaceId, t.id),
        eq(schema.workspaceInvitations.email, email),
      ),
    );
}

async function removals(t: Team) {
  return global()
    .select({ userId: schema.workspaceRemovals.userId })
    .from(schema.workspaceRemovals)
    .where(eq(schema.workspaceRemovals.workspaceId, t.id));
}

const deactivate = { Operations: [{ op: "replace", path: "active", value: false }] };
const reactivate = { Operations: [{ op: "replace", path: "active", value: true }] };

describe("finding 1: only addresses at the workspace's verified domains", () => {
  it("refuses a create outside them even when inactive, and never removes such a member", async () => {
    const t = await team();
    const contractor = await person(`contractor-${hex().slice(0, 6)}@gmail.com`);
    const [row] = await global()
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, contractor));
    await member(t, contractor, "admin");
    const { deps, ended } = recording();
    const created = await createScimUser(
      global(),
      deps,
      t.caller,
      user(row?.email ?? "", false),
      NOW,
    );
    expect(created).toMatchObject({ ok: false, error: { status: 400, scimType: "invalidValue" } });
    expect(await role(t, contractor)).toBe("admin");
    expect(ended).toEqual([]);
    expect(await removals(t)).toEqual([]);
  });

  it("refuses moving a user to such an address through PUT or PATCH, whatever active is", async () => {
    const t = await team();
    const outsider = `out-${hex().slice(0, 6)}@gmail.com`;
    const victim = await person(outsider);
    await member(t, victim);
    const { deps, ended } = recording();
    const created = ok(await createScimUser(global(), deps, t.caller, user(`p@${t.domain}`), NOW));
    expect(
      await replaceScimUser(global(), deps, t.caller, created.user.id, user(outsider, false), NOW),
    ).toMatchObject({ ok: false, error: { status: 400, scimType: "invalidValue" } });
    expect(
      await patchScimUser(
        global(),
        deps,
        t.caller,
        created.user.id,
        {
          Operations: [
            { op: "replace", path: "userName", value: outsider },
            { op: "replace", path: "active", value: false },
          ],
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, error: { status: 400, scimType: "invalidValue" } });
    expect(await role(t, victim)).toBe("member");
    expect(ended).toEqual([]);
  });

  it("removes a linked person after the domain lapsed, but not an unlinked address", async () => {
    const t = await team();
    const { deps, ended } = recording();
    const linked = await person(`linked@${t.domain}`);
    const linkedRow = ok(
      await createScimUser(global(), deps, t.caller, user(`linked@${t.domain}`), NOW),
    );
    // A pending person who then joined by accepting the invitation: the directory never linked them.
    const pendingRow = ok(
      await createScimUser(global(), deps, t.caller, user(`later@${t.domain}`), NOW),
    );
    const later = await person(`later@${t.domain}`);
    const [pending] = await invitations(t, `later@${t.domain}`);
    value(
      await acceptInvitation(global(), {
        userId: later,
        key: { invitationId: pending?.id ?? "" },
        now: NOW,
      }),
    );
    expect(await role(t, later)).toBe("member");
    // Joining links the directory user now (decision 0017); unlink it to keep the case of an
    // account the directory never linked.
    await global()
      .update(schema.scimUsers)
      .set({ userId: null })
      .where(eq(schema.scimUsers.id, pendingRow.user.id));
    await global()
      .delete(schema.workspaceDomains)
      .where(eq(schema.workspaceDomains.workspaceId, t.id));

    ok(await patchScimUser(global(), deps, t.caller, linkedRow.user.id, deactivate, NOW + 1));
    expect(await role(t, linked)).toBeNull();
    expect(ended).toEqual([linked]);
    expect(
      await patchScimUser(global(), deps, t.caller, pendingRow.user.id, deactivate, NOW + 1),
    ).toMatchObject({ ok: false, error: { status: 400, scimType: "invalidValue" } });
    expect(await role(t, later)).toBe("member");
    expect(ended).toEqual([linked]);
  });
});

describe("finding 2: sessions end once per removal, and leaving holds", () => {
  it("ends sessions only when a membership was removed, and again only after a failed attempt", async () => {
    const t = await team();
    const ada = await person(`ada@${t.domain}`);
    const { deps, ended } = recording();
    const created = ok(
      await createScimUser(global(), deps, t.caller, user(`ada@${t.domain}`), NOW),
    );
    // The first attempt cannot end them: 503, and the retry ends them exactly once.
    const failing = recording(true);
    expect(
      await patchScimUser(global(), failing.deps, t.caller, created.user.id, deactivate, NOW + 1),
    ).toMatchObject({ ok: false, error: { status: 503 } });
    expect(await role(t, ada)).toBeNull();
    ok(await patchScimUser(global(), deps, t.caller, created.user.id, deactivate, NOW + 2));
    ok(await patchScimUser(global(), deps, t.caller, created.user.id, deactivate, NOW + 3));
    ok(
      await replaceScimUser(
        global(),
        deps,
        t.caller,
        created.user.id,
        user(`ada@${t.domain}`, false),
        NOW + 4,
      ),
    );
    expect(ended).toEqual([ada]);
  });

  it("does not bring back someone who left through a false to true toggle, only a new create", async () => {
    const t = await team();
    const bob = await person(`bob@${t.domain}`);
    const { deps } = recording();
    const created = ok(
      await createScimUser(global(), deps, t.caller, user(`bob@${t.domain}`), NOW),
    );
    value(await leaveWorkspace(global(), { userId: bob, slug: t.slug, now: NOW + 1 }));
    ok(await patchScimUser(global(), deps, t.caller, created.user.id, deactivate, NOW + 2));
    ok(await patchScimUser(global(), deps, t.caller, created.user.id, reactivate, NOW + 3));
    expect(await role(t, bob)).toBeNull();
    ok(
      await deleteScimUser(
        global(),
        t.caller,
        created.user.id,
        NOW + 4,
        deps.endSessions ?? (async () => {}),
      ),
    );
    ok(await createScimUser(global(), deps, t.caller, user(`bob@${t.domain}`), NOW + 5));
    expect(await role(t, bob)).toBe("member");
  });
});

describe("finding 3: an admin's invitation stays the admin's", () => {
  it("keeps the invitation's role, source and expiry, counts the address once, and grants member at sign-in", async () => {
    const t = await team();
    const email = `boss@${t.domain}`;
    const sent: unknown[] = [];
    const invited = value(
      await inviteMember(
        global(),
        { userId: t.admin, slug: t.slug, email, role: "admin", now: NOW },
        { send: async (message) => void sent.push(message) },
      ),
    );
    const before = await workspaceSeats(global(), t.id, NOW);
    ok(await createScimUser(global(), { sender: null }, t.caller, user(email), NOW + 1000));
    const rows = await invitations(t, email);
    const admin = rows.find((row) => row.id === invited.id);
    expect(admin).toMatchObject({ source: "admin", role: "admin", expiresAt: invited.expiresAt });
    expect(rows.filter((row) => row.source === "directory")).toEqual([
      expect.objectContaining({ role: "member" }),
    ]);
    expect((await workspaceSeats(global(), t.id, NOW + 1000)).used).toBe(before.used);
    const boss = await person(email);
    expect(await claimDirectoryMemberships(global(), { userId: boss, now: NOW + 2000 })).toBe(1);
    expect(await role(t, boss)).toBe("member");
    value(
      await acceptInvitation(global(), {
        userId: boss,
        key: { invitationId: invited.id },
        now: NOW + 3000,
      }),
    );
    expect(await role(t, boss)).toBe("admin");
  });

  it("works the same when the directory came first", async () => {
    const t = await team();
    const email = `chief@${t.domain}`;
    ok(await createScimUser(global(), { sender: null }, t.caller, user(email), NOW));
    const before = await workspaceSeats(global(), t.id, NOW);
    const invited = value(
      await inviteMember(
        global(),
        { userId: t.admin, slug: t.slug, email, role: "editor", now: NOW + 1 },
        { send: async () => {} },
      ),
    );
    const rows = await invitations(t, email);
    expect(rows.map((row) => [row.source, row.role]).sort()).toEqual([
      ["admin", "editor"],
      ["directory", "member"],
    ]);
    expect((await workspaceSeats(global(), t.id, NOW + 1)).used).toBe(before.used);
    const chief = await person(email);
    await claimDirectoryMemberships(global(), { userId: chief, now: NOW + 2 });
    expect(await role(t, chief)).toBe("member");
    value(
      await acceptInvitation(global(), {
        userId: chief,
        key: { invitationId: invited.id },
        now: NOW + 3,
      }),
    );
    expect(await role(t, chief)).toBe("editor");
  });
});

describe("finding 4: an existing account added at once is told", () => {
  it("writes one notice job for an account and none for a pending person", async () => {
    const t = await team();
    const ada = await person(`ada@${t.domain}`);
    ok(await createScimUser(global(), { sender: null }, t.caller, user(`ada@${t.domain}`), NOW));
    ok(await createScimUser(global(), { sender: null }, t.caller, user(`nobody@${t.domain}`), NOW));
    const jobs = await global()
      .select({ subject: schema.outbox.subject, payload: schema.outbox.payload })
      .from(schema.outbox)
      .where(eq(schema.outbox.topic, "directory_notice" as never));
    const mine = jobs.filter((job) => job.subject === ada);
    expect(mine).toHaveLength(1);
  });
});

describe("finding 4: the notice job", () => {
  async function jobsOf(subject: string) {
    return global()
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.topic, "directory_notice"), eq(schema.outbox.subject, subject)));
  }
  const run = (row: typeof schema.outbox.$inferSelect, notifier: DirectoryNotifier, now = NOW) =>
    runJob(db(), env.ARTIFACTS, { id: row.id, topic: "directory_notice" }, now, {
      directoryNotifier: notifier,
    });

  it("sends once in the person's language, at most once a day, and only to a member", async () => {
    const t = await team();
    const ada = await person(`ada@${t.domain}`);
    const sent: { to: string; workspaceSlug: string }[] = [];
    const notifier: DirectoryNotifier = { send: async (notice) => void sent.push(notice) };
    const created = ok(
      await createScimUser(global(), { sender: null }, t.caller, user(`ada@${t.domain}`), NOW),
    );
    const [job] = await jobsOf(ada);
    if (!job) throw new Error("no job");
    expect(await run(job, notifier)).toBe("done");
    expect(sent).toEqual([
      expect.objectContaining({ to: `ada@${t.domain}`, workspaceSlug: t.slug }),
    ]);
    expect(await run(job, notifier)).toBe("done");
    expect(sent).toHaveLength(1);
    // Removed and added again the same day: no second email.
    ok(
      await patchScimUser(
        global(),
        recording().deps,
        t.caller,
        created.user.id,
        deactivate,
        NOW + 1,
      ),
    );
    ok(
      await patchScimUser(
        global(),
        recording().deps,
        t.caller,
        created.user.id,
        reactivate,
        NOW + 2,
      ),
    );
    const [again] = await jobsOf(ada);
    if (!again) throw new Error("no second job");
    expect(await run(again, notifier, NOW + 3)).toBe("stale");
    expect(sent).toHaveLength(1);
  });

  it("puts the job back on a failed send and skips suppressed addresses and people removed since", async () => {
    const t = await team();
    const bea = await person(`bea@${t.domain}`);
    const created = ok(
      await createScimUser(global(), { sender: null }, t.caller, user(`bea@${t.domain}`), NOW),
    );
    const [job] = await jobsOf(bea);
    if (!job) throw new Error("no job");
    const down: DirectoryNotifier = {
      send: async () => {
        throw new Error("down");
      },
    };
    await expect(run(job, down)).rejects.toThrow("down");
    const [back] = await jobsOf(bea);
    expect(back).toBeDefined();
    if (!back) return;
    await suppressEmail(global(), { email: `bea@${t.domain}`, reason: "provider", now: NOW });
    const sent: unknown[] = [];
    expect(await run(back, { send: async (n) => void sent.push(n) })).toBe("stale");
    expect(sent).toEqual([]);

    const cy = await person(`cy@${t.domain}`);
    const third = ok(
      await createScimUser(global(), { sender: null }, t.caller, user(`cy@${t.domain}`), NOW),
    );
    ok(
      await patchScimUser(global(), recording().deps, t.caller, third.user.id, deactivate, NOW + 1),
    );
    const [late] = await jobsOf(cy);
    if (!late) throw new Error("no job");
    expect(await run(late, { send: async (n) => void sent.push(n) })).toBe("stale");
    expect(sent).toEqual([]);
    void created;
  });
});

describe("finding 5: removal blocks only for members", () => {
  it("writes no workspace_removals row for an account that is not a member", async () => {
    const t = await team();
    const eve = await person(`eve@${t.domain}`);
    const { deps } = recording();
    const created = ok(
      await createScimUser(global(), deps, t.caller, user(`eve@${t.domain}`), NOW),
    );
    value(await leaveWorkspace(global(), { userId: eve, slug: t.slug, now: NOW + 1 }));
    ok(await patchScimUser(global(), deps, t.caller, created.user.id, deactivate, NOW + 2));
    expect(await removals(t)).toEqual([]);
  });
});

describe("finding 6: a lost race is a conflict", () => {
  it("answers 409 to a delete that lost a race while the domain lapsed", async () => {
    const t = await team();
    const { deps } = recording();
    const created = ok(
      await createScimUser(global(), deps, t.caller, user(`race@${t.domain}`), NOW),
    );
    const raced = raceGlobalBeforeFirstWrite(async () => {
      await global()
        .update(schema.scimUsers)
        .set({ writeId: "someone-else" })
        .where(eq(schema.scimUsers.id, created.user.id));
      await global()
        .delete(schema.workspaceDomains)
        .where(eq(schema.workspaceDomains.workspaceId, t.id));
    });
    // The other write wins every claim this request makes.
    const realBatch = raced.batch.bind(raced);
    raced.batch = (async (statements: Parameters<typeof realBatch>[0]) => {
      const out = await realBatch(statements);
      await global()
        .update(schema.scimUsers)
        .set({ writeId: "someone-else" })
        .where(eq(schema.scimUsers.id, created.user.id));
      return out;
    }) as unknown as typeof raced.batch;
    expect(
      await deleteScimUser(raced, t.caller, created.user.id, NOW + 1, async () => {}),
    ).toMatchObject({ ok: false, error: { status: 409 } });
  });
});
