import {
  PLAN_FEATURES,
  PLAN_NAMES,
  PLANS,
  type PlanFeature,
  type PlanLimits,
  type PlanName,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { checkAnnotationWrite } from "./annotations.ts";
import { checkRestore } from "./lifecycle.ts";
import {
  alignedLimit,
  type Entitlements,
  entitlements,
  FREE_LIMIT_COLUMNS,
  formatCount,
  formatSize,
  hasFeature,
  limitColumns,
  type OwnerPlanRecord,
  planActive,
  requireFeature,
} from "./plans.ts";
import { checkPublish } from "./quotas.ts";
import { trafficExhausted } from "./traffic.ts";
import { type UsageSnapshot, usageBlocks } from "./usage.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const row = (overrides: Partial<OwnerPlanRecord> = {}): OwnerPlanRecord => ({
  plan: "pro",
  seats: 1,
  validUntil: null,
  overrides: null,
  ...overrides,
});

const FREE: PlanLimits = {
  activeArtifacts: 50,
  artifactBytes: 250_000_000,
  accountBytes: 2_500_000_000,
  requestsPerMonth: 1_000_000,
  bytesPerMonth: 25_000_000_000,
  annotationMessages: 5_000,
  annotationBytes: 50_000_000,
  archiveMonths: 6,
  retainedPreviousVersions: 2,
  previousVersionRetentionDays: 7,
  accessLogRetentionDays: 30,
  customDomains: 0,
};
const PRO: PlanLimits = {
  activeArtifacts: 500,
  artifactBytes: 2_000_000_000,
  accountBytes: 25_000_000_000,
  requestsPerMonth: 2_000_000,
  bytesPerMonth: 250_000_000_000,
  annotationMessages: 25_000,
  annotationBytes: 100_000_000,
  archiveMonths: 12,
  retainedPreviousVersions: 50,
  previousVersionRetentionDays: 90,
  accessLogRetentionDays: 365,
  customDomains: 1,
};
const TEAM: PlanLimits = {
  activeArtifacts: 2_000,
  artifactBytes: 2_000_000_000,
  accountBytes: 30_000_000_000,
  requestsPerMonth: 3_000_000,
  bytesPerMonth: 1_000_000_000_000,
  annotationMessages: 25_000,
  annotationBytes: 100_000_000,
  archiveMonths: 12,
  retainedPreviousVersions: 100,
  previousVersionRetentionDays: 365,
  accessLogRetentionDays: 365,
  customDomains: 5,
};
const PRO_FEATURES = [
  "pin",
  "versionDiff",
  "shareLinks",
  "commentNotices",
  "webhooks",
  "customDomains",
  "analytics",
  "branding",
];
const TEAM_FEATURES = [
  ...PRO_FEATURES,
  "workspaces",
  "serviceTokens",
  "reviews",
  "integrations",
  "contentSearch",
  "audit",
];

describe("PLANS", () => {
  it.each([
    ["free", FREE, []],
    ["pro", PRO, PRO_FEATURES],
    ["team", TEAM, TEAM_FEATURES],
    ["enterprise", TEAM, [...PLAN_FEATURES]],
  ] as const)("%s has its limits and features", (plan, limits, features) => {
    expect(PLANS[plan].limits).toEqual(limits);
    expect(PLANS[plan].features).toEqual(features);
  });

  it("gives enterprise every feature, team's on top of pro's", () => {
    expect(PLANS.enterprise.features).toEqual([
      ...TEAM_FEATURES,
      "sso",
      "scim",
      "auditExport",
      "policies",
      "euResidency",
    ]);
  });
});

