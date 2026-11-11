// The operator's plan commands and comment retention's restore guard (decision 0023, "Restores"):
// a plan change that takes `policies` from a workspace whose policy sets a comment retention
// deletes the workspace's guard record first, says so plainly when it cannot, and says the rule
// is paused when the record went but the plan change then failed.
import { env } from "cloudflare:test";
import { DEFAULT_POLICY } from "@portifact/contracts";
import { createDb, regionsFromEnv, schema } from "@portifact/db";
import { describe, expect, it } from "vitest";
import { runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);
const key = (id: string) => `system/comment-retention/${id}`;

/** An in-memory bucket for the guard records, which can refuse deletes. */
function bucket() {
  const held = new Map<string, string>();
  const fail = { delete: false };
  const stub = {
    get: async (k: string) => {
      const text = held.get(k);
      return text === undefined ? null : { text: async () => text };
    },
    put: async (k: string, text: string) => {
      held.set(k, text);
      return {};
    },
    delete: async (k: string) => {
      if (fail.delete) throw new Error("r2 unavailable");
      held.delete(k);
    },
  };
  return Object.assign(stub as unknown as R2Bucket, { held, fail });
}

/** A workspace on Enterprise whose policy sets a comment retention, with its guard record. */
async function ruled(guard: ReturnType<typeof bucket>) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  const token = crypto.randomUUID().replaceAll("-", "");
  await db()
    .insert(schema.workspaces)
    .values({
      id,
      slug: id.slice(3, 23),
      name: "Team",
      createdBy: "u_operator",
      updatedAt: NOW,
      policyRevision: 1,
      policy: {
        ...DEFAULT_POLICY,
        commentRetentionDays: 90,
        commentRetentionFrom: NOW,
        commentRetentionToken: token,
      },
    });
  await db().insert(schema.ownerPlans).values({
    ownerId: id,
    plan: "enterprise",
    seats: 10,
    validUntil: null,
    overrides: null,
    grantedBy: "operator",
    note: null,
    updatedAt: NOW,
  });
  await guard.put(key(id), JSON.stringify({ token, days: 90, from: NOW }));
  return id;
}

const withBucket = (guard: R2Bucket) => regionsFromEnv({ ...env, ARTIFACTS: guard });

describe("remove-plan and set-plan keep the guard honest", () => {
  for (const command of [["remove-plan"], ["set-plan", "team"]] as const) {
    const name = command[0];

    it(`${name} deletes the record before the plan change`, async () => {
      const guard = bucket();
      const id = await ruled(guard);
      const result = await runOperator(
        withBucket(guard),
        [...command.slice(0, 1), id, ...command.slice(1)],
        NOW,
      );
      expect(result.exitCode).toBe(0);
      expect(guard.held.has(key(id))).toBe(false);
    });

    it(`${name} says so and exits 1 when R2 refuses the delete`, async () => {
      const guard = bucket();
      const id = await ruled(guard);
      guard.fail.delete = true;
      const result = await runOperator(
        withBucket(guard),
        [...command.slice(0, 1), id, ...command.slice(1)],
        NOW,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("could not be deleted (R2 refused)");
      expect(result.output).toContain(`system/comment-retention/${id}`);
      expect(guard.held.has(key(id))).toBe(true);
    });

    it(`${name} says the guard is not maintained without a bucket bound`, async () => {
      const guard = bucket();
      const id = await ruled(guard);
      const result = await runOperator(
        db(),
        [...command.slice(0, 1), id, ...command.slice(1)],
        NOW,
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("no bucket is bound here");
    });
  }

  it("says the rule is paused when the record went and the plan change then failed", async () => {
    const guard = bucket();
    const id = await ruled(guard);
    // Every batch finds the plan row changed under it, so the change gives up (PLAN_CHANGED).
    let bump = NOW;
    const moving = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            bump += 1;
            await target
              .prepare("update owner_plans set updated_at = ?, seats = seats where owner_id = ?")
              .bind(bump, id)
              .run();
            await target
              .prepare("update owner_plans set seats = ? where owner_id = ?")
              .bind((bump % 5) + 2, id)
              .run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await runOperator(
      regionsFromEnv({ ...env, DB: moving, ARTIFACTS: guard }),
      ["set-plan", id, "team"],
      NOW,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("its comment retention is now paused");
    expect(guard.held.has(key(id))).toBe(false);
  });

  it("touches nothing for a plan that keeps policies", async () => {
    const guard = bucket();
    const id = await ruled(guard);
    const result = await runOperator(
      withBucket(guard),
      ["set-plan", id, "enterprise", "--seats", "10"],
      NOW,
    );
    expect(result.exitCode).toBe(0);
    expect(guard.held.has(key(id))).toBe(true);
  });
});
