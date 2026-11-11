// The operator's plan commands (premium plan section 3, F1): the only way a plan is granted.
import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);
const run = (...argv: string[]) => runOperator(db(), argv, NOW);

async function account(): Promise<{ id: string; email: string }> {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${id}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: "Owner",
      email,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

async function limits(ownerId: string) {
  const [row] = await db()
    .select({ active: schema.accountUsage.activeLimit, bytes: schema.accountUsage.bytesLimit })
    .from(schema.accountUsage)
    .where(eq(schema.accountUsage.ownerId, ownerId));
  return row;
}

describe("operator plan commands", () => {
  it("shows an owner without a plan as free, with no usage rows yet", async () => {
    const owner = await account();
    const shown = await run("plan", owner.email);
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toContain(`owner       ${owner.id}`);
    expect(shown.output).toContain("row         none (free)");
    expect(shown.output).toContain("effective   free, 1 seat(s), no end");
    expect(shown.output).toContain("active      0 of 50 (no row yet, defaults to free)");
  });

  it("grants a plan with seats, an end date, a note and overrides, by email", async () => {
    const owner = await account();
    const granted = await run(
      "set-plan",
      owner.email.toUpperCase(),
      "team",
      "--seats",
      "2",
      "--until",
      "2027-01-31",
      "--note",
      "pilot customer",
      "--overrides",
      '{"limits":{"activeArtifacts":2500},"features":{"sso":true}}',
    );
    expect(granted.exitCode).toBe(0);
    expect(granted.output).toContain(`Set the plan of ${owner.id} to team.`);
    expect(granted.output).toContain(
      'row         team, 2 seat(s), until 2027-01-31T00:00:00.000Z, overrides {"limits":{"activeArtifacts":2500},"features":{"sso":true}}',
    );
    expect(granted.output).toContain("granted     by operator, ");
    expect(granted.output).toContain(": pilot customer");
    expect(granted.output).toContain("active      0 of 2,500 (column 2,500)");
    expect(granted.output).toContain("storage     0 of 60,000,000,000 (column 60,000,000,000)");
    expect(granted.output).toMatch(/features {4}.*sso/);
    expect(await limits(owner.id)).toEqual({ active: 2_500, bytes: 60_000_000_000 });
    expect((await run("plan", owner.id)).output).toContain("effective   team, 2 seat(s)");
  });

  it("sets how long audit events are kept, from 30 days to seven years", async () => {
    const owner = await account();
    expect((await run("plan", owner.id)).output).toContain("audit log   kept 90 days");
    for (const days of [30, 2557]) {
      const granted = await run(
        "set-plan",
        owner.id,
        "enterprise",
        "--overrides",
        `{"limits":{"auditRetentionDays":${days}}}`,
        // Without a grace: a shorter retention than the owner had would be held for 60 days.
        "--no-grace",
      );
      expect(granted.exitCode).toBe(0);
      expect(granted.output).toContain(`audit log   kept ${days.toLocaleString("en-US")} days`);
    }
  });

  it("holds what a lowered or removed plan kept, shows it, and ends it with --no-grace", async () => {
    const owner = await account();
    await run("set-plan", owner.id, "team");
    expect((await run("plan", owner.id)).output).toContain("grace       none");
    const lowered = await run("set-plan", owner.id, "pro");
    expect(lowered.output).toContain(
      "grace       until 2027-01-09T12:00:00.000Z, holding team: 100 previous version(s) for 365 days",
    );
    expect(lowered.output).toContain("held reads  ");
    expect(lowered.output).toMatch(/ {2}lowered {2}team {7}from 2026-11-10T12:00:00\.000Z/);
    const removed = await run("remove-plan", owner.id);
    expect(removed.output).toContain(
      `Removed the plan of ${owner.id}; it is on free. What it kept is held until 2027-01-09T12:00:00.000Z.`,
    );
    expect(removed.output).toContain("row         free, 1 seat(s), no end");
    // Each drop is its own hold, listed with its own start and end.
    expect(removed.output).toMatch(/ {2}lowered {2}team/);
    expect(removed.output).toMatch(/ {2}removed {2}pro/);
    const ended = await run("remove-plan", owner.id, "--no-grace");
    expect(ended.exitCode).toBe(0);
    expect(ended.output).toContain("row         none (free)");
    expect(ended.output).toContain("grace       none");
    expect(OPERATOR_USAGE).toContain("remove-plan <owner> [--no-grace]");
  });

  it("changes and removes a plan", async () => {
    const owner = await account();
    await run("set-plan", owner.id, "team");
    expect((await run("set-plan", owner.id, "pro")).exitCode).toBe(0);
    expect(await limits(owner.id)).toEqual({ active: 500, bytes: 25_000_000_000 });
    const removed = await run("remove-plan", owner.id);
    expect(removed).toMatchObject({ exitCode: 0 });
    expect(removed.output).toContain(`Removed the plan of ${owner.id}; it is on free.`);
    expect(await limits(owner.id)).toEqual({ active: 50, bytes: 2_500_000_000 });
    expect((await run("remove-plan", owner.id)).output).toContain(`${owner.id} had no plan.`);
  });

  it("refuses bad input without writing anything", async () => {
    const owner = await account();
    const cases: [string[], string][] = [
      [["plan"], "plan needs an owner."],
      [["remove-plan"], "remove-plan needs an owner."],
      [["set-plan", owner.id], "set-plan needs an owner and a plan."],
      [["set-plan", owner.id, "gold"], "set-plan needs an owner and a plan."],
      [
        ["set-plan", owner.id, "pro", "--until", "next year"],
        "--until must be an ISO date, like 2027-01-31.",
      ],
      [["set-plan", owner.id, "pro", "--overrides", "{nope"], "--overrides must be JSON."],
    ];
    for (const [argv, message] of cases) {
      expect(await run(...argv)).toEqual({
        exitCode: 2,
        output: `${message}\n\n${OPERATOR_USAGE}`,
      });
    }
    const refused: [string[], string][] = [
      [
        ["set-plan", owner.id, "pro", "--seats", "0"],
        "Seats must be a whole number from 1 to 10000.",
      ],
      [["set-plan", owner.id, "pro", "--until", "2026-01-01"], "The plan must end in the future."],
      [
        ["set-plan", owner.id, "pro", "--overrides", '{"limits":{"activeArtifacts":-1}}'],
        "The overrides are not valid.",
      ],
      [
        ["set-plan", owner.id, "enterprise", "--overrides", '{"limits":{"auditRetentionDays":29}}'],
        "The overrides are not valid: auditRetentionDays must be a whole number of days from 30 to 2557.",
      ],
      [
        [
          "set-plan",
          owner.id,
          "enterprise",
          "--overrides",
          '{"limits":{"auditRetentionDays":2558}}',
        ],
        "The overrides are not valid: auditRetentionDays must be a whole number of days from 30 to 2557.",
      ],
      [["set-plan", "nobody@example.test", "pro"], "Account or workspace not found."],
      [["set-plan", "u_missing", "pro"], "Account or workspace not found."],
      [["plan", "nobody@example.test"], "Account or workspace not found."],
      [["remove-plan", "nobody@example.test"], "Account or workspace not found."],
    ];
    for (const [argv, output] of refused) {
      expect(await run(...argv)).toEqual({ exitCode: 1, output });
    }
    expect((await run("plan", owner.id)).output).toContain("row         none (free)");
  });

  it("exports the plans and grants them again after a restore rewound them", async () => {
    const kept = await account();
    const ended = await account();
    const gone = await account();
    const back = await account();
    await run("set-plan", kept.id, "team", "--seats", "3", "--note", "pilot");
    await run("set-plan", ended.id, "pro", "--until", "2026-11-11");
    await run("set-plan", gone.id, "pro");
    const written = new Map<string, string>();
    const files = {
      read: async (path: string) => written.get(path) ?? "",
      write: async (path: string, text: string) => {
        written.set(path, text);
      },
    };
    const exported = await runOperator(db(), ["export-plans", "--out", "plans.jsonl"], NOW, files);
    expect(exported.output).toMatch(/^Wrote \d+ plan\(s\) to plans\.jsonl\.$/);
    expect(written.get("plans.jsonl")).toContain(
      `{"ownerId":"${kept.id}","plan":"team","seats":3,"validUntil":null,"overrides":null,"grantedBy":"operator","note":"pilot","grace":null,"graceNotices":null}`,
    );

    // The restore rewinds to before the grants; one plan removed since comes back.
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, kept.id));
    await db().delete(schema.ownerPlans).where(eq(schema.ownerPlans.ownerId, ended.id));
    await db().delete(schema.users).where(eq(schema.users.id, gone.id));
    await run("set-plan", back.id, "pro");
    const later = Date.UTC(2026, 10, 12);
    const applied = await runOperator(db(), ["apply-plans", "--file", "plans.jsonl"], later, files);
    expect(applied.exitCode).toBe(0);
    expect(applied.output).toContain("owner(s) have a plan the file does not list");
    expect(applied.output).toContain(`  ${back.id}`);
    expect((await run("plan", kept.id)).output).toContain("row         team, 3 seat(s), no end");
    expect(await limits(kept.id)).toEqual({ active: 2_000, bytes: 90_000_000_000 });
    // A plan that ended a day before is back with its end, so its grace (decision 0022) runs on.
    const endedPlan = (await runOperator(db(), ["plan", ended.id], later)).output;
    expect(endedPlan).toContain("row         pro, 1 seat(s), until 2026-11-11T00:00:00.000Z");
    expect(endedPlan).toContain("grace       until 2027-01-10T00:00:00.000Z, holding pro");
    expect((await run("plan", back.id)).output).toContain("row         pro");
  });

  it("refuses a plans file with a bad line and needs its paths", async () => {
    const files = {
      read: async () => '{"ownerId":"u_a","plan":"gold"}\n',
      write: async () => {},
    };
    expect(await runOperator(db(), ["apply-plans", "--file", "x"], NOW, files)).toEqual({
      exitCode: 1,
      output: "Line 1 of x is not an exported plan; nothing was applied.",
    });
    expect((await run("apply-plans")).output).toContain("apply-plans needs --file <file>.");
    expect((await run("export-plans")).output).toContain("export-plans needs --out <file>.");
  });

  it("refuses a plans file whose grace slot is out of bounds, naming the line, applying nothing", async () => {
    const owner = await account();
    const slot = {
      plan: "pro",
      reason: "removed",
      from: NOW,
      until: NOW + 60 * 86_400_000,
      limits: {
        archiveMonths: 12,
        retainedPreviousVersions: 50,
        previousVersionRetentionDays: 90,
        accessLogRetentionDays: 365,
        auditRetentionDays: 90,
      },
      features: [],
    };
    const line = (grace: unknown) =>
      JSON.stringify({
        ownerId: owner.id,
        plan: "free",
        seats: 1,
        validUntil: null,
        overrides: null,
        grantedBy: "operator",
        note: null,
        grace,
      });
    for (const bad of [
      { ...slot, until: 9e15 },
      { ...slot, until: NOW + 61 * 86_400_000 },
      { ...slot, limits: { ...slot.limits, previousVersionRetentionDays: 1e9 } },
    ]) {
      const files = {
        read: async () => `${line([slot])}\n${line([bad])}\n`,
        write: async () => {},
      };
      expect(await runOperator(db(), ["apply-plans", "--file", "x"], NOW, files)).toEqual({
        exitCode: 1,
        output: "Line 2 of x is not an exported plan; nothing was applied.",
      });
    }
    expect((await run("plan", owner.id)).output).toContain("row         none (free)");
  });

  it("shows a hold folded past the slot limit as such", async () => {
    const owner = await account();
    await run("set-plan", owner.id, "enterprise");
    // Ten drops: two past the slot limit.
    for (let i = 0; i < 11; i += 1) {
      const days = 600 - i;
      await runOperator(
        db(),
        [
          "set-plan",
          owner.id,
          "enterprise",
          "--overrides",
          `{"limits":{"auditRetentionDays":${days}}}`,
        ],
        NOW + i * 3_600_000,
      );
    }
    const shown = await runOperator(db(), ["plan", owner.id], NOW + 12 * 3_600_000);
    expect(shown.output).toMatch(/\(folded: \d+ holds\)/);
  });

  it("lists the plan commands in the usage", () => {
    expect(OPERATOR_USAGE).toContain("set-plan <owner> <plan>");
    expect(OPERATOR_USAGE).toContain("workspace:<slug>");
    expect(OPERATOR_USAGE).toContain("Plans: free, pro, team, enterprise");
  });
});
