import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { RETENTION_NOTICE_TEXT, retentionNoticeEmail } from "./retention-notice.ts";

const FROM = Date.UTC(2026, 10, 18, 12, 0, 0);
const POLICIES = "https://app.portifact.com/policies?workspace=acme";

describe("the notice of a workspace's maximum life of artifacts", () => {
  it("says how long, from when, the counts and where to review it", () => {
    const email = retentionNoticeEmail({
      days: 90,
      from: FROM,
      atStart: 4,
      soon: 12,
      policiesUrl: POLICIES,
    });
    expect(email.subject).toBe("Your workspace will archive artifacts after a maximum life");
    expect(email.text).toContain(
      "set a maximum life of 90 days for its artifacts. From Wed, Nov 18, 2026, 12:00 UTC, an artifact is archived 90 days after its last publish or restore, and artifacts cannot be pinned.",
    );
    expect(email.text).toContain("unless someone publishes them again: 4.");
    expect(email.text).toContain("within the following 30 days: 12.");
    expect(email.text).toContain("this policy deletes nothing");
    expect(email.text).toContain(`Review or change it on the Policies page: ${POLICIES}`);
    expect(email.html).toContain(`href="${POLICIES.replace("&", "&amp;")}"`);
  });

  it("names no workspace or artifact, so it is the same in every region", () => {
    const email = retentionNoticeEmail({
      days: 7,
      from: FROM,
      atStart: 0,
      soon: 0,
      policiesUrl: POLICIES,
    });
    expect(email.subject).not.toContain("acme");
    expect(email.text.split(POLICIES).join("")).not.toContain("acme");
  });

  it.each(LOCALE_CODES)("is written in %s", (locale) => {
    const email = retentionNoticeEmail({
      days: 30,
      from: FROM,
      atStart: 2,
      soon: 3,
      policiesUrl: POLICIES,
      locale,
    });
    const t = RETENTION_NOTICE_TEXT[locale];
    expect(email.subject).toBe(t.subject);
    expect(email.text).toContain(t.atStart(2));
    expect(email.text).toContain(t.soon(3));
    expect(email.html).toContain(`lang="${locale}"`);
  });
});
