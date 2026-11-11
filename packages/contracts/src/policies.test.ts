import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  PolicyPreview,
  WORKSPACE_POLICIES,
  WorkspacePolicy,
  WorkspacePolicyExport,
  WorkspacePolicyUpdate,
  WorkspacePolicyView,
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

describe("SSO required contracts (decision 0021)", () => {
  it("reads a policy stored before it as not required, and takes only a boolean", () => {
    const stored = { ...DEFAULT_POLICY } as Record<string, unknown>;
    delete stored.ssoRequired;
    expect(WorkspacePolicy.parse(stored).ssoRequired).toBe(false);
    expect(WorkspacePolicy.safeParse({ ...DEFAULT_POLICY, ssoRequired: "true" }).success).toBe(
      false,
    );
  });

  it("takes the confirmed count of members the provider cannot serve, never a negative one", () => {
    const base = { policy: { ...DEFAULT_POLICY, ssoRequired: true }, revision: 1 };
    expect(WorkspacePolicyUpdate.parse({ ...base, confirmedOutsideProvider: 2 })).toMatchObject({
      confirmedOutsideProvider: 2,
    });
    expect(WorkspacePolicyUpdate.safeParse({ ...base, confirmedOutsideProvider: -1 }).success).toBe(
      false,
    );
  });

  it("previews and views without the SSO parts from an older server", () => {
    const preview = PolicyPreview.parse({
      publicArtifacts: 0,
      readersOutside: 0,
      linksRevoked: 0,
      linksWithoutPassword: 0,
      linksOverLifetime: 0,
      networks: null,
    });
    expect(preview.sso).toBeNull();
    const view = WorkspacePolicyView.parse({
      policy: DEFAULT_POLICY,
      revision: 0,
      enabled: true,
      editable: true,
      domainVerified: true,
      yourIp: null,
      serviceTokens: null,
    });
    expect(view.sso).toBeNull();
    expect(
      WorkspacePolicyView.parse({ ...view, sso: { usable: true, yourSession: false } }).sso,
    ).toEqual({ usable: true, yourSession: false, offered: true });
  });
});
