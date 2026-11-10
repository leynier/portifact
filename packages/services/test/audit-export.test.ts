// Exporting the audit log (premium plan E3, feature `auditExport`): the same events, order and
// window as reading it, as CSV or JSON Lines, in bounded parts that resume with a cursor, for the
// owner's admins on a plan with the feature; starting one is rate limited and recorded.
import {
  AUDIT_EXPORT,
  type AuditEventView,
  type AuditExportFormat,
  type AuditFilters,
  type AuditKind,
  planRequiredMessage,
  type WorkspaceRole,
} from "@portifact/contracts";
import { hitRateLimit, schema } from "@portifact/db";
import { type Actor, auditCsvHeader, auditCsvRow, personalActor } from "@portifact/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { exportAuditLog, GLOBAL_AUDIT_KINDS, getAuditLog, pruneAuditEvents } from "../src/audit.ts";
import { planView } from "../src/plans.ts";
import { getAccountUsage } from "../src/usage.ts";
import { createWorkspace, resolveOwnerScope } from "../src/workspaces.ts";
import { DAY, db, grantPlan, NOW, user, value } from "./fixtures.ts";

const global = () => db().global;
const LATER = NOW + DAY;
type User = { id: string; email: string };

interface Row {
  id: string;
  at: number;
  kind: AuditKind;
  actorId?: string | null;
  targetId?: string | null;
  artifactId?: string | null;
  detail?: object;
}

async function insert(ownerId: string, rows: readonly Row[]) {
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
          actorId: row.actorId === undefined ? ownerId : row.actorId,
          targetId: row.targetId === undefined ? ownerId : row.targetId,
          artifactId: row.artifactId ?? null,
          detail: row.detail ?? {},
        })),
      );
  }
}

async function enterprise(name = "Ada"): Promise<User> {
  const owner = await user(name);
  await grantPlan(owner.id, "enterprise");
  return owner;
}

interface Exported {
  text: string;
  parts: number;
  cursors: (string | null)[];
}

/** Follows the cursor to the end, as the CLI and the dashboard do, and joins the parts. */
async function exportAll(
  actor: Actor,
  format: AuditExportFormat,
  filters: AuditFilters = {},
  options: { now?: number; bounds?: { rowsPerDatabase: number; pageSize: number } } = {},
): Promise<Exported> {
  let text = "";
  let cursor: string | undefined;
  const cursors: (string | null)[] = [];
  let parts = 0;
  do {
    const part = value(
      await exportAuditLog(db(), {
        actor,
        format,
        filters,
        cursor,
        now: options.now ?? LATER,
        bounds: options.bounds,
      }),
    );
    for await (const chunk of part.lines()) text += chunk;
    parts += 1;
    cursors.push(part.nextCursor);
    cursor = part.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { text, parts, cursors };
}

const ids = (jsonl: string) =>
  jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as AuditEventView).id);

/**
 * Events in both databases, with ties at one moment and kinds from each, so the order across
 * them and across part boundaries is what is tested: 13 regional and 12 global events.
 */
function mixed(prefix: string): Row[] {
  return Array.from({ length: 25 }, (_, i) => ({
    id: `ae_${prefix}${String(i).padStart(4, "0")}`,
    // Pairs share a moment, so the ID decides within it.
    at: NOW - Math.floor(i / 2) * 1000,
    kind: i % 2 === 0 ? ("artifact.renewed" as const) : ("plan.removed" as const),
  }));
}