describe("entitlements", () => {
  it("reads no row as free with today's limits", () => {
    expect(entitlements(null, NOW)).toEqual({
      plan: "free",
      seats: 1,
      validUntil: null,
      limits: FREE,
      features: [],
    });
  });

  it.each([
    ["pro", PRO, PRO_FEATURES],
    ["team", TEAM, TEAM_FEATURES],
    ["enterprise", TEAM, [...PLAN_FEATURES]],
  ] as const)("grants %s its limits and features", (plan, limits, features) => {
    expect(entitlements(row({ plan }), NOW)).toEqual({
      plan,
      seats: 1,
      validUntil: null,
      limits,
      features,
    });
  });

  it("multiplies the per-seat team values and pools them", () => {
    const team = entitlements(row({ plan: "team", seats: 4 }), NOW);
    expect(team.seats).toBe(4);
    expect(team.limits).toEqual({
      ...TEAM,
      accountBytes: 120_000_000_000,
      requestsPerMonth: 12_000_000,
      annotationMessages: 100_000,
      annotationBytes: 400_000_000,
    });
    expect(entitlements(row({ plan: "enterprise", seats: 2 }), NOW).limits.accountBytes).toBe(
      60_000_000_000,
    );
  });

  it("ignores seats on plans without per-seat values", () => {
    const pro = entitlements(row({ seats: 3 }), NOW);
    expect(pro.limits).toEqual(PRO);
    expect(pro.seats).toBe(3);
  });

  it.each([0, -2, 1.5, Number.NaN])("treats %s seats as one", (seats) => {
    const team = entitlements(row({ plan: "team", seats }), NOW);
    expect(team.seats).toBe(1);
    expect(team.limits).toEqual(TEAM);
  });

  it("keeps the plan until valid_until and reads it as free from then on", () => {
    const until = NOW + 1;
    expect(entitlements(row({ validUntil: until }), NOW)).toMatchObject({
      plan: "pro",
      validUntil: until,
      limits: PRO,
    });
    expect(entitlements(row({ validUntil: NOW }), NOW)).toEqual(entitlements(null, NOW));
    expect(entitlements(row({ validUntil: NOW - 1 }), NOW)).toEqual(entitlements(null, NOW));
    expect(planActive(row({ validUntil: NOW + 1 }), NOW)).toBe(true);
    expect(planActive(row({ validUntil: NOW }), NOW)).toBe(false);
    expect(planActive(row(), NOW)).toBe(true);
  });

  it("reads an unknown plan name as free", () => {
    expect(entitlements(row({ plan: "platinum" }), NOW)).toEqual(entitlements(null, NOW));
  });

  it("applies overrides after seats, as totals", () => {
    const owner = entitlements(
      row({
        plan: "enterprise",
        seats: 10,
        overrides: {
          limits: { activeArtifacts: 10_000, accountBytes: 1_000_000_000_000 },
          features: { euResidency: false, pin: true },
        },
      }),
      NOW,
    );
    expect(owner.limits).toEqual({
      ...TEAM,
      activeArtifacts: 10_000,
      accountBytes: 1_000_000_000_000,
      requestsPerMonth: 30_000_000,
      annotationMessages: 250_000,
      annotationBytes: 1_000_000_000,
    });
    expect(owner.features).toEqual(PLAN_FEATURES.filter((feature) => feature !== "euResidency"));
  });

  it("adds features in the order of PLAN_FEATURES", () => {
    const owner = entitlements(row({ overrides: { features: { sso: true, audit: true } } }), NOW);
    expect(owner.features).toEqual([...PRO_FEATURES, "audit", "sso"]);
    expect(hasFeature(owner, "sso")).toBe(true);
    expect(hasFeature(owner, "scim")).toBe(false);
  });

  it.each([
    ["an unknown limit", { limits: { seats: 9 } }],
    ["a negative limit", { limits: { activeArtifacts: -1 } }],
    ["a fractional limit", { limits: { activeArtifacts: 1.5 } }],
    ["an unknown feature", { features: { teleport: true } }],
    ["a non-boolean feature", { features: { sso: "yes" } }],
    ["an unknown key", { limits: {}, extra: 1 }],
    ["a string", "everything"],
    ["an array", [1]],
  ])("ignores overrides with %s and keeps the plan", (_, overrides) => {
    expect(entitlements(row({ overrides }), NOW)).toEqual(entitlements(row(), NOW));
  });

  it("never shares state between owners", () => {
    const first = entitlements(null, NOW);
    first.limits.activeArtifacts = 9;
    first.features.push("sso");
    expect(entitlements(null, NOW).limits.activeArtifacts).toBe(50);
    expect(entitlements(null, NOW).features).toEqual([]);
    expect(PLANS.free.limits.activeArtifacts).toBe(50);
  });
});

describe("formatSize and formatCount", () => {
  it.each([
    [250_000_000, "250 MB"],
    [2_500_000_000, "2.5 GB"],
    [2_000_000_000, "2 GB"],
    [25_000_000_000, "25 GB"],
    [1_000_000_000_000, "1 TB"],
    [1_250_000_000_000, "1.3 TB"],
    [999_999, "999999 bytes"],
    [1_000_000, "1 MB"],
    [999_000_000, "999 MB"],
  ])("formats %s bytes as %s", (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });

  it.each([
    [1_000_000, "1 million"],
    [12_000_000, "12 million"],
    [1_500_000, "1,500,000"],
    [25_000, "25,000"],
    [999_999, "999,999"],
  ])("formats %s as %s", (value, text) => {
    expect(formatCount(value)).toBe(text);
  });
});

