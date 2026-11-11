import { GRACE_NOTICE_MOMENTS } from "@portifact/contracts";
import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { formatExpiry } from "./expiry-notice.ts";
import { GRACE_NOTICE_TEXT, type GraceNoticeInput, graceNoticeEmail } from "./grace-notice.ts";
import { previews } from "./previews.ts";

const DAY = 86_400_000;
const UNTIL = Date.UTC(2027, 0, 10, 12, 0, 0);
const DOWNLOAD = "https://app.portifact.com/data?workspace=engines";
const REQUEST = "mailto:hello@portifact.com?subject=Portifact%20Team%20plan%20request";
const COMMAND = "portifact export ./portifact-export --workspace engines";

const input: GraceNoticeInput = {
  moment: "start",
  until: UNTIL,
  plan: "Team",
  kinds: [
    { kind: "versions", count: 1240, from: UNTIL },
    { kind: "auditEvents", count: 96, from: UNTIL - 5 * DAY },
  ],
  workspace: "Analytical Engines",
  names: true,
  downloadUrl: DOWNLOAD,
  exportCommand: COMMAND,
  requestUrl: REQUEST,
};

describe("the grace email", () => {
  it("says until when the data is held, what goes and how much, and both actions", () => {
    const email = graceNoticeEmail(input);
    // The audit events go on Jan 5, before the hold's end: every date comes from the steps.
    expect(email.subject).toBe("Your data is held until Tue, Jan 5, 2027, 12:00 UTC");
    expect(email.text).toContain(
      "The Team plan of this space ended or was lowered. What it kept is held until Sun, Jan 10, 2027, 12:00 UTC. Nothing held goes before Tue, Jan 5, 2027, 12:00 UTC.",
    );
    expect(email.html).toContain("Nothing held goes before Tue, Jan 5, 2027, 12:00 UTC.");
    expect(email.text).toContain("Space: Analytical Engines");
    expect(email.text).toContain("- Previous versions: 1,240, from Sun, Jan 10, 2027, 12:00 UTC");
    expect(email.text).toContain("- Audit events: 96, from Tue, Jan 5, 2027, 12:00 UTC");
    expect(email.text).toContain(`Download what you need before then: ${DOWNLOAD}`);
    expect(email.text).toContain(`  ${COMMAND}`);
    expect(email.text).toContain(`To keep everything, ask for the plan again: ${REQUEST}`);
    expect(email.text).toContain("cannot be turned off");
    expect(email.html).toContain(`href="${DOWNLOAD}"`);
    expect(email.html).toContain("Ask for Team again");
    expect(email.html).toContain(COMMAND);
    // A service notice: no unsubscribe link of any kind.
    for (const part of [email.text, email.html]) expect(part).not.toMatch(/unsubscribe/i);
  });

  it("never says nothing goes before a date later than the first step listed", () => {
    // A later hold's start email while an earlier hold lets versions go first.
    const email = graceNoticeEmail({
      ...input,
      until: UNTIL,
      kinds: [{ kind: "versions", count: 40, from: UNTIL - 50 * DAY }],
    });
    expect(email.text).not.toContain("nothing is deleted before");
    expect(email.subject).toBe("Your data is held until Sat, Nov 21, 2026, 12:00 UTC");
    expect(email.text).toContain("Nothing held goes before Sat, Nov 21, 2026, 12:00 UTC.");
    expect(email.text).toContain("held until Sun, Jan 10, 2027, 12:00 UTC");
    for (const locale of LOCALE_CODES) {
      const t = GRACE_NOTICE_TEXT[locale];
      const localized = graceNoticeEmail({ ...input, locale, kinds: input.kinds });
      expect(localized.text).toContain(t.safe(formatExpiry(UNTIL - 5 * DAY, locale)));
    }
  });

  it("says no first date when nothing is counted, and dates the subject by the hold's end", () => {
    const email = graceNoticeEmail({ ...input, kinds: [] });
    expect(email.subject).toBe("Your data is held until Sun, Jan 10, 2027, 12:00 UTC");
    expect(email.text).not.toContain("Nothing held goes before");
  });

  it.each([
    ["two_weeks", "Two weeks left: your held data goes on Sun, Jan 10, 2027, 12:00 UTC"],
    ["three_days", "Three days left: your held data goes on Sun, Jan 10, 2027, 12:00 UTC"],
  ] as const)("words the %s email as a reminder", (moment, subject) => {
    const email = graceNoticeEmail({ ...input, moment });
    expect(email.subject).toBe(subject);
    expect(email.text).toContain(
      "What the Team plan of this space kept is held only until Sun, Jan 10, 2027, 12:00 UTC.",
    );
    expect(email.text).not.toContain("ended or was lowered");
  });

  it("says when nothing is counted to go, and names a personal space as the account", () => {
    const email = graceNoticeEmail({ ...input, kinds: [], workspace: null });
    expect(email.text).toContain("Nothing more is counted to go.");
    expect(email.text).toContain("Space: Your account");
    expect(email.text).not.toContain("What goes, and from when");
  });

  it("never names the workspace outside the default region, the subject included", () => {
    const email = graceNoticeEmail({ ...input, names: false });
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toContain("Analytical Engines");
    }
    expect(email.text).toContain("Space: One of your workspaces");
    expect(email.text).toContain(DOWNLOAD);
    expect(email.text).toContain("1,240");
  });

  it("escapes the workspace's name, keeps it on one line and out of the subject", () => {
    const email = graceNoticeEmail({ ...input, workspace: "<b>Evil</b>\nSpace: fake" });
    expect(email.html).not.toContain("<b>Evil</b>");
    expect(email.html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(email.text).toContain("Space: <b>Evil</b> Space: fake");
    expect(email.subject).not.toContain("Evil");
  });

  it.each(LOCALE_CODES)("is written in %s for every moment, with and without names", (locale) => {
    const t = GRACE_NOTICE_TEXT[locale];
    const subjects = new Set<string>();
    for (const moment of GRACE_NOTICE_MOMENTS) {
      const email = graceNoticeEmail({ ...input, moment, locale });
      subjects.add(email.subject);
      expect(email.html).toContain(`lang="${locale}"`);
      expect(email.subject).not.toContain("Analytical Engines");
      expect(email.text).toContain(t.kinds.versions);
      expect(email.text).toContain(t.reason);
      expect(email.text).toContain(DOWNLOAD);
      expect(email.html).toContain(t.requestLink("Team"));
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/[—–]/);
      }
      const hidden = graceNoticeEmail({ ...input, moment, locale, names: false });
      expect(`${hidden.subject}${hidden.text}${hidden.html}`).not.toContain("Analytical Engines");
      expect(hidden.text).toContain(t.someWorkspace);
    }
    expect(subjects.size).toBe(3);
    expect(t.introStart("Pro", "D")).toContain("Pro");
    expect(t.introStart("Pro", "D")).toContain("D");
    expect(t.introLater("Pro", "D")).toContain("D");
    expect(t.amount("7", "D")).toContain("7");
    expect(t.preheader("D")).toContain("D");
    expect(new Set(Object.values(t.kinds)).size).toBe(5);
  });

  it("has previews for every moment and language, and EU previews without the name", () => {
    const named = previews().filter((p) => p.name.startsWith("grace-notice"));
    const nameless = named.filter((p) => p.name.startsWith("grace-notice-without-names"));
    expect(nameless).toHaveLength(LOCALE_CODES.length);
    for (const { email } of nameless) {
      expect(`${email.subject}${email.text}${email.html}`).not.toContain("Analytical Engines");
    }
    expect(named.find((p) => p.name === "grace-notice-start")?.email.text).toContain(
      "Analytical Engines",
    );
  });
});
