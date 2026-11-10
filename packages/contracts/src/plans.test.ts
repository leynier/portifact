import { describe, expect, it } from "vitest";
import { ACCESS_LOG, ANNOTATION_LIMITS, LIMITS, TRAFFIC_LIMITS } from "./limits.ts";
import { PLAN_FEATURES, PLANS, PlanLimits, PlanOverrides, PlanView } from "./plans.ts";

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
