import { describe, expect, it } from "vitest";
import { ErrorCode } from "./core.ts";
import { ACCESS_LOG, ANNOTATION_LIMITS, LIMITS, TRAFFIC_LIMITS } from "./limits.ts";
import {
  AVAILABLE_PLAN_FEATURES,
  lowestPlanWith,
  PLAN_FEATURE_LABELS,
  PLAN_FEATURES,
  PLAN_LABELS,
  PLAN_NAMES,
  PLAN_PRICES,
  PLAN_REQUEST_EMAIL,
  PLANS,
  type PlanFeature,
  PlanLimits,
  PlanOverrides,
  PlanView,
  planFeatureAvailable,
  planFeatureStatus,
  planRequestHref,
  planRequiredMessage,
} from "./plans.ts";
import { ERROR_STATUS } from "./publishing.ts";

describe("PLANS", () => {
  it("keeps free on today's constants", () => {
    expect(PLANS.free.limits).toEqual({
      activeArtifacts: LIMITS.activeArtifacts,
      artifactBytes: LIMITS.artifactBytes,
      accountBytes: LIMITS.accountBytes,
      requestsPerMonth: TRAFFIC_LIMITS.requestsPerMonth,
      bytesPerMonth: TRAFFIC_LIMITS.bytesPerMonth,
      annotationMessages: ANNOTATION_LIMITS.messagesPerOwner,
      annotationBytes: ANNOTATION_LIMITS.bytesPerOwner,
      archiveMonths: LIMITS.archiveMonths,
      retainedPreviousVersions: LIMITS.retainedPreviousVersions,
      previousVersionRetentionDays: LIMITS.previousVersionRetentionDays,
      accessLogRetentionDays: ACCESS_LOG.retentionDays,
      customDomains: 0,
    });
  });

  it("validates every plan's limits and lists features in PLAN_FEATURES order", () => {
    for (const plan of Object.values(PLANS)) {
      expect(PlanLimits.parse(plan.limits)).toEqual(plan.limits);
      expect([...plan.features]).toEqual(PLAN_FEATURES.filter((f) => plan.features.includes(f)));
    }
    expect(PLANS.pro.perSeat).toEqual([]);
  });

  it("keeps every plan's per-artifact size within the boundaries' file cap", () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.limits.artifactBytes).toBeLessThanOrEqual(LIMITS.fileBytesCap);
    }
    expect(
      PlanOverrides.safeParse({ limits: { artifactBytes: LIMITS.fileBytesCap } }).success,
    ).toBe(true);
    expect(
      PlanOverrides.safeParse({ limits: { artifactBytes: LIMITS.fileBytesCap + 1 } }).success,
    ).toBe(false);
    expect(PLANS.team.perSeat).toEqual(PLANS.enterprise.perSeat);
  });
});

describe("PlanOverrides", () => {
  it("accepts partial limits and feature switches", () => {
    expect(
      PlanOverrides.safeParse({ limits: { activeArtifacts: 10 }, features: { sso: false } })
        .success,
    ).toBe(true);
    expect(PlanOverrides.safeParse({}).success).toBe(true);
  });

  it.each([
    { limits: { unknown: 1 } },
    { limits: { activeArtifacts: -1 } },
    { features: { teleport: true } },
    { features: { sso: 1 } },
    { extra: true },
  ])("refuses %j", (value) => {
    expect(PlanOverrides.safeParse(value).success).toBe(false);
  });
});

describe("PlanView", () => {
  it("needs at least one seat and an ISO end or null", () => {
    const view = {
      name: "pro",
      validUntil: null,
      seats: 1,
      limits: PLANS.pro.limits,
      features: [...PLANS.pro.features],
    };
    expect(PlanView.safeParse(view).success).toBe(true);
    expect(PlanView.safeParse({ ...view, seats: 0 }).success).toBe(false);
    expect(PlanView.safeParse({ ...view, validUntil: "soon" }).success).toBe(false);
    expect(PlanView.safeParse({ ...view, name: "gold" }).success).toBe(false);
  });
});

describe("plan_required", () => {
  it("is a documented error code answered with 403", () => {
    expect(ErrorCode.safeParse("plan_required").success).toBe(true);
    expect(ERROR_STATUS.plan_required).toBe(403);
  });

  it("names every plan for people", () => {
    expect(PLAN_LABELS).toEqual({
      free: "Free",
      pro: "Pro",
      team: "Team",
      enterprise: "Enterprise",
    });
  });

  it("keeps enterprise granting every feature, so each one has a lowest plan", () => {
    expect([...PLANS.enterprise.features]).toEqual([...PLAN_FEATURES]);
    expect(Object.keys(PLAN_FEATURE_LABELS).sort()).toEqual([...PLAN_FEATURES].sort());
  });

  it("derives the lowest plan with each feature from PLANS", () => {
    for (const feature of PLAN_FEATURES) {
      const lowest = lowestPlanWith(feature);
      expect(PLANS[lowest].features).toContain(feature);
      for (const cheaper of PLAN_NAMES.slice(0, PLAN_NAMES.indexOf(lowest))) {
        expect(PLANS[cheaper].features).not.toContain(feature);
      }
    }
  });

  it("names the feature in plain words and the plan that includes it", () => {
    expect(Object.fromEntries(PLAN_FEATURES.map((f) => [f, planRequiredMessage(f)]))).toEqual({
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
    });
  });
});

describe("plan offers", () => {
  it("lists the features available today, in PLAN_FEATURES order", () => {
    expect([...AVAILABLE_PLAN_FEATURES]).toEqual([
      "pin",
      "versionDiff",
      "shareLinks",
      "commentNotices",
      "analytics",
      "branding",
      "workspaces",
    ]);
    expect([...AVAILABLE_PLAN_FEATURES]).toEqual(
      PLAN_FEATURES.filter((feature) => planFeatureAvailable(feature)),
    );
  });

  it("keeps webhooks, custom domains and every later feature coming soon", () => {
    for (const feature of ["webhooks", "customDomains", "serviceTokens", "sso", "euResidency"]) {
      expect(planFeatureAvailable(feature as PlanFeature), feature).toBe(false);
    }
  });

  it("splits each plan's features into available and coming soon", () => {
    expect(planFeatureStatus("free")).toEqual({ available: [], comingSoon: [] });
    expect(planFeatureStatus("pro")).toEqual({
      available: ["pin", "versionDiff", "shareLinks", "commentNotices", "analytics", "branding"],
      comingSoon: ["webhooks", "customDomains"],
    });
    expect(planFeatureStatus("team").available).toContain("workspaces");
    for (const plan of PLAN_NAMES) {
      const { available, comingSoon } = planFeatureStatus(plan);
      expect([...available, ...comingSoon].sort()).toEqual([...PLANS[plan].features].sort());
    }
  });

  it("prices each plan in US dollars, Team per seat and Enterprise by contract", () => {
    expect(PLAN_PRICES).toEqual({
      free: { usdPerMonth: 0, perSeat: false },
      pro: { usdPerMonth: 2, perSeat: false },
      team: { usdPerMonth: 5, perSeat: true },
      enterprise: { usdPerMonth: null, perSeat: false },
    });
    expect(Object.keys(PLAN_PRICES)).toEqual([...PLAN_NAMES]);
  });

  it("requests a plan by email with a subject naming it", () => {
    expect(planRequestHref("pro")).toBe(
      "mailto:hello@portifact.com?subject=Portifact%20Pro%20plan%20request",
    );
    expect(planRequestHref("enterprise")).toContain("Enterprise");
    expect(PLAN_REQUEST_EMAIL).toBe("hello@portifact.com");
  });
});
