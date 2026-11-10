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
