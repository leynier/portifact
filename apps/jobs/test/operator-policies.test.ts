// The operator's workspace policy commands (decision 0015): exporting the policies before a D1
// Time Travel restore and setting them again after it, so a restore never lifts one.
import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);
const POLICY = {
  publicAccess: "forbidden",
  defaultAccess: "restricted",
  readerDomains: null,
  shareLinks: "allowed",
  shareLinkMaxDays: null,
};

async function workspace(policy: unknown) {
  const id = `ws_${crypto.randomUUID().replaceAll("-", "")}`;
  await db()
    .insert(schema.workspaces)
    .values({
      id,
      slug: id.slice(3, 23),
      name: "Team",
      createdBy: "u_operator",
      updatedAt: NOW,
      policy,
      policyRevision: policy === null ? 0 : 1,
    });
  return id;
}

describe("operator policy commands", () => {
  it("exports the policies and applies them again after a rewind", async () => {
    const kept = await workspace(POLICY);
    const written = new Map<string, string>();
    const files = {
      read: async (path: string) => written.get(path) ?? "",
      write: async (path: string, text: string) => {
        written.set(path, text);
      },
    };
    const exported = await runOperator(
      db(),
      ["export-policies", "--out", "policies.jsonl"],
      NOW,
      files,
    );
    expect(exported.output).toMatch(/^Wrote \d+ workspace policy\(ies\) to policies\.jsonl\.$/);
    expect(written.get("policies.jsonl")).toContain(
      `{"workspaceId":"${kept}","policy":${JSON.stringify(POLICY)}}`,
    );
    // The restore rewinds the policy; another workspace has one the file does not list.
    await db()
      .update(schema.workspaces)
      .set({ policy: null, policyRevision: 0 })
      .where(eq(schema.workspaces.id, kept));
    const extra = await workspace({ ...POLICY, shareLinks: "disabled" });
    const applied = await runOperator(
      db(),
      ["apply-policies", "--file", "policies.jsonl"],
      NOW + 1,
      files,
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.output).toContain("Applied 1 workspace policy(ies)");
    expect(applied.output).toContain("have a policy the file does not list");
    expect(applied.output).toContain(`  ${extra}`);
    const [row] = await db()
      .select({ policy: schema.workspaces.policy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, kept));
    expect(row?.policy).toEqual(POLICY);
  });

  it("refuses a bad line and needs its paths", async () => {
    const files = {
      read: async () => '{"workspaceId":"ws_1","policy":{}}\n',
      write: async () => {},
    };
    expect(await runOperator(db(), ["apply-policies", "--file", "x"], NOW, files)).toEqual({
      exitCode: 1,
      output: "Line 1 of x is not an exported workspace policy; nothing was applied.",
    });
    expect((await runOperator(db(), ["apply-policies"], NOW)).output).toContain(
      "apply-policies needs --file <file>.",
    );
    expect((await runOperator(db(), ["export-policies"], NOW)).output).toContain(
      "export-policies needs --out <file>.",
    );
    expect(OPERATOR_USAGE).toContain("export-policies --out <file>");
  });
});
