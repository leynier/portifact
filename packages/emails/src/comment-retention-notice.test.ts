import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import {
  COMMENT_RETENTION_NOTICE_TEXT,
  commentRetentionNoticeEmail,
} from "./comment-retention-notice.ts";

const FROM = Date.UTC(2026, 10, 18, 12, 0, 0);
const POLICIES = "https://app.portifact.com/policies?workspace=acme";
const base = {
  days: 90,
  from: FROM,
  at: FROM,
  threads: 4,
  messages: 21,
  policiesUrl: POLICIES,
};

describe("the notices of a workspace's comment retention", () => {
  it("says how long, from when, how many threads and messages, and that it is final", () => {
    const email = commentRetentionNoticeEmail({ ...base, kind: "set" });
    expect(email.subject).toBe("Your workspace will delete old comment threads");
    expect(email.text).toContain(
      "set its comment retention to 90 days. From Wed, Nov 18, 2026, 12:00 UTC, a comment thread is deleted for good",
    );
    expect(email.text).toContain(
      "Open threads on an artifact's current version are kept; once a new version replaces it, each gets the whole period again from that moment.",
    );
    expect(email.text).toContain(
      "Threads deleted on Wed, Nov 18, 2026, 12:00 UTC: 4, with 21 messages.",
    );
    expect(email.text).toContain("cannot be recovered by anyone, Portifact included");
    expect(email.text).toContain(`Review or change it on the Policies page: ${POLICIES}`);
    expect(email.html).toContain("<strong");
  });

  it("has a second kind for the days before the first deletion", () => {
    const email = commentRetentionNoticeEmail({
      ...base,
      kind: "soon",
      at: FROM + 40 * 86_400_000,
    });
    expect(email.subject).toBe("Old comment threads in your workspace are deleted in a few days");
    expect(email.text).toContain("Threads deleted on Mon, Dec 28, 2026, 12:00 UTC: 4");
  });

  it("names no workspace, artifact or comment", () => {
    const email = commentRetentionNoticeEmail({ ...base, kind: "set" });
    expect(`${email.subject}${email.text.split(POLICIES).join("")}`).not.toContain("acme");
  });

  it.each(LOCALE_CODES)("is written in %s", (locale) => {
    const t = COMMENT_RETENTION_NOTICE_TEXT[locale];
    for (const kind of ["set", "soon"] as const) {
      const email = commentRetentionNoticeEmail({ ...base, kind, locale });
      expect(email.subject).toBe(t.subject[kind]);
      expect(email.text).toContain(t.final);
      expect(email.html).toContain(`lang="${locale}"`);
    }
  });
});
