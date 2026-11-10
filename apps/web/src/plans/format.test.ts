import { compileMessage } from "@lingui/message-utils/compileMessage";
import { LOCALE_CODES } from "@portifact/contracts/locales";
import { PLAN_FEATURE_LABELS, PLANS } from "@portifact/contracts/plans";
import { describe, expect, it } from "vitest";
import {
  fill,
  formatPlanBytes,
  formatPlanDays,
  formatPlanLimit,
  formatPlanPrice,
  PLAN_LIMIT_ROWS,
  planComparison,
  planRequest,
  planSummary,
} from "./format.ts";
import { PLAN_TEXT } from "./i18n/catalogs.ts";
import { planTextEn } from "./i18n/en.ts";

const en = planTextEn;

describe("fill", () => {
  it("replaces known arguments and keeps unknown ones", () => {
    expect(fill("{a} and {b}", { a: "x" })).toBe("x and {b}");
  });
});

describe("formatPlanBytes", () => {
  it("uses decimal units up to terabytes", () => {
    expect(formatPlanBytes(250_000_000, "en")).toBe("250 MB");
    expect(formatPlanBytes(2_500_000_000, "en")).toBe("2.5 GB");
    expect(formatPlanBytes(1_000_000_000_000, "en")).toBe("1 TB");
    expect(formatPlanBytes(1_500, "en")).toBe("1.5 kB");
    expect(formatPlanBytes(12, "en")).toBe("12 bytes");
  });

  it("formats with the page's language", () => {
    // Some languages put a no-break space before the unit.
    const plain = (value: string) => value.replace(/\s/g, " ");
    expect(plain(formatPlanBytes(2_500_000_000, "es"))).toBe("2,5 GB");
    expect(plain(formatPlanBytes(2_500_000_000, "de"))).toBe("2,5 GB");
  });
});

describe("formatPlanDays", () => {
  it("shows whole years as years and the rest as days", () => {
    expect(formatPlanDays(365, "en")).toBe("1 year");
    expect(formatPlanDays(730, "en")).toBe("2 years");
    expect(formatPlanDays(30, "en")).toBe("30 days");
    expect(formatPlanDays(0, "en")).toBe("0 days");
    expect(formatPlanDays(30, "es")).toBe("30 días");
  });
});

describe("formatPlanLimit", () => {
  it("formats each kind of limit", () => {
    const { limits } = PLANS.pro;
    expect(formatPlanLimit("activeArtifacts", limits, [], "en", en)).toBe("500");
    expect(formatPlanLimit("requestsPerMonth", limits, [], "en", en)).toBe("2,000,000");
    expect(formatPlanLimit("bytesPerMonth", limits, [], "en", en)).toBe("250 GB");
    expect(formatPlanLimit("archiveMonths", limits, [], "en", en)).toBe("12 months");
    expect(formatPlanLimit("previousVersions", limits, [], "en", en)).toBe("50 for 90 days");
    expect(formatPlanLimit("accessLogRetentionDays", limits, [], "en", en)).toBe("1 year");
    expect(formatPlanLimit("annotationMessages", limits, [], "en", en)).toBe("25,000");
  });

  it("marks per-seat limits as per seat", () => {
    const { limits, perSeat } = PLANS.team;
    expect(formatPlanLimit("accountBytes", limits, perSeat, "en", en)).toBe("30 GB per seat");
    expect(formatPlanLimit("requestsPerMonth", limits, perSeat, "en", en)).toBe(
      "3,000,000 per seat",
    );
    expect(formatPlanLimit("annotationMessages", limits, perSeat, "en", en)).toBe(
      "25,000 per seat",
    );
    expect(formatPlanLimit("activeArtifacts", limits, perSeat, "en", en)).toBe("2,000");
    expect(formatPlanLimit("bytesPerMonth", limits, perSeat, "en", en)).toBe("1 TB");
  });
});

describe("formatPlanPrice", () => {
  it("prices in US dollars with the page's language", () => {
    expect(formatPlanPrice("free", "en", en)).toEqual({ amount: "$0", unit: "per month" });
    expect(formatPlanPrice("pro", "en", en)).toEqual({ amount: "$2", unit: "per month" });
    expect(formatPlanPrice("team", "en", en)).toEqual({
      amount: "$5",
      unit: "per seat per month",
    });
    expect(formatPlanPrice("enterprise", "en", en)).toEqual({ amount: "Contact us", unit: "" });
    for (const locale of LOCALE_CODES) {
      const { amount } = formatPlanPrice("pro", locale, PLAN_TEXT[locale]);
      expect(amount, locale).toMatch(/2/);
      expect(amount, locale).toMatch(/\$|US/);
    }
  });
});

describe("planSummary", () => {
  it("lists only the features that work today and the rest as coming soon", () => {
    const pro = planSummary("pro", "en", en);
    expect(pro.name).toBe("Pro");
    expect(pro.included).toEqual([
      PLAN_FEATURE_LABELS.pin,
      PLAN_FEATURE_LABELS.versionDiff,
      PLAN_FEATURE_LABELS.shareLinks,
      PLAN_FEATURE_LABELS.commentNotices,
      PLAN_FEATURE_LABELS.analytics,
      PLAN_FEATURE_LABELS.branding,
    ]);
    expect(pro.comingSoon).toEqual([
      PLAN_FEATURE_LABELS.webhooks,
      PLAN_FEATURE_LABELS.customDomains,
    ]);
    expect(planSummary("team", "en", en).included).toContain(PLAN_FEATURE_LABELS.workspaces);
    expect(planSummary("enterprise", "en", en).comingSoon).toContain(PLAN_FEATURE_LABELS.sso);
  });

  it("describes Free by what every account can do", () => {
    const free = planSummary("free", "en", en);
    expect(free.included).toEqual([en["plans.includedFree"]]);
    expect(free.comingSoon).toEqual([]);
  });
});

describe("planComparison", () => {
  it("has one row per limit and one cell per plan", () => {
    const rows = planComparison("en", en);
    expect(rows.map((row) => row.row)).toEqual([...PLAN_LIMIT_ROWS]);
    for (const row of rows) {
      expect(row.cells.map((cell) => cell.plan)).toEqual(["free", "pro", "team", "enterprise"]);
    }
  });
});

describe("planRequest", () => {
  it("is a mailto link named for the plan", () => {
    expect(planRequest("team", en)).toEqual({
      href: "mailto:hello@portifact.com?subject=Portifact%20Team%20plan%20request",
      label: "Request access",
      accessibleName: "Request access to the Team plan",
    });
  });
});

const argumentsOf = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

describe.each(LOCALE_CODES)("the %s plan text", (code) => {
  const text = PLAN_TEXT[code];

  it("has every English key, with the same arguments, valid as ICU and without dashes", () => {
    expect(Object.keys(text).sort()).toEqual(Object.keys(en).sort());
    for (const [key, message] of Object.entries(text)) {
      expect(message.trim(), key).not.toBe("");
      expect(message, key).not.toMatch(/[–—]/);
      expect(argumentsOf(message).sort(), key).toEqual(
        argumentsOf(en[key as keyof typeof en]).sort(),
      );
      expect(() => compileMessage(message), key).not.toThrow();
    }
  });

  it("keeps the request's accessible name starting with its visible label", () => {
    const { label, accessibleName } = planRequest("pro", text);
    // Label in name: speech users say what they see.
    expect(accessibleName.toLowerCase()).toContain(label.toLowerCase());
  });
});
