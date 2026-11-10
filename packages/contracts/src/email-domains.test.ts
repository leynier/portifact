import { describe, expect, it } from "vitest";
import {
  AccessMode,
  isWorkspaceAccessMode,
  PersonalAccessMode,
  WORKSPACE_ACCESS_MODES,
} from "./core.ts";
import {
  AccessAudience,
  WORKSPACE_DOMAINS,
  WorkspaceDomainCreate,
  WorkspaceDomainId,
  WorkspaceDomainList,
  WorkspaceDomainProblem,
  WorkspaceDomainView,
} from "./email-domains.ts";
import { TombstoneMarker } from "./jobs.ts";

const ID = `wd_${"0123456789abcdef".repeat(2)}`;
const VIEW = {
  id: ID,
  domain: "acme.com",
  unicode: null,
  state: "pending",
  record: { name: "_portifact-email.acme.com", value: "portifact-email-verify=abc" },
  createdAt: "2026-11-10T12:00:00.000Z",
  verifiedAt: null,
  checkedAt: null,
  expiresAt: "2026-11-17T12:00:00.000Z",
  failedChecks: 0,
  problem: null,
};

describe("access modes", () => {
  it("has the workspace modes only beside the three personal ones", () => {
    expect(AccessMode.options).toEqual([
      "public",
      "authenticated",
      "restricted",
      "workspace",
      "domain",
    ]);
    expect(PersonalAccessMode.options).toEqual(["public", "authenticated", "restricted"]);
    expect(WORKSPACE_ACCESS_MODES).toEqual(["workspace", "domain"]);
    expect(AccessMode.options.filter(isWorkspaceAccessMode)).toEqual(["workspace", "domain"]);
  });
});

describe("workspace email domains", () => {
  it("keeps the documented limits and record shape", () => {
    expect(WORKSPACE_DOMAINS).toEqual({
      perWorkspace: 10,
      claimTtlDays: 7,
      recheckHours: 24,
      maxFailedChecks: 3,
      recheckBatch: 50,
      recordLabel: "_portifact-email",
      recordPrefix: "portifact-email-verify=",
    });
  });

  it("validates domain IDs exactly", () => {
    expect(WorkspaceDomainId.parse(ID)).toBe(ID);
    for (const bad of [
      `x${ID}`,
      `${ID}0`,
      `wd_${"0".repeat(31)}`,
      `wd_${"g".repeat(32)}`,
      `ws_${"0".repeat(32)}`,
    ]) {
      const parsed = WorkspaceDomainId.safeParse(bad);
      expect(parsed.success, bad).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("Invalid domain id");
    }
  });

  it("takes a trimmed, bounded domain and nothing else", () => {
    expect(WorkspaceDomainCreate.parse({ domain: "  acme.com " })).toEqual({ domain: "acme.com" });
    expect(WorkspaceDomainCreate.parse({ domain: "a" })).toEqual({ domain: "a" });
    expect(WorkspaceDomainCreate.parse({ domain: "a".repeat(300) }).domain).toHaveLength(300);
    for (const bad of [{ domain: "   " }, { domain: "a".repeat(301) }, {}, { domain: "a", x: 1 }]) {
      expect(WorkspaceDomainCreate.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("describes a domain with its record, state and checks", () => {
    expect(WorkspaceDomainView.parse(VIEW)).toEqual(VIEW);
    const verified = {
      ...VIEW,
      state: "verified",
      verifiedAt: VIEW.createdAt,
      checkedAt: VIEW.createdAt,
      expiresAt: null,
      failedChecks: 2,
      problem: "txt_missing",
      unicode: "bücher.com",
    };
    expect(WorkspaceDomainView.parse(verified)).toEqual(verified);
    for (const bad of [
      { ...VIEW, state: "lost" },
      { ...VIEW, state: "" },
      { ...VIEW, record: {} },
      { ...VIEW, record: { name: "x" } },
      { ...VIEW, failedChecks: -1 },
      { ...VIEW, failedChecks: 1.5 },
      { ...VIEW, problem: "other" },
      { ...VIEW, createdAt: "yesterday" },
    ]) {
      expect(WorkspaceDomainView.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(WorkspaceDomainProblem.options).toEqual(["txt_missing"]);
  });

  it("lists domains with the plan's availability and the cap", () => {
    const list = { items: [VIEW], available: false, limit: 10 };
    expect(WorkspaceDomainList.parse(list)).toEqual(list);
    expect(WorkspaceDomainList.safeParse({ ...list, limit: 0 }).success).toBe(false);
    expect(WorkspaceDomainList.safeParse({ ...list, available: "yes" }).success).toBe(false);
  });

  it("says who the workspace modes reach", () => {
    const audience = { members: 0, domains: ["acme.com"], featureAvailable: true };
    expect(AccessAudience.parse(audience)).toEqual(audience);
    expect(AccessAudience.safeParse({ ...audience, members: -1 }).success).toBe(false);
    expect(AccessAudience.safeParse({ ...audience, members: 1.5 }).success).toBe(false);
    expect(AccessAudience.safeParse({ ...audience, domains: [1] }).success).toBe(false);
    expect(AccessAudience.safeParse({ ...audience, featureAvailable: 1 }).success).toBe(false);
  });

  it("tombstones a removed domain by its row", () => {
    const marker = { kind: "workspace_domain", id: ID, deletedAt: 1 };
    expect(TombstoneMarker.parse(marker)).toEqual(marker);
  });
});
