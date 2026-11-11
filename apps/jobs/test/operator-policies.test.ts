// The operator's workspace policy commands (decision 0015): exporting the policies before a D1
// Time Travel restore and setting them again after it, so a restore never lifts one.
import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);
// With a network allowlist (decision 0020): a restore must not lift it either.
const POLICY = {
  publicAccess: "forbidden",
  defaultAccess: "restricted",
  readerDomains: null,
  shareLinks: "allowed",
  shareLinkMaxDays: null,
  ipAllowlist: ["192.0.2.0/24", "2001:db8::/32"],
  tokenIpAllowlist: null,
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

  it("exports a policy stored before the network allowlists with them lifted", async () => {
    const { ipAllowlist: _people, tokenIpAllowlist: _tokens, ...older } = POLICY;
    const id = await workspace(older);
    const written = new Map<string, string>();
    await runOperator(db(), ["export-policies", "--out", "p.jsonl"], NOW, {
      read: async () => "",
      write: async (path, text) => {
        written.set(path, text);
      },
    });
    expect(written.get("p.jsonl")).toContain(
      `{"workspaceId":"${id}","policy":${JSON.stringify({ ...older, ipAllowlist: null, tokenIpAllowlist: null })}}`,
    );
  });
});

describe("clear-request-policies", () => {
  const slugOf = (id: string) => id.slice(3, 23);

  it("lifts only the network allowlists, as the operator, with counts in the audit log", async () => {
    const id = await workspace({ ...POLICY, tokenIpAllowlist: ["198.51.100.7/32"] });
    expect((await runOperator(db(), ["clear-request-policies", slugOf(id)], NOW)).output).toContain(
      `clear-request-policies needs --confirm ${slugOf(id)}`,
    );
    const cleared = await runOperator(
      db(),
      ["clear-request-policies", slugOf(id), "--confirm", slugOf(id)],
      NOW,
    );
    expect(cleared).toEqual({
      exitCode: 0,
      output: `Lifted ipAllowlist and tokenIpAllowlist of workspace ${slugOf(id)} (${id}); its other policies are unchanged. The audit log records it as the operator.`,
    });
    const [row] = await db()
      .select({ policy: schema.workspaces.policy, revision: schema.workspaces.policyRevision })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id));
    expect(row).toEqual({
      policy: { ...POLICY, ipAllowlist: null, tokenIpAllowlist: null },
      revision: 2,
    });
    const events = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "policy.changed", actorType: "operator" });
    // Counts only: no address or range ever enters the audit log.
    expect(events[0]?.detail).toEqual({
      fields: ["ipAllowlist", "tokenIpAllowlist"],
      ipRanges: null,
      tokenIpRanges: null,
      confirmed: false,
    });
    expect(JSON.stringify(events)).not.toContain("192.0.2");
    // Again: nothing left to lift, nothing recorded.
    expect(
      (
        await runOperator(
          db(),
          ["clear-request-policies", slugOf(id), "--confirm", slugOf(id)],
          NOW + 1,
        )
      ).output,
    ).toBe(`Workspace ${slugOf(id)} has no network allowlist; nothing changed.`);
  });

  it("stores no policy when the allowlists were all there was, and answers a missing one", async () => {
    const id = await workspace({
      ...POLICY,
      publicAccess: "allowed",
      tokenIpAllowlist: null,
    });
    await runOperator(db(), ["clear-request-policies", id, "--confirm", slugOf(id)], NOW);
    const [row] = await db()
      .select({ policy: schema.workspaces.policy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id));
    expect(row?.policy).toBeNull();
    expect(
      await runOperator(db(), ["clear-request-policies", "no-such-slug", "--confirm", "x"], NOW),
    ).toEqual({ exitCode: 1, output: "Workspace not found." });
    expect((await runOperator(db(), ["clear-request-policies"], NOW)).output).toContain(
      "clear-request-policies needs a slug or workspace ID.",
    );
    expect(OPERATOR_USAGE).toContain("clear-request-policies <slug|workspace-id>");
  });
});