describe("plan limits in the rules", () => {
  const pro: Entitlements = entitlements(row(), NOW);
  const fresh = {
    activeArtifacts: 0,
    storedBytes: 0,
    publishesLast24h: 0,
    openUploads: 0,
    newFilesLast24h: 0,
    newBytesLast24h: 0,
    newObjectsThisMonth: 0,
  };
  const request = { createsArtifact: true, versionBytes: 1, files: 1, newBytes: 1, newFiles: 1 };

  it("lets pro publish past free's active, version and storage limits", () => {
    const usage = { ...fresh, activeArtifacts: 50, storedBytes: 2_500_000_000 };
    const big = { ...request, versionBytes: 1_000_000_000 };
    expect(checkPublish(usage, big, FREE)).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(checkPublish(usage, big, pro.limits).ok).toBe(true);
    expect(checkPublish({ ...usage, activeArtifacts: 500 }, request, pro.limits)).toEqual({
      ok: false,
      code: "quota_exceeded",
      message: "You already have 500 active artifacts.",
    });
    expect(
      checkPublish(fresh, { ...request, versionBytes: 2_000_000_001 }, pro.limits),
    ).toMatchObject({ message: "An artifact version can be at most 2 GB." });
    expect(
      checkPublish({ ...fresh, storedBytes: 25_000_000_000 }, request, pro.limits),
    ).toMatchObject({ message: "This would exceed your 25 GB of storage." });
  });

  it("keeps free's messages exactly as before plans", () => {
    expect(checkPublish(fresh, { ...request, versionBytes: 250_000_001 }, FREE)).toMatchObject({
      message: "An artifact version can be at most 250 MB.",
    });
    expect(checkPublish({ ...fresh, storedBytes: 2_500_000_000 }, request, FREE)).toMatchObject({
      message: "This would exceed your 2.5 GB of storage.",
    });
  });

  it("follows the plan's traffic quota", () => {
    const used = { requests: 1_000_000, bytes: 25_000_000_000 };
    expect(trafficExhausted(used, FREE)).toBe(true);
    expect(trafficExhausted(used, pro.limits)).toBe(false);
    expect(trafficExhausted({ requests: 2_000_000, bytes: 0 }, pro.limits)).toBe(true);
    expect(trafficExhausted({ requests: 0, bytes: 250_000_000_000 }, pro.limits)).toBe(true);
  });

  it("follows the plan's annotation quota per owner", () => {
    const idle = {
      authorWritesLastMinute: 0,
      authorWritesLast24h: 0,
      artifactWritesLast24h: 0,
      artifactThreads: 0,
      threadMessages: 0,
      ownerMessages: 5_000,
      ownerBytes: 0,
    };
    const write = { kind: "reply", addedBytes: 10 } as const;
    expect(checkAnnotationWrite(idle, write, FREE).ok).toBe(false);
    expect(checkAnnotationWrite(idle, write, pro.limits).ok).toBe(true);
    expect(checkAnnotationWrite({ ...idle, ownerMessages: 25_000 }, write, pro.limits).ok).toBe(
      false,
    );
    expect(
      checkAnnotationWrite({ ...idle, ownerBytes: 100_000_000 - 10 }, write, pro.limits).ok,
    ).toBe(true);
    expect(
      checkAnnotationWrite({ ...idle, ownerBytes: 100_000_000 - 9 }, write, pro.limits).ok,
    ).toBe(false);
  });

  it("restores with the plan's active slots", () => {
    const archived = {
      state: "archived" as const,
      expiresAt: new Date(NOW - 1_000),
      archivedAt: new Date(NOW - 1_000),
    };
    expect(checkRestore(archived, new Date(NOW), 50, FREE).ok).toBe(false);
    expect(checkRestore(archived, new Date(NOW), 50, pro.limits).ok).toBe(true);
    expect(checkRestore(archived, new Date(NOW), 500, pro.limits)).toMatchObject({
      message: "You already have 500 active artifacts.",
    });
  });

  it("shows the plan's limits in the usage blocks", () => {
    const snapshot: UsageSnapshot = {
      now: NOW,
      accountCreatedAt: NOW - 86_400_000,
      activeArtifacts: 500,
      storedBytes: 25_000_000_000,
      reservedBytes: 0,
      openUploads: 0,
      firstUploadExpiry: null,
      newObjectsThisMonth: 0,
      publishes: [],
      newFiles: [],
      newBytes: [],
      traffic: { requests: 2_000_000, bytes: 0 },
    };
    const messages = usageBlocks(snapshot, pro.limits).map((block) => block.message);
    expect(messages).toEqual([
      "You have 500 active artifacts. Archive or delete one to create another; updates still work.",
      "Your 25 GB of storage is full. Delete artifacts or wait for previous versions to expire to upload new files.",
      "Your artifacts served this month's traffic (2 million requests or 250 GB). They answer 429 until the next month; publishing still works.",
    ]);
    expect(
      usageBlocks(
        { ...snapshot, activeArtifacts: 499, storedBytes: 0, traffic: { requests: 0, bytes: 0 } },
        pro.limits,
      ),
    ).toEqual([]);
  });
});