describe("exporting the audit log", () => {
  it("lists every event once, newest first across both databases, at any part size", async () => {
    const owner = await enterprise();
    const rows = mixed("m");
    await insert(owner.id, rows);
    const expected = [...rows]
      .sort((x, y) => y.at - x.at || (y.id < x.id ? -1 : 1))
      .map((row) => row.id);
    const reading = value(
      await getAuditLog(db(), {
        actor: personalActor(owner.id),
        filters: {},
        limit: 100,
        now: LATER,
      }),
    );
    expect(reading.events.map((event) => event.id)).toEqual(expected);
    for (const [rowsPerDatabase, pageSize] of [
      [1, 1],
      [2, 1],
      [3, 2],
      [5, 5],
      [12, 4],
      [13, 7],
      [100, 3],
    ] as const) {
      const all = await exportAll(
        personalActor(owner.id),
        "jsonl",
        {},
        {
          bounds: { rowsPerDatabase, pageSize },
        },
      );
      expect(ids(all.text), `${rowsPerDatabase}/${pageSize}`).toEqual(expected);
      // A part holds at most its bound per database, and every part but the last at least the
      // bound, so the export ends; the last may be empty when the rest fit exactly.
      expect(all.parts).toBeGreaterThanOrEqual(Math.ceil(25 / (2 * rowsPerDatabase)));
      expect(all.parts).toBeLessThanOrEqual(Math.ceil(25 / rowsPerDatabase) + 1);
    }
  });

  it("writes the same bytes for the same rows, and the reader's view of each event", async () => {
    const owner = await enterprise();
    const other = await user("Zed");
    await insert(owner.id, [
      { id: "ae_c", at: NOW, kind: "artifact.renewed", artifactId: "gonegonego" },
      {
        id: "ae_b",
        at: NOW - 1,
        kind: "member.left",
        actorId: other.id,
        detail: { role: "member" },
      },
      { id: "ae_a", at: NOW - 2, kind: "plan.removed", actorId: null },
    ]);
    const actor = personalActor(owner.id);
    const first = await exportAll(actor, "csv");
    const second = await exportAll(actor, "csv");
    expect(second.text).toBe(first.text);
    // Read just before the exports, which recorded their own starts at LATER.
    const reading = value(
      await getAuditLog(db(), { actor, filters: {}, limit: 100, now: LATER - 1 }),
    );
    expect(first.text).toBe(auditCsvHeader() + reading.events.map(auditCsvRow).join(""));
    // A removed member is shown by opaque ID, never by name or address.
    expect(first.text).toContain(`removed_member,${other.id},,`);
    expect(first.text).not.toContain(other.email);
    expect(first.text).not.toContain("Zed");
    expect(first.text).not.toContain(owner.email);
    const jsonl = await exportAll(actor, "jsonl");
    expect(
      jsonl.text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(reading.events);
  });

  it("applies the filters and never reaches past the retention", async () => {
    const owner = await enterprise();
    const actor = personalActor(owner.id);
    await insert(owner.id, [
      { id: "ae_new", at: NOW, kind: "artifact.renewed", artifactId: "abcdefghij" },
      { id: "ae_mid", at: NOW - DAY, kind: "plan.removed", actorId: "u_other" },
      { id: "ae_old", at: NOW - 100 * DAY, kind: "artifact.renewed" },
    ]);
    expect(ids((await exportAll(actor, "jsonl")).text)).toEqual(["ae_new", "ae_mid"]);
    expect(ids((await exportAll(actor, "jsonl", { kinds: ["plan.removed"] })).text)).toEqual([
      "ae_mid",
    ]);
    expect(ids((await exportAll(actor, "jsonl", { actor: "u_other" })).text)).toEqual(["ae_mid"]);
    expect(ids((await exportAll(actor, "jsonl", { target: "abcdefghij" })).text)).toEqual([
      "ae_new",
    ]);
    expect(
      ids(
        (
          await exportAll(actor, "jsonl", {
            from: new Date(NOW - 2 * DAY).toISOString(),
            to: new Date(NOW).toISOString(),
          })
        ).text,
      ),
    ).toEqual(["ae_mid"]);
    expect(
      await exportAuditLog(db(), {
        actor,
        format: "csv",
        filters: { from: new Date(NOW).toISOString(), to: new Date(NOW - 1).toISOString() },
        now: LATER,
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await exportAuditLog(db(), { actor, format: "csv", filters: {}, cursor: "nope", now: LATER }),
    ).toMatchObject({ ok: false, code: "invalid_input" });

    // A longer retention by contract reaches further back.
    await grantPlan(owner.id, "enterprise", { overrides: { limits: { auditRetentionDays: 365 } } });
    expect(ids((await exportAll(actor, "jsonl")).text)).toEqual(["ae_new", "ae_mid", "ae_old"]);
  });

  it("records the start once, with the format, kinds and dates, and never lists itself", async () => {
    const owner = await enterprise();
    await insert(owner.id, mixed("r"));
    const actor = personalActor(owner.id);
    const all = await exportAll(
      actor,
      "csv",
      {
        kinds: ["artifact.renewed", "plan.removed"],
        actor: owner.id,
        from: new Date(NOW - 30 * DAY).toISOString(),
      },
      { bounds: { rowsPerDatabase: 4, pageSize: 2 } },
    );
    expect(all.parts).toBeGreaterThan(1);
    const recorded = await db()
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.ownerId, owner.id),
          eq(schema.auditEvents.kind, "audit.exported"),
        ),
      );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      at: LATER,
      actorType: "user",
      actorId: owner.id,
      targetId: null,
      artifactId: null,
      detail: {
        format: "csv",
        kinds: 2,
        from: new Date(NOW - 30 * DAY).toISOString().slice(0, 10),
      },
    });
    // The event is regional, and the next export lists it.
    expect(GLOBAL_AUDIT_KINDS).not.toContain("audit.exported");
    expect(all.text).not.toContain("audit.exported");
    const next = await exportAll(actor, "jsonl", {}, { now: LATER + 1 });
    expect(next.text.split("\n")[0]).toContain('"kind":"audit.exported"');
    expect(next.text).not.toContain(owner.email);
  });

  it("limits starting exports per person and per owner, and resumed parts apart from them", async () => {
    const owner = await enterprise();
    await insert(owner.id, mixed("l"));
    const actor = personalActor(owner.id);
    const start = () => exportAuditLog(db(), { actor, format: "csv", filters: {}, now: LATER });
    let first: string | null = null;
    for (let i = 0; i < AUDIT_EXPORT.perActor.max; i += 1) {
      const part = value(
        await exportAuditLog(db(), {
          actor,
          format: "csv",
          filters: {},
          now: LATER,
          bounds: { rowsPerDatabase: 2, pageSize: 2 },
        }),
      );
      first ??= part.nextCursor;
    }
    expect(await start()).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many audit log exports. Try again later.",
    });
    // A refused start records nothing.
    const recorded = async () =>
      (
        await db()
          .select({ id: schema.auditEvents.id })
          .from(schema.auditEvents)
          .where(
            and(
              eq(schema.auditEvents.ownerId, owner.id),
              eq(schema.auditEvents.kind, "audit.exported"),
            ),
          )
      ).length;
    expect(await recorded()).toBe(AUDIT_EXPORT.perActor.max);
    // A resumed part does not count as a start and records nothing.
    expect(first).not.toBeNull();
    const resume = () =>
      exportAuditLog(db(), { actor, format: "csv", filters: {}, cursor: first ?? "", now: LATER });
    expect((await resume()).ok).toBe(true);
    expect(await recorded()).toBe(AUDIT_EXPORT.perActor.max);
    // Parts have their own limit per owner, so a made-up cursor cannot read without end.
    const parts = AUDIT_EXPORT.partsPerOwner;
    for (let i = 1; i < parts.max; i += 1) {
      await hitRateLimit(
        global().$client,
        `audit-export-part:owner:${owner.id}`,
        parts.windowSeconds * 1000,
        LATER,
      );
    }
    expect(await resume()).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many audit log exports. Try again later.",
    });
    expect(await recorded()).toBe(AUDIT_EXPORT.perActor.max);
    // The window ends: a new hour starts again.
    expect(
      (await exportAuditLog(db(), { actor, format: "csv", filters: {}, now: LATER + 3_600_000 }))
        .ok,
    ).toBe(true);
  });

  it("limits a workspace's exports across its admins", async () => {
    const t = await team("enterprise");
    const admins = [t.admin, ...(await Promise.all([1, 2, 3].map((i) => user(`Admin ${i}`))))];
    await db()
      .insert(schema.workspaceMembers)
      .values(
        admins.slice(1).map((admin) => ({
          workspaceId: t.id,
          userId: admin.id,
          role: "admin" as const,
          updatedAt: NOW,
        })),
      );
    let allowed = 0;
    for (let i = 0; i < AUDIT_EXPORT.perOwner.max + 1; i += 1) {
      const admin = admins[i % admins.length] as User;
      const result = await exportAuditLog(db(), {
        actor: workspaceActor(t, admin, "admin"),
        format: "jsonl",
        filters: {},
        now: LATER,
      });
      if (result.ok) allowed += 1;
      else expect(result.code).toBe("rate_limited");
    }
    expect(allowed).toBe(AUDIT_EXPORT.perOwner.max);
  });
});

