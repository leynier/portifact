import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { isEmailSuppressed, suppressEmail } from "@portifact/services";
import { beforeEach, describe, expect, it } from "vitest";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 16);
const db = () => createDb(env.DB);
const run = (...argv: string[]) => runOperator(db(), argv, NOW);

beforeEach(async () => {
  await db().delete(schema.emailSuppressions);
});

describe("operator email suppression commands", () => {
  it("says when nothing is suppressed", async () => {
    expect(await run("email-suppressions")).toEqual({
      exitCode: 0,
      output: "No email suppressions.",
    });
  });

  it("lists suppressions with a masked hint, never the address", async () => {
    await suppressEmail(db(), { email: "ana.lopez@example.test", reason: "complaint", now: NOW });
    await suppressEmail(db(), {
      email: "old@example.test",
      reason: "provider",
      now: NOW - 30 * 86_400_000,
    });
    const result = await run("email-suppressions");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("a***@example.test  complaint  since 2026-11-16T00:00:00.000Z");
    expect(result.output).not.toContain("ana.lopez");
    expect(result.output).not.toContain("o***@example.test");
  });

  it("lifts a suppression by address and says when there was none", async () => {
    await suppressEmail(db(), { email: "lift@example.test", reason: "hard_bounce", now: NOW });
    const lifted = await run("lift-email-suppression", "Lift@Example.test");
    expect(lifted.exitCode).toBe(0);
    expect(lifted.output).toContain("Lifted the suppression of l***@example.test");
    expect(lifted.output).toContain("Email Service keeps its own list");
    expect(await isEmailSuppressed(db(), "lift@example.test", NOW)).toBe(false);
    expect(await run("lift-email-suppression", "lift@example.test")).toEqual({
      exitCode: 1,
      output: "No suppression for l***@example.test.",
    });
  });

  it("explains usage for bad arguments", async () => {
    for (const argv of [
      ["lift-email-suppression"],
      ["lift-email-suppression", "not-an-address"],
      ["email-suppressions", "--limit", "0"],
      ["email-suppressions", "--limit", "501"],
    ]) {
      const result = await run(...argv);
      expect(result.exitCode, argv.join(" ")).toBe(2);
      expect(result.output).toContain(OPERATOR_USAGE);
    }
    expect(OPERATOR_USAGE).toContain("email-suppressions [--limit N]");
    expect(OPERATOR_USAGE).toContain("lift-email-suppression <email>");
  });
});
