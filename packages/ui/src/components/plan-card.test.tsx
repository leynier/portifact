// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PlanCardContent,
  planCardHtml,
  planTableHtml,
  STATIC_BUTTON_CLASSES,
} from "../static/plans.ts";
import { axeViolations } from "../testing/axe.ts";
import { buttonClasses } from "./button.tsx";
import { PlanCard } from "./plan-card.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from "./table.tsx";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

const THEMES = ["light", "dark"] as const;

const card: PlanCardContent = {
  id: "pro",
  name: "Pro",
  summary: "For one person who shares often",
  price: { amount: "$2", unit: "per month" },
  includedLabel: "Included",
  included: ["Pinning artifacts", "Comparing versions"],
  comingSoonLabel: "Coming soon",
  comingSoon: ["Sending webhooks"],
  action: {
    label: "Request access",
    href: "mailto:hello@portifact.com?subject=Pro",
    accessibleName: "Request access to the Pro plan",
  },
};

describe("PlanCard", () => {
  it.each(THEMES)(
    "names the card by the plan and lists what it includes and what is coming (%s)",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <PlanCard
          {...card}
          currentLabel="Current plan"
          action={<a href={card.action.href}>Request access</a>}
        />,
      );
      const article = screen.getByRole("article", { name: "Pro" });
      expect(article.getAttribute("data-plan")).toBe("pro");
      expect(screen.getByRole("heading", { level: 3, name: "Pro" })).toBeTruthy();
      expect(within(article).getByText("Current plan")).toBeTruthy();
      expect(article.textContent).toContain("$2");
      expect(article.textContent).toContain("per month");
      const [included, soon] = within(article).getAllByRole("list");
      expect(within(included as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
      expect(within(soon as HTMLElement).getByText("Sending webhooks")).toBeTruthy();
      expect(article.textContent).toContain("Coming soon");
      expect(screen.getByRole("link", { name: "Request access" }).getAttribute("href")).toBe(
        card.action.href,
      );
      expect(await axeViolations(container)).toEqual([]);
    },
  );

  it("leaves out empty lists, the unit, the badge and the action when there are none", async () => {
    const { container } = render(
      <PlanCard
        {...card}
        id="enterprise"
        name="Enterprise"
        price={{ amount: "Contact us", unit: "" }}
        comingSoon={[]}
        action={undefined}
        headingLevel={2}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Enterprise" })).toBeTruthy();
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Contact us").nextElementSibling).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("planCardHtml", () => {
  it.each(THEMES)("draws the same card as static HTML (%s)", async (theme) => {
    document.documentElement.dataset.theme = theme;
    document.body.innerHTML = `<main>${planCardHtml(card)}</main>`;
    const article = screen.getByRole("article", { name: "Pro" });
    expect(screen.getByRole("heading", { level: 3, name: "Pro" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Request access to the Pro plan" });
    expect(link.getAttribute("href")).toBe(card.action.href);
    expect(link.textContent).toBe("Request access");
    expect(within(article).getAllByRole("listitem")).toHaveLength(3);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("escapes every value and takes a primary action and a level 2 heading", () => {
    const html = planCardHtml(
      {
        ...card,
        name: '<b>"Pro"</b>',
        included: ["a & b"],
        comingSoon: [],
        price: { amount: "$0", unit: "" },
        action: { label: "Sign in", href: "https://app.portifact.com/?a=1&b=2", primary: true },
      },
      2,
    );
    expect(html).toContain("&lt;b&gt;&quot;Pro&quot;&lt;/b&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain('href="https://app.portifact.com/?a=1&amp;b=2"');
    expect(html).toContain("<h2 ");
    expect(html).not.toContain(" aria-label=");
    expect(html).toContain(STATIC_BUTTON_CLASSES.primary);
    expect(html).not.toContain("Coming soon");
  });

  it("uses the design system's button classes", () => {
    expect(STATIC_BUTTON_CLASSES.primary).toBe(buttonClasses({ intent: "primary", size: "md" }));
    expect(STATIC_BUTTON_CLASSES.secondary).toBe(
      buttonClasses({ intent: "secondary", size: "md" }),
    );
  });
});

describe("planTableHtml", () => {
  it.each(THEMES)("is a table with a caption, column and row headers (%s)", async (theme) => {
    document.documentElement.dataset.theme = theme;
    document.body.innerHTML = `<main>${planTableHtml({
      caption: "Limits of each plan",
      rowHeader: "Limit",
      plans: [
        { id: "free", name: "Free" },
        { id: "pro", name: "Pro" },
      ],
      rows: [{ id: "activeArtifacts", label: "Active artifacts", cells: ["50", "500"] }],
    })}</main>`;
    const table = screen.getByRole("table", { name: "Limits of each plan" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Limit", "Free", "Pro"]);
    expect(within(table).getByRole("rowheader", { name: "Active artifacts" })).toBeTruthy();
    const cell = table.querySelector('td[data-plan="pro"][data-limit="activeArtifacts"]');
    expect(cell?.textContent).toBe("500");
    expect(screen.getByRole("region", { name: "Limits of each plan" }).tabIndex).toBe(0);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe("TableRowHeader", () => {
  it.each([false, true])("names its row (stacked %s)", async (stacked) => {
    const { container } = render(
      <Table caption="Limits" stacked={stacked}>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Limit</TableHeaderCell>
            <TableHeaderCell>Free</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableRowHeader>Storage</TableRowHeader>
            <TableCell label="Free">2.5 GB</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("rowheader", { name: "Storage" })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });
});