describe("who may export", () => {
  it("is for admins on a plan with the feature; editors, members and tokens are refused", async () => {
    const t = await team("enterprise");
    await insert(t.id, [{ id: "ae_ws", at: NOW, kind: "artifact.renewed" }]);
    const admin = await exportAll(workspaceActor(t, t.admin, "admin"), "jsonl");
    expect(ids(admin.text)).toEqual(["ae_ws", expect.stringMatching(/^ae_/)]);
    const forbidden = {
      ok: false,
      code: "forbidden",
      message: "Your role on this workspace does not allow this.",
    };
    const attempt = (actor: Actor) =>
      exportAuditLog(db(), { actor, format: "csv", filters: {}, now: LATER });
    expect(await attempt(workspaceActor(t, t.editor, "editor"))).toEqual(forbidden);
    expect(await attempt(workspaceActor(t, t.member, "member"))).toEqual(forbidden);
    // A service token never reads the audit log, whatever role its row says (TOKEN_ACTIONS).
    const token: Actor = {
      userId: `st_${"0".repeat(32)}`,
      ownerId: t.id,
      role: "admin",
      region: "default",
      token: {
        restriction: { kind: "none" },
        scopes: ["artifacts:read"],
        createdAt: NOW,
        label: "CI",
      },
    };
    expect(await attempt(token)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await attempt({ ...token, role: "editor" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    // Someone who is not a member never gets an actor.
    expect((await resolveOwnerScope(global(), t.outsider.id, t.slug)).ok).toBe(false);
    // Nothing refused was recorded.
    const exported = await db()
      .select({ actorId: schema.auditEvents.actorId })
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.ownerId, t.id), eq(schema.auditEvents.kind, "audit.exported")),
      );
    expect(exported).toEqual([{ actorId: t.admin.id }]);
  });

  it("answers plan_required naming the export on Team and on free, and follows the owner's plan", async () => {
    const plan = { ok: false, code: "plan_required", message: planRequiredMessage("auditExport") };
    const t = await team("team");
    expect(
      await exportAuditLog(db(), {
        actor: workspaceActor(t, t.admin, "admin"),
        format: "csv",
        filters: {},
        now: LATER,
      }),
    ).toEqual(plan);
    // Reading still works on Team, and says the export is not included.
    expect(
      value(
        await getAuditLog(db(), {
          actor: workspaceActor(t, t.admin, "admin"),
          filters: {},
          limit: 10,
          now: LATER,
        }),
      ).exportable,
    ).toBe(false);
    const free = await user();
    expect(
      await exportAuditLog(db(), {
        actor: personalActor(free.id),
        format: "csv",
        filters: {},
        now: LATER,
      }),
    ).toEqual(plan);
    // The admin's own Enterprise plan does not reach a Team workspace.
    await grantPlan(t.admin.id, "enterprise");
    expect(
      await exportAuditLog(db(), {
        actor: workspaceActor(t, t.admin, "admin"),
        format: "csv",
        filters: {},
        now: LATER,
      }),
    ).toEqual(plan);
    // An override that removes reading the log removes exporting it too.
    const odd = await user();
    await grantPlan(odd.id, "enterprise", { overrides: { features: { audit: false } } });
    expect(
      await exportAuditLog(db(), {
        actor: personalActor(odd.id),
        format: "csv",
        filters: {},
        now: LATER,
      }),
    ).toEqual({ ok: false, code: "plan_required", message: planRequiredMessage("audit") });
  });

  it("exports only the owner's own events, never another owner's", async () => {
    const one = await enterprise("One");
    const two = await enterprise("Two");
    await insert(one.id, [{ id: "ae_one", at: NOW, kind: "artifact.renewed" }]);
    await insert(two.id, [{ id: "ae_two", at: NOW, kind: "plan.removed" }]);
    expect(ids((await exportAll(personalActor(one.id), "jsonl")).text)).toEqual(["ae_one"]);
    expect(ids((await exportAll(personalActor(two.id), "jsonl")).text)).toEqual(["ae_two"]);
  });
});

