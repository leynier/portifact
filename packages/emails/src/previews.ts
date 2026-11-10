// Sample renderings of every email, for scripts/preview.ts and the tests. A new email adds its
// samples here, so `bun run --cwd packages/emails preview` always shows all of them.
import { DEFAULT_LOCALE, LOCALE_CODES } from "@portifact/contracts/locales";
import { budgetAlertEmail } from "./budget-alert.ts";
import { commentNoticeEmail } from "./comment-notice.ts";
import { domainNoticeEmail } from "./domain-notice.ts";
import { expiryNoticeEmail } from "./expiry-notice.ts";
import type { EmailContent } from "./message.ts";
import { signInCodeEmail } from "./sign-in-code.ts";

export interface Preview {
  name: string;
  email: EmailContent;
}

const CREATED_AT = Date.UTC(2026, 10, 8, 12, 0, 0);
const HOUR = 3_600_000;

const noticeArtifact = (id: string, name: string, hoursLeft: number) => ({
  name,
  url: `https://${id}.portifact.dev/`,
  renewUrl: `https://app.portifact.com/artifacts/${id}`,
  expiresAt: CREATED_AT + hoursLeft * HOUR,
});
const notice = {
  settingsUrl: "https://app.portifact.com/settings",
  activeDays: 30,
  archiveMonths: 6,
};

const commentArtifact = (
  id: string,
  name: string,
  newThreads: number,
  newReplies: number,
  resolvedThreads: number,
) => ({
  name,
  url: `https://app.portifact.com/view/${id}`,
  newThreads,
  newReplies,
  resolvedThreads,
});
const comments = {
  settingsUrl: "https://app.portifact.com/settings",
  unsubscribeUrl: "https://app.portifact.com/unsubscribe?token=cn1.sample.1794200000000.signature",
  names: true,
  more: 0,
};

/** Every language besides English, each previewed in every user-facing email. */
const TRANSLATED = LOCALE_CODES.filter((locale) => locale !== DEFAULT_LOCALE);

export function previews(): Preview[] {
  return [
    {
      name: "sign-in-code",
      email: signInCodeEmail({ email: "ada@example.com", code: "482913", expiresInMinutes: 5 }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `sign-in-code-${locale.toLowerCase()}`,
      email: signInCodeEmail({
        email: "ada@example.com",
        code: "482913",
        expiresInMinutes: 5,
        locale,
      }),
    })),
    {
      name: "budget-alert",
      email: budgetAlertEmail({
        alerts: [
          { kind: "spend_75", projectedUsd: 111.4, createdAt: CREATED_AT },
          { kind: "spend_100", projectedUsd: 111.4, createdAt: CREATED_AT },
        ],
        projectedUsd: 111.4,
        level: "protect100",
        actions: ["stop_new_artifacts", "block_uploads", "pause_annotation_writes"],
      }),
    },
    {
      name: "budget-alert-no-protection",
      email: budgetAlertEmail({
        alerts: [{ kind: "spend_25", projectedUsd: 25, createdAt: CREATED_AT }],
        projectedUsd: 25,
        level: "alert25",
        actions: [],
      }),
    },
    {
      name: "expiry-notice",
      email: expiryNoticeEmail({
        ...notice,
        artifacts: [
          noticeArtifact("k7d2qm4xab", "Q3 launch plan", 50),
          noticeArtifact("p4n8rt2vcd", "Design review notes", 66),
          noticeArtifact("z9w3hj6mef", "API prototype", 71),
        ],
      }),
    },
    {
      name: "expiry-notice-one",
      email: expiryNoticeEmail({
        ...notice,
        artifacts: [noticeArtifact("k7d2qm4xab", "Q3 launch plan", 70)],
      }),
    },
    {
      name: "comment-notice",
      email: commentNoticeEmail({
        ...comments,
        more: 3,
        artifacts: [
          commentArtifact("k7d2qm4xab", "Q3 launch plan", 2, 5, 1),
          commentArtifact("p4n8rt2vcd", "Design review notes", 0, 1, 0),
        ],
      }),
    },
    {
      name: "comment-notice-one",
      email: commentNoticeEmail({
        ...comments,
        artifacts: [commentArtifact("k7d2qm4xab", "Q3 launch plan", 1, 0, 0)],
      }),
    },
    {
      name: "comment-notice-without-names",
      email: commentNoticeEmail({
        ...comments,
        names: false,
        artifacts: [
          commentArtifact("k7d2qm4xab", "Q3 launch plan", 1, 2, 0),
          commentArtifact("p4n8rt2vcd", "Design review notes", 0, 0, 2),
        ],
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `comment-notice-${locale.toLowerCase()}`,
      email: commentNoticeEmail({
        ...comments,
        locale,
        more: 2,
        artifacts: [
          commentArtifact("k7d2qm4xab", "Q3 launch plan", 3, 5, 1),
          commentArtifact("p4n8rt2vcd", "Design review notes", 1, 1, 0),
        ],
      }),
    })),
    {
      name: "domain-notice",
      email: domainNoticeEmail({
        hostnames: ["docs.example.com", "handbook.example.com"],
        detachAt: CREATED_AT + 7 * 86_400_000,
        limit: 1,
        usageUrl: "https://app.portifact.com/usage",
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `domain-notice-${locale.toLowerCase()}`,
      email: domainNoticeEmail({
        hostnames: ["docs.example.com"],
        detachAt: CREATED_AT + 7 * 86_400_000,
        limit: 0,
        usageUrl: "https://app.portifact.com/usage",
        locale,
      }),
    })),
    ...TRANSLATED.map((locale) => ({
      name: `expiry-notice-${locale.toLowerCase()}`,
      email: expiryNoticeEmail({
        ...notice,
        locale,
        artifacts: [
          noticeArtifact("k7d2qm4xab", "Q3 launch plan", 50),
          noticeArtifact("p4n8rt2vcd", "Design review notes", 66),
        ],
      }),
    })),
  ];
}
