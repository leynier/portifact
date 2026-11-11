import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  WORKSPACE_POLICIES,
  WorkspacePolicy,
  WorkspacePolicyExport,
  WorkspacePolicyUpdate,
} from "./policies.ts";

describe("workspace policy contracts", () => {
  it("accepts the defaults and every bound, and nothing past them", () => {
    expect(WorkspacePolicy.parse(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    const widest = {
      publicAccess: "forbidden",
      defaultAccess: "domain",
      readerDomains: Array.from(
        { length: WORKSPACE_POLICIES.readerDomains },
        (_, i) => `d${i}.example`,
      ),
      shareLinks: "password_required",
      shareLinkMaxDays: WORKSPACE_POLICIES.shareLinkMaxDays,
    };
    expect(WorkspacePolicy.safeParse(widest).success).toBe(true);
    for (const bad of [
      { ...widest, defaultAccess: "public" },
      { ...widest, readerDomains: [] },
      { ...widest, readerDomains: [...widest.readerDomains, "one.more"] },
      { ...widest, shareLinkMaxDays: 0 },
      { ...widest, shareLinkMaxDays: WORKSPACE_POLICIES.shareLinkMaxDays + 1 },
      { ...widest, shareLinks: "sometimes" },
      { ...widest, extra: true },
    ]) {
      expect(WorkspacePolicy.safeParse(bad).success).toBe(false);
    }
  });

  it("bounds the sign-in policies and reads a policy stored before them as unset (0021)", () => {
    const stored = { ...DEFAULT_POLICY } as Record<string, unknown>;
    delete stored.sessionMaxHours;
    delete stored.allowedClients;
    expect(WorkspacePolicy.parse(stored)).toEqual(DEFAULT_POLICY);
    for (const good of [
      { sessionMaxHours: WORKSPACE_POLICIES.sessionMinHours },
      { sessionMaxHours: WORKSPACE_POLICIES.sessionMaxHours },
      { allowedClients: [] },
      { allowedClients: ["cli", "oauth_apps"] },
    ]) {
      expect(WorkspacePolicy.safeParse({ ...DEFAULT_POLICY, ...good }).success).toBe(true);
    }
    for (const bad of [
      { sessionMaxHours: 0 },
      { sessionMaxHours: WORKSPACE_POLICIES.sessionMaxHours + 1 },
      { sessionMaxHours: 1.5 },
      { allowedClients: ["dashboard"] },
      { allowedClients: ["cli", "oauth_apps", "cli"] },
    ]) {
      expect(WorkspacePolicy.safeParse({ ...DEFAULT_POLICY, ...bad }).success).toBe(false);
    }
  });

  it("takes a revision and an optional confirmation on a save, and a workspace ID on an export", () => {
    expect(WorkspacePolicyUpdate.parse({ policy: DEFAULT_POLICY, revision: 0 })).toEqual({
      policy: DEFAULT_POLICY,
      revision: 0,
    });
    expect(WorkspacePolicyUpdate.safeParse({ policy: DEFAULT_POLICY, revision: -1 }).success).toBe(
      false,
    );
    expect(
      WorkspacePolicyExport.safeParse({ workspaceId: "u_1", policy: DEFAULT_POLICY }).success,
    ).toBe(false);
  });
});
