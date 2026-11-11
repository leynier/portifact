// The operator's workspace policy commands (decision 0015): exporting the policies before a D1
// Time Travel restore and setting them again after it, so a restore never lifts one.
import { env } from "cloudflare:test";
import { createDb, regionsFromEnv, schema } from "@portifact/db";
import { policyOf } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);
// Every region's database and bucket: what apply-policies needs to re-arm comment retention.
const all = () => regionsFromEnv(env);
// With a network allowlist (decision 0020): a restore must not lift it either.
const POLICY = {
  publicAccess: "forbidden",
  defaultAccess: "restricted",
  readerDomains: null,
  shareLinks: "allowed",
  shareLinkMaxDays: null,
  ipAllowlist: ["192.0.2.0/24", "2001:db8::/32"],
  tokenIpAllowlist: null,
  sessionMaxHours: null,
  allowedClients: null,
  ssoRequired: false,
  artifactMaxDays: null,
  artifactMaxDaysFrom: null,
  commentRetentionDays: null,
  commentRetentionFrom: null,
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
      all(),
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
    // As it is read: a network list the row does not set is none (`storedPolicy`).
    expect(policyOf(row?.policy)).toEqual(POLICY);
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
    const {
      ipAllowlist: _people,
      tokenIpAllowlist: _tokens,
      sessionMaxHours: _age,
      allowedClients: _clients,
      ssoRequired: _sso,
      artifactMaxDays: _life,
      artifactMaxDaysFrom: _from,
      commentRetentionDays: _comments,
      commentRetentionFrom: _commentsFrom,
      ...older
    } = POLICY;
    const id = await workspace(older);
    const written = new Map<string, string>();
    await runOperator(db(), ["export-policies", "--out", "p.jsonl"], NOW, {
      read: async () => "",
      write: async (path, text) => {
        written.set(path, text);
      },
    });
    expect(written.get("p.jsonl")).toContain(
      `{"workspaceId":"${id}","policy":${JSON.stringify({ ...older, ipAllowlist: null, tokenIpAllowlist: null, sessionMaxHours: null, allowedClients: null, ssoRequired: false, artifactMaxDays: null, artifactMaxDaysFrom: null, commentRetentionDays: null, commentRetentionFrom: null })}}`,
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
    expect(row && { ...row, policy: policyOf(row.policy) }).toEqual({
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
    ).toBe(`Workspace ${slugOf(id)} has no request policy; nothing changed.`);
  });

  it("lifts the sign-in policies too (decision 0021), recorded with their new values", async () => {
    const id = await workspace({
      ...POLICY,
      ipAllowlist: null,
      sessionMaxHours: 8,
      allowedClients: [],
    });
    const cleared = await runOperator(
      db(),
      ["clear-request-policies", slugOf(id), "--confirm", slugOf(id)],
      NOW,
    );
    expect(cleared.output).toContain("Lifted sessionMaxHours and allowedClients");
    const [row] = await db()
      .select({ policy: schema.workspaces.policy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id));
    expect(policyOf(row?.policy)).toMatchObject({ sessionMaxHours: null, allowedClients: null });
    const [event] = await db()
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.ownerId, id));
    expect(event?.detail).toEqual({
      fields: ["sessionMaxHours", "allowedClients"],
      sessionMaxHours: null,
      allowedClients: null,
      confirmed: false,
    });
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

describe("apply-policies after the review (decision 0020)", () => {
  const filesWith = (text: string) => ({ read: async () => text, write: async () => {} });

  it("refuses a file with an invalid range, naming the line, and applies nothing", async () => {
    const first = await workspace(null);
    const second = await workspace(null);
    const text = [
      JSON.stringify({ workspaceId: first, policy: POLICY }),
      JSON.stringify({ workspaceId: second, policy: { ...POLICY, ipAllowlist: ["10.0.0.0/33"] } }),
    ].join("\n");
    const result = await runOperator(
      all(),
      ["apply-policies", "--file", "p"],
      NOW,
      filesWith(text),
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Line 2 of p is not a valid workspace policy");
    expect(result.output).toContain("10.0.0.0/33");
    const rows = await db()
      .select({ policy: schema.workspaces.policy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, first));
    expect(rows[0]?.policy).toBeNull();
  });

  it("reports what an older file would lift and lifts it only with --allow-lifting", async () => {
    const id = await workspace(POLICY);
    const older = JSON.stringify({
      workspaceId: id,
      policy: { ...POLICY, publicAccess: "allowed", ipAllowlist: null },
    });
    const kept = await runOperator(all(), ["apply-policies", "--file", "p"], NOW, filesWith(older));
    expect(kept.exitCode).toBe(0);
    expect(kept.output).toContain("Applied 0 workspace policy(ies)");
    expect(kept.output).toContain(`  ${id}: publicAccess, ipAllowlist`);
    const stored = async () =>
      (
        await db()
          .select({ policy: schema.workspaces.policy })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, id))
      )[0]?.policy;
    expect(await stored()).toEqual(POLICY);
    const lifted = await runOperator(
      all(),
      ["apply-policies", "--file", "p", "--allow-lifting"],
      NOW + 1,
      filesWith(older),
    );
    expect(lifted.output).toContain("Applied 1 workspace policy(ies)");
    expect(policyOf(await stored())).toMatchObject({ publicAccess: "allowed", ipAllowlist: null });
    expect(OPERATOR_USAGE).toContain("--allow-lifting");
  });
});

describe("SSO required in restores (decision 0021)", () => {
  it("leaves a workspace as it is when the file requires single sign-on it cannot run, and says so", async () => {
    const id = await workspace(null);
    const files = {
      read: async () =>
        `${JSON.stringify({ workspaceId: id, policy: { ...POLICY, ssoRequired: true } })}\n`,
      write: async () => {},
    };
    const applied = await runOperator(all(), ["apply-policies", "--file", "p.jsonl"], NOW, files);
    expect(applied.output).toContain(
      "1 workspace(s) were left as they are because the file requires single sign-on",
    );
    expect(applied.output).toContain(`  ${id}`);
    const [row] = await db()
      .select({ policy: schema.workspaces.policy })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id));
    expect(row?.policy ?? null).toBeNull();
  });
});

describe("listing the workspaces that require single sign-on (decision 0021)", () => {
  it("lists only them, for the step before switching single sign-on off", async () => {
    const required = await workspace({ ...POLICY, ssoRequired: true });
    const other = await workspace(POLICY);
    const listed = await runOperator(db(), ["workspaces", "--sso-required"], NOW);
    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain(required);
    expect(listed.output).not.toContain(other);
    expect((await runOperator(db(), ["workspaces"], NOW)).output).toContain(other);
    expect(OPERATOR_USAGE).toContain("workspaces [--sso-required]");
  });
});

describe("re-arming comment retention (decision 0023)", () => {
  it("says the scans stay paused and exits 1 without every region's bucket", async () => {
    const result = await runOperator(db(), ["apply-policies", "--file", "empty"], NOW, {
      read: async () => "",
      write: async () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Comment retention stays paused (no deletion anywhere)");
    expect(result.output).toContain("a region's bucket is not bound in operator.wrangler.jsonc");
  });

  it("re-arms and exits 0 with them", async () => {
    const result = await runOperator(all(), ["apply-policies", "--file", "empty"], NOW, {
      read: async () => "",
      write: async () => {},
    });
    expect(result.output).toContain("Comment retention is armed again");
    expect(result.exitCode).toBe(0);
  });
});