describe("limit columns", () => {
  it("maps the entitlements to the database's four limit columns", () => {
    const team = entitlements({ plan: "team", seats: 2, validUntil: null, overrides: null }, 0);
    expect(limitColumns(team)).toEqual({
      activeLimit: 2_000,
      bytesLimit: 60_000_000_000,
      messagesLimit: 50_000,
      annotationBytesLimit: 200_000_000,
    });
  });

  it("keeps the free columns equal to the database defaults", () => {
    expect(FREE_LIMIT_COLUMNS).toEqual({
      activeLimit: 50,
      bytesLimit: 2_500_000_000,
      messagesLimit: 5_000,
      annotationBytesLimit: 50_000_000,
    });
  });

  it("never aligns a column below usage", () => {
    expect(alignedLimit(50, 10)).toBe(50);
    expect(alignedLimit(50, 50)).toBe(50);
    expect(alignedLimit(50, 70)).toBe(70);
  });
});

describe("requireFeature", () => {
  // Written out rather than read from PLANS, so moving a feature between plans is a visible change.
  const PRO: PlanFeature[] = [
    "pin",
    "versionDiff",
    "shareLinks",
    "commentNotices",
    "webhooks",
    "customDomains",
    "analytics",
    "branding",
  ];
  const TEAM: PlanFeature[] = [
    ...PRO,
    "workspaces",
    "serviceTokens",
    "reviews",
    "integrations",
    "contentSearch",
    "audit",
  ];
  const INCLUDED: Record<PlanName, readonly PlanFeature[]> = {
    free: [],
    pro: PRO,
    team: TEAM,
    enterprise: PLAN_FEATURES,
  };
  const LOWEST: Record<PlanFeature, string> = {
    pin: "Pinning artifacts is part of the Pro plan.",
    versionDiff: "Comparing versions is part of the Pro plan.",
    shareLinks: "Sharing with links is part of the Pro plan.",
    commentNotices: "Getting comment notices by email is part of the Pro plan.",
    webhooks: "Sending webhooks is part of the Pro plan.",
    customDomains: "Using a custom domain is part of the Pro plan.",
    analytics: "Seeing artifact analytics is part of the Pro plan.",
    branding: "Branding the Portifact bar is part of the Pro plan.",
    workspaces: "Using workspaces is part of the Team plan.",
    serviceTokens: "Using service tokens is part of the Team plan.",
    reviews: "Requesting reviews is part of the Team plan.",
    integrations: "Connecting integrations is part of the Team plan.",
    contentSearch: "Searching artifact contents is part of the Team plan.",
    audit: "Reading the audit log is part of the Team plan.",
    sso: "Signing in with SSO is part of the Enterprise plan.",
    scim: "Provisioning members with SCIM is part of the Enterprise plan.",
    auditExport: "Exporting the audit log is part of the Enterprise plan.",
    policies: "Setting workspace policies is part of the Enterprise plan.",
    euResidency: "Keeping data in the EU is part of the Enterprise plan.",
  };

  for (const plan of PLAN_NAMES) {
    for (const feature of PLAN_FEATURES) {
      const included = INCLUDED[plan].includes(feature);
      it(`${included ? "allows" : "refuses"} ${feature} on ${plan}`, () => {
        const owner = plan === "free" ? entitlements(null, NOW) : entitlements(row({ plan }), NOW);
        expect(requireFeature(owner, feature)).toEqual(
          included
            ? { ok: true, value: owner }
            : { ok: false, code: "plan_required", message: LOWEST[feature] },
        );
      });
    }
  }

  it("refuses every feature once the plan expired", () => {
    const expired = entitlements(row({ plan: "enterprise", validUntil: NOW }), NOW);
    for (const feature of PLAN_FEATURES) {
      expect(requireFeature(expired, feature)).toEqual({
        ok: false,
        code: "plan_required",
        message: LOWEST[feature],
      });
    }
    const current = entitlements(row({ plan: "enterprise", validUntil: NOW + 1 }), NOW);
    expect(requireFeature(current, "sso").ok).toBe(true);
  });

  it("follows overrides that turn a feature on or off", () => {
    const on = entitlements(row({ plan: "pro", overrides: { features: { sso: true } } }), NOW);
    expect(requireFeature(on, "sso")).toEqual({ ok: true, value: on });
    const off = entitlements(row({ plan: "pro", overrides: { features: { pin: false } } }), NOW);
    expect(requireFeature(off, "pin")).toEqual({
      ok: false,
      code: "plan_required",
      message: "Pinning artifacts is part of the Pro plan.",
    });
    expect(requireFeature(off, "versionDiff").ok).toBe(true);
  });

  it("matches PLANS, so the written table above stays in line with the configuration", () => {
    for (const plan of PLAN_NAMES) expect([...PLANS[plan].features]).toEqual([...INCLUDED[plan]]);
  });
});