describe("retention set per plan", () => {
  const kept = async (ownerId: string) =>
    (
      await db()
        .select({ id: schema.auditEvents.id })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.ownerId, ownerId))
    )
      .map((row) => row.id)
      .sort();
  const listed = async (ownerId: string, now: number) =>
    value(await getAuditLog(db(), { actor: personalActor(ownerId), filters: {}, limit: 100, now }));

  it("lowered: older events stop being listed at once and go at the next scan", async () => {
    const owner = await enterprise();
    await insert(owner.id, [
      { id: "ae_20d", at: NOW - 20 * DAY, kind: "artifact.renewed" },
      { id: "ae_45d", at: NOW - 45 * DAY, kind: "artifact.renewed" },
      { id: "ae_80d", at: NOW - 80 * DAY, kind: "plan.removed" },
    ]);
    expect((await listed(owner.id, NOW)).events.map((e) => e.id)).toEqual([
      "ae_20d",
      "ae_45d",
      "ae_80d",
    ]);
    await grantPlan(owner.id, "enterprise", { overrides: { limits: { auditRetentionDays: 30 } } });
    const page = await listed(owner.id, NOW);
    expect(page.retentionDays).toBe(30);
    expect(page.events.map((e) => e.id)).toEqual(["ae_20d"]);
    // Still stored until the scan runs, which deletes them in both databases.
    expect(await kept(owner.id)).toEqual(["ae_20d", "ae_45d", "ae_80d"]);
    expect(await pruneAuditEvents(db(), global(), NOW)).toBeGreaterThanOrEqual(2);
    expect(await kept(owner.id)).toEqual(["ae_20d"]);
    // Raising it again brings nothing back.
    await grantPlan(owner.id, "enterprise", { overrides: { limits: { auditRetentionDays: 365 } } });
    expect((await listed(owner.id, NOW)).events.map((e) => e.id)).toEqual(["ae_20d"]);
  });

  it("raised: the scan keeps events past 90 days until the longer retention, and lists them", async () => {
    const owner = await enterprise();
    const neighbour = await enterprise("Bo");
    await grantPlan(owner.id, "enterprise", {
      overrides: { limits: { auditRetentionDays: 2557 } },
    });
    const old = [
      { id: "ae_200d", at: NOW - 200 * DAY, kind: "artifact.renewed" as const },
      { id: "ae_6y", at: NOW - 6 * 365 * DAY, kind: "plan.removed" as const },
      { id: "ae_8y", at: NOW - 8 * 365 * DAY, kind: "artifact.renewed" as const },
    ];
    await insert(owner.id, old);
    await insert(neighbour.id, [{ id: "ae_n200d", at: NOW - 200 * DAY, kind: "artifact.renewed" }]);
    await pruneAuditEvents(db(), global(), NOW);
    expect(await kept(owner.id)).toEqual(["ae_200d", "ae_6y"]);
    // An owner on the default 90 days loses the same age of event.
    expect(await kept(neighbour.id)).toEqual([]);
    const page = await listed(owner.id, NOW);
    expect(page.retentionDays).toBe(2557);
    expect(page.events.map((e) => e.id)).toEqual(["ae_200d", "ae_6y"]);
    // A plan that lapses reads as free (90 days): the scan then deletes what is older.
    await grantPlan(owner.id, "enterprise", {
      validUntil: NOW + DAY,
      overrides: { limits: { auditRetentionDays: 2557 } },
    });
    await pruneAuditEvents(db(), global(), NOW + 2 * DAY);
    expect(await kept(owner.id)).toEqual([]);
  });

  it("shows the retention in the usage body", async () => {
    const owner = await enterprise();
    const usage = async () =>
      planView(
        value(await getAccountUsage(db(), { actor: personalActor(owner.id), now: NOW })).plan,
      ).limits.auditRetentionDays;
    expect(await usage()).toBe(90);
    await grantPlan(owner.id, "enterprise", { overrides: { limits: { auditRetentionDays: 400 } } });
    expect(await usage()).toBe(400);
  });
});

interface Team {
  id: string;
  slug: string;
  admin: User;
  editor: User;
  member: User;
  outsider: User;
}

async function team(plan: "team" | "enterprise"): Promise<Team> {
  const [admin, editor, member, outsider] = [
    await user("Ada"),
    await user("Ed"),
    await user("Mia"),
    await user("Otto"),
  ];
  const slug = `x-${crypto.randomUUID().slice(0, 8)}`;
  const created = value(
    await createWorkspace(global(), { slug, name: "Team", adminUserId: admin.id, now: NOW }),
  );
  await db()
    .insert(schema.workspaceMembers)
    .values([
      { workspaceId: created.id, userId: editor.id, role: "editor", updatedAt: NOW },
      { workspaceId: created.id, userId: member.id, role: "member", updatedAt: NOW },
    ]);
  await grantPlan(created.id, plan, { seats: 10 });
  return { id: created.id, slug, admin, editor, member, outsider };
}

const workspaceActor = (t: Team, who: User, role: WorkspaceRole): Actor => ({
  userId: who.id,
  ownerId: t.id,
  role,
  region: "default",
});
