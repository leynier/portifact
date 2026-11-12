import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { MODERATION_NOTICE_TEXT, moderationNoticeEmail } from "./moderation-notice.ts";
import { REPORT_OUTCOME_TEXT, reportOutcomeEmail } from "./report-outcome.ts";

const AT = Date.UTC(2026, 10, 8, 12);
const DASHBOARD = "https://app.portifact.com/artifacts/k7d2qm4xab";
const base = {
  action: "suspend" as const,
  target: "artifact" as const,
  artifactId: "k7d2qm4xab",
  artifactName: "Q3 plan",
  reason: "phishing" as const,
  source: "notice" as const,
  facts: "The /login page asks for bank passwords.\nChecked on 8 November.",
  ground: "Acceptable Use Policy: phishing.",
  decidedAt: AT,
  dashboardUrl: DASHBOARD,
};

describe("the statement of reasons", () => {
  it("says what, the scope, the category, the source, that a person decided, the facts, the ground and how to ask for a review", () => {
    const email = moderationNoticeEmail(base);
    expect(email.subject).toBe("We suspended your artifact k7d2qm4xab");
    expect(email.text).toContain('We suspended the artifact "Q3 plan" (k7d2qm4xab).');
    expect(email.text).toContain("This applies everywhere Portifact is available.");
    expect(email.text).toContain("It has no end date");
    expect(email.text).toContain("Category: phishing or a fake sign-in page");
    expect(email.text).toContain("We acted on a notice we received about it.");
    expect(email.text).toContain("A person took this decision.");
    expect(email.text).toContain(
      "The /login page asks for bank passwords.\nChecked on 8 November.",
    );
    expect(email.text).toContain("Acceptable Use Policy: phishing.");
    expect(email.text).toContain("write to abuse@portifact.com");
    expect(email.text).toContain(DASHBOARD);
    expect(email.text).toContain("cannot be turned off");
    expect(email.text).not.toContain("unsubscribe");
    expect(email.html).toContain(`href="${DASHBOARD}"`);
  });

  it("names the artifact only by its ID without a name, and says when it followed a review", () => {
    const email = moderationNoticeEmail({ ...base, artifactName: null, source: "review" });
    expect(email.text).toContain("We suspended the artifact k7d2qm4xab.");
    expect(email.text).not.toContain("Q3 plan");
    expect(email.text).toContain("We acted after our own review.");
  });

  it("escapes the operator's text in the HTML and keeps it as written in the text", () => {
    const email = moderationNoticeEmail({ ...base, facts: "<script>x</script> & more" });
    expect(email.html).not.toContain("<script>x</script>");
    expect(email.html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; more");
    expect(email.text).toContain("<script>x</script> & more");
  });

  it("covers accounts, brands and reinstatements", () => {
    const account = moderationNoticeEmail({ ...base, target: "account" });
    expect(account.subject).toBe("We suspended your Portifact account");
    expect(account.text).toContain(
      "You can still sign in, export your data and delete your account.",
    );
    expect(account.text).not.toContain("ID: ");
    const brand = moderationNoticeEmail({ ...base, target: "brand" });
    expect(brand.text).toContain("The viewer shows the default bar instead.");
    const lifted = moderationNoticeEmail({
      ...base,
      action: "reinstate",
      ground: null,
      reason: null,
    });
    expect(lifted.subject).toBe("Your artifact k7d2qm4xab is no longer suspended");
    expect(lifted.text).not.toContain("It has no end date");
    expect(lifted.text).not.toContain("The ground");
    expect(lifted.text).not.toContain("Category");
  });

  it("is written in every language, for every target and action", () => {
    for (const locale of LOCALE_CODES) {
      const t = MODERATION_NOTICE_TEXT[locale];
      for (const target of ["artifact", "account", "brand"] as const) {
        for (const action of ["suspend", "reinstate"] as const) {
          const email = moderationNoticeEmail({ ...base, locale, target, action });
          const subjects = action === "suspend" ? t.suspendSubject : t.liftSubject;
          const what = action === "suspend" ? t.suspendWhat : t.liftWhat;
          expect(email.subject).toBe(subjects[target]("k7d2qm4xab"));
          expect(email.text).toContain(what[target]('"Q3 plan" (k7d2qm4xab)').slice(0, 10));
        }
      }
      const email = moderationNoticeEmail({ ...base, locale });
      expect(email.subject).toBe(t.suspendSubject.artifact("k7d2qm4xab"));
      expect(email.text).toContain(t.reasons.phishing);
      expect(email.text).toContain(t.human);
      expect(email.text).toContain("abuse@portifact.com");
      expect(email.html).toContain(`lang="${locale}"`);
    }
  });
});

describe("the outcome of a report", () => {
  const ORIGIN = "https://k7d2qm4xab.portifact.dev";
  it("names only the artifact's origin and the date, never a path or the reporter's text", () => {
    const email = reportOutcomeEmail({
      outcome: "actioned",
      artifactOrigin: ORIGIN,
      reportedAt: AT,
    });
    expect(email.subject).toBe("The outcome of your report to Portifact");
    expect(email.text).toContain(ORIGIN);
    expect(email.text).toContain(
      "We reviewed it and restricted the content. A person took this decision.",
    );
    expect(email.text).toContain("write to abuse@portifact.com");
    const dismissed = reportOutcomeEmail({
      outcome: "dismissed",
      artifactOrigin: ORIGIN,
      reportedAt: AT,
    });
    expect(dismissed.text).toContain("we took no action");
  });

  it("refuses anything but an artifact's origin", () => {
    for (const artifactOrigin of [
      "https://k7d2qm4xab.portifact.dev/login",
      "https://evil.example",
      "http://k7d2qm4xab.portifact.dev",
      "https://k7d2qm4xab.portifact.dev?x=1",
    ]) {
      expect(
        () => reportOutcomeEmail({ outcome: "actioned", artifactOrigin, reportedAt: AT }),
        artifactOrigin,
      ).toThrow();
    }
  });

  it("is written in every language", () => {
    for (const locale of LOCALE_CODES) {
      const email = reportOutcomeEmail({
        outcome: "dismissed",
        artifactOrigin: ORIGIN,
        reportedAt: AT,
        locale,
      });
      expect(email.subject).toBe(REPORT_OUTCOME_TEXT[locale].subject);
      expect(email.text).toContain(REPORT_OUTCOME_TEXT[locale].dismissed);
      expect(email.html).toContain(`lang="${locale}"`);
    }
  });
});
