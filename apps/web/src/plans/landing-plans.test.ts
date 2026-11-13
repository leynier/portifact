// @vitest-environment happy-dom
// The landing's pricing section in every language: drawn from PLANS, so a number on the page
// that differs from what the product enforces fails here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALE_CODES, type LocaleCode } from "@portifact/contracts/locales";
import {
  PLAN_NAMES,
  PLAN_PRICES,
  PLANS,
  type PlanLimit,
  type PlanName,
  planFeatureStatus,
  planRequestHref,
} from "@portifact/contracts/plans";
import { axeViolations } from "@portifact/ui/testing";
import { describe, expect, it } from "vitest";
import { SITE_PAGES, type SitePage } from "../i18n/site.ts";
import { renderSiteHtml } from "../i18n/site-build.ts";
import {
  featureName,
  formatPlanData,
  formatPlanLimit,
  PLAN_LIMIT_ROWS,
  type PlanLimitRow,
} from "./format.ts";
import { PLAN_TEXT } from "./i18n/catalogs.ts";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LANDING = SITE_PAGES.find((page) => page.file === "index.html") as SitePage;
const source = readFileSync(join(WEB, LANDING.file), "utf8");

const rendered = new Map<LocaleCode, Document>(
  LOCALE_CODES.map((code) => [
    code,
    new DOMParser().parseFromString(renderSiteHtml(source, LANDING, code), "text/html"),
  ]),
);
const page = (code: LocaleCode) => rendered.get(code) as Document;

const cell = (document: Document, plan: PlanName, row: PlanLimitRow | "artifactData") =>
  document.querySelector(`td[data-plan="${plan}"][data-limit="${row}"]`)?.textContent ?? "";

const UNITS: Record<string, number> = { kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** Reads an English figure back into the number it shows, independently of the formatter. */
function englishValue(text: string): number {
  const match = /^([\d,.]+)\s*(kB|MB|GB|TB|days?|months?|years?)?/.exec(text);
  if (!match) throw new Error(`Not a figure: ${text}`);
  const value = Number((match[1] ?? "").replaceAll(",", ""));
  const unit = match[2] ?? "";
  if (UNITS[unit]) return Math.round(value * (UNITS[unit] as number));
  if (unit.startsWith("year")) return value * 365;
  return value;
}

const ROW_LIMIT: Record<Exclude<PlanLimitRow, "previousVersions">, PlanLimit> = {
  activeArtifacts: "activeArtifacts",
  artifactBytes: "artifactBytes",
  accountBytes: "accountBytes",
  requestsPerMonth: "requestsPerMonth",
  bytesPerMonth: "bytesPerMonth",
  archiveMonths: "archiveMonths",
  accessLogRetentionDays: "accessLogRetentionDays",
  annotationMessages: "annotationMessages",
};

describe("the pricing section's numbers", () => {
  it("equal PLANS in English, read back from the page", () => {
    const document = page("en");
    for (const plan of PLAN_NAMES) {
      const { limits, perSeat } = PLANS[plan];
      for (const [row, limit] of Object.entries(ROW_LIMIT) as [PlanLimitRow, PlanLimit][]) {
        const text = cell(document, plan, row);
        expect(englishValue(text), `${plan} ${row}: ${text}`).toBe(limits[limit]);
        expect(text.endsWith(" per seat"), `${plan} ${row}`).toBe(perSeat.includes(limit));
      }
      const versions = cell(document, plan, "previousVersions");
      const [count, days] = versions.split(" for ");
      expect(englishValue(count ?? ""), `${plan} versions`).toBe(limits.retainedPreviousVersions);
      expect(englishValue(days ?? ""), `${plan} versions`).toBe(
        limits.previousVersionRetentionDays,
      );
    }
  });

  it("equal PLANS in every language", () => {
    for (const code of LOCALE_CODES) {
      const document = page(code);
      for (const plan of PLAN_NAMES) {
        const { limits, perSeat } = PLANS[plan];
        for (const row of PLAN_LIMIT_ROWS) {
          expect(cell(document, plan, row), `${code} ${plan} ${row}`).toBe(
            formatPlanLimit(row, limits, perSeat, code, PLAN_TEXT[code]),
          );
        }
      }
    }
  });

  it("show artifact data from PLANS, as coming soon, in every language", () => {
    for (const code of LOCALE_CODES) {
      const document = page(code);
      for (const plan of PLAN_NAMES) {
        expect(cell(document, plan, "artifactData"), `${code} ${plan}`).toBe(
          formatPlanData(plan, code, PLAN_TEXT[code]),
        );
      }
    }
    const english = page("en");
    for (const plan of PLAN_NAMES) {
      const [count, size] = cell(english, plan, "artifactData").split(" × ");
      expect(Number(count), plan).toBe(PLANS[plan].data.artifacts);
      expect(englishValue(size ?? ""), plan).toBe(PLANS[plan].data.perArtifact.bytesPerArtifact);
    }
  });

  it("show the listed prices in US dollars", () => {
    const document = page("en");
    const prices = PLAN_NAMES.map(
      (plan) => document.querySelector(`[data-plan="${plan}"] [data-plan-price]`)?.textContent,
    );
    expect(prices).toEqual(["$0per month", "$2per month", "$5per seat per month", "Contact us"]);
    expect(PLAN_PRICES.pro.usdPerMonth).toBe(2);
  });

  it("show the free tier's figures from PLANS", () => {
    const document = page("en");
    const figure = (row: string) =>
      document.querySelector(`[data-plan-limit="${row}"]`)?.textContent ?? "";
    expect(englishValue(figure("activeArtifacts"))).toBe(PLANS.free.limits.activeArtifacts);
    expect(englishValue(figure("artifactBytes"))).toBe(PLANS.free.limits.artifactBytes);
    expect(englishValue(figure("accountBytes"))).toBe(PLANS.free.limits.accountBytes);
  });
});

describe.each(LOCALE_CODES)("the %s pricing section", (code) => {
  const document = page(code);
  const text = PLAN_TEXT[code];
  const section = document.getElementById("plans");

  it("is linked from the navigation and holds four plans with their actions", () => {
    expect(section).not.toBeNull();
    expect(document.querySelector('header nav a[href="#plans"]')).not.toBeNull();
    expect(document.querySelector('footer a[href="#plans"]')).not.toBeNull();
    const cards = [...(section?.querySelectorAll("article[data-plan]") ?? [])];
    expect(cards.map((card) => card.getAttribute("data-plan"))).toEqual([...PLAN_NAMES]);
    for (const plan of PLAN_NAMES) {
      const action = section?.querySelector(`[data-plan="${plan}"] a[data-plan-action]`);
      const href = action?.getAttribute("href");
      if (plan === "free") {
        expect(href).toBe(
          code === "en" ? "https://app.portifact.com/" : `https://app.portifact.com/?lang=${code}`,
        );
      } else {
        expect(href).toBe(planRequestHref(plan));
        expect(action?.textContent).toBe(text["plans.action.request"]);
      }
    }
    expect(section?.querySelector("[data-plans-note]")?.textContent).toBe(text["plans.price.note"]);
  });

  it("marks only the features that work today as included", () => {
    for (const plan of PLAN_NAMES) {
      const card = section?.querySelector(`article[data-plan="${plan}"]`);
      const lists = [...(card?.querySelectorAll("ul") ?? [])].map((list) =>
        [...list.querySelectorAll("li")].map((item) => item.textContent),
      );
      const { available, comingSoon } = planFeatureStatus(plan);
      const included = plan === "free" ? [text["plans.includedFree"]] : available;
      expect(lists[0], plan).toEqual(
        plan === "free" ? included : available.map((f) => featureName(f, text)),
      );
      expect(lists[1] ?? [], plan).toEqual(comingSoon.map((f) => featureName(f, text)));
    }
  });

  it("is translated and passes the accessibility checks", async () => {
    expect(section?.outerHTML).not.toContain("data-i18n");
    const table = section?.querySelector("table");
    expect(table?.querySelector("caption")?.textContent).toBe(text["plans.table.caption"]);
    // One row per limit, then artifact data's.
    expect(table?.querySelectorAll('th[scope="row"]')).toHaveLength(PLAN_LIMIT_ROWS.length + 1);
    expect(table?.querySelectorAll('th[scope="col"]')).toHaveLength(PLAN_NAMES.length + 1);
    window.document.documentElement.lang = code;
    window.document.body.innerHTML = `<main>${section?.outerHTML ?? ""}</main>`;
    expect(await axeViolations(window.document.body)).toEqual([]);
  });
});
