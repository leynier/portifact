// Sample renderings of every email, for scripts/preview.ts and the tests. A new email adds its
// samples here, so `bun run --cwd packages/emails preview` always shows all of them.
import { DEFAULT_LOCALE, LOCALE_CODES } from "@portifact/contracts/locales";
import { accountDeletionCodeEmail } from "./account-deletion-code.ts";
import { budgetAlertEmail } from "./budget-alert.ts";
import { commentNoticeEmail } from "./comment-notice.ts";
import { commentRetentionNoticeEmail } from "./comment-retention-notice.ts";
import { dataRightsNoticeEmail } from "./data-rights-notice.ts";
import { directoryNoticeEmail } from "./directory-notice.ts";
import { domainNoticeEmail } from "./domain-notice.ts";
import { expiryNoticeEmail } from "./expiry-notice.ts";
import { graceNoticeEmail } from "./grace-notice.ts";
import { invitationEmail } from "./invitation.ts";
import type { EmailContent } from "./message.ts";
import { moderationNoticeEmail } from "./moderation-notice.ts";
import { reportOutcomeEmail } from "./report-outcome.ts";
import { retentionNoticeEmail } from "./retention-notice.ts";
import { reviewNoticeEmail } from "./review-notice.ts";
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

/** An EU workspace's notice (decision 0005): counts and a link to the filtered list. */
const withoutNames = {
  names: false as const,
  listUrl: "https://app.portifact.com/?workspace=engines&expiring=soon",
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

const review = {
  name: "Q3 launch plan",
  version: 4,
  url: "https://app.portifact.com/view/k7d2qm4xab",
  settingsUrl: "https://app.portifact.com/settings",
  unsubscribeUrl: "https://app.portifact.com/unsubscribe?token=cn1.sample.1794200000000.signature",
  names: true,
};

const DAY = 86_400_000;
const graceEnd = CREATED_AT + 60 * DAY;
/** A workspace's grace email (decision 0022, third delivery), as the jobs Worker builds it. */
const grace = {
  moment: "start" as const,
  until: graceEnd,
  plan: "Team",
  kinds: [
    { kind: "versions" as const, count: 1_240, from: graceEnd },
    { kind: "accessLog" as const, count: 18_302, from: graceEnd },
    { kind: "analytics" as const, count: 412, from: graceEnd },
    { kind: "auditEvents" as const, count: 96, from: graceEnd },
    { kind: "pins" as const, count: 3, from: graceEnd },
  ],
  workspace: "Analytical Engines",
  names: true,
  downloadUrl: "https://app.portifact.com/data?workspace=engines",
  exportCommand: "portifact export ./portifact-export --workspace engines",
  requestUrl: "mailto:hello@portifact.com?subject=Portifact%20Team%20plan%20request",
};
/** An EU workspace's (decision 0005): the workspace is linked, never named. */
const graceWithoutNames = { ...grace, names: false };

/** Every language besides English, each previewed in every user-facing email. */
const TRANSLATED = LOCALE_CODES.filter((locale) => locale !== DEFAULT_LOCALE);

const suspension = {
  action: "suspend" as const,
  target: "artifact" as const,
  artifactId: "k7d2qm4xab",
  artifactName: "Q3 launch plan",
  reason: "phishing" as const,
  source: "notice" as const,
  facts:
    "The page at /login asks visitors for their bank password and sends it to another site.\nWe checked it on 8 November 2026.",
  ground: 'Acceptable Use Policy, "What you may not publish": phishing pages.',
  decidedAt: CREATED_AT,
  dashboardUrl: "https://app.portifact.com/artifacts/k7d2qm4xab",
};

const invitation = {
  email: "grace@example.com",
  inviterName: "Ada Lovelace",
  workspaceName: "Analytical Engines",
  role: "editor" as const,
  acceptUrl: "https://app.portifact.com/invitations#token=sample",
  expiresAt: CREATED_AT + 7 * 24 * HOUR,
};

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
      name: "account-deletion-code",
      email: accountDeletionCodeEmail({
        email: "ada@example.com",
        code: "482913",
        expiresInMinutes: 5,
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `account-deletion-code-${locale.toLowerCase()}`,
      email: accountDeletionCodeEmail({
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
      name: "expiry-notice-without-names",
      email: expiryNoticeEmail({
        ...notice,
        ...withoutNames,
        artifacts: [
          noticeArtifact("k7d2qm4xab", "Q3 launch plan", 50),
          noticeArtifact("p4n8rt2vcd", "Design review notes", 66),
        ],
      }),
    },
    {
      name: "expiry-notice-without-names-one",
      email: expiryNoticeEmail({
        ...notice,
        ...withoutNames,
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
    {
      name: "retention-notice",
      email: retentionNoticeEmail({
        days: 90,
        from: CREATED_AT + 7 * 86_400_000,
        atStart: 4,
        soon: 12,
        policiesUrl: "https://app.portifact.com/policies?workspace=acme",
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `retention-notice-${locale.toLowerCase()}`,
      email: retentionNoticeEmail({
        days: 90,
        from: CREATED_AT + 7 * 86_400_000,
        atStart: 1,
        soon: 0,
        policiesUrl: "https://app.portifact.com/policies?workspace=acme",
        locale,
      }),
    })),
    ...(["set", "soon"] as const).map((kind) => ({
      name: `comment-retention-${kind}`,
      email: commentRetentionNoticeEmail({
        kind,
        days: 180,
        from: CREATED_AT + 7 * 86_400_000,
        at: CREATED_AT + (kind === "set" ? 7 : 40) * 86_400_000,
        threads: 12,
        messages: 57,
        policiesUrl: "https://app.portifact.com/policies?workspace=acme",
      }),
    })),
    ...TRANSLATED.map((locale) => ({
      name: `comment-retention-set-${locale.toLowerCase()}`,
      email: commentRetentionNoticeEmail({
        kind: "set",
        days: 90,
        from: CREATED_AT + 7 * 86_400_000,
        at: CREATED_AT + 7 * 86_400_000,
        threads: 1,
        messages: 3,
        policiesUrl: "https://app.portifact.com/policies?workspace=acme",
        locale,
      }),
    })),
    {
      name: "data-rights-notice",
      email: dataRightsNoticeEmail({
        kind: "erasure",
        artifactName: "Team retro board",
        visitorId: "v_7Hc2kQ9xLm4pRt1vWz8aBd",
        dataUrl: "https://app.portifact.com/artifacts/k7d2qm4xab",
      }),
    },
    {
      name: "data-rights-notice-without-names",
      email: dataRightsNoticeEmail({
        kind: "access",
        artifactName: null,
        visitorId: "v_7Hc2kQ9xLm4pRt1vWz8aBd",
        dataUrl: "https://app.portifact.com/artifacts/k7d2qm4xab?workspace=acme",
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `data-rights-notice-${locale.toLowerCase()}`,
      email: dataRightsNoticeEmail({
        kind: "erasure",
        artifactName: "Team retro board",
        visitorId: "v_7Hc2kQ9xLm4pRt1vWz8aBd",
        dataUrl: "https://app.portifact.com/artifacts/k7d2qm4xab",
        locale,
      }),
    })),
    ...TRANSLATED.map((locale) => ({
      name: `data-rights-notice-without-names-${locale.toLowerCase()}`,
      email: dataRightsNoticeEmail({
        kind: "access",
        artifactName: null,
        visitorId: "v_7Hc2kQ9xLm4pRt1vWz8aBd",
        dataUrl: "https://app.portifact.com/artifacts/k7d2qm4xab",
        locale,
      }),
    })),
    {
      name: "directory-notice",
      email: directoryNoticeEmail({
        workspaceName: "Analytical Engines",
        workspaceUrl: "https://app.portifact.com/?workspace=engines",
        membersUrl: "https://app.portifact.com/members?workspace=engines",
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `directory-notice-${locale.toLowerCase()}`,
      email: directoryNoticeEmail({
        workspaceName: "Analytical Engines",
        workspaceUrl: "https://app.portifact.com/?workspace=engines",
        membersUrl: "https://app.portifact.com/members?workspace=engines",
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
    ...TRANSLATED.map((locale) => ({
      name: `expiry-notice-without-names-${locale.toLowerCase()}`,
      email: expiryNoticeEmail({
        ...notice,
        ...withoutNames,
        locale,
        artifacts: [
          noticeArtifact("k7d2qm4xab", "Q3 launch plan", 50),
          noticeArtifact("p4n8rt2vcd", "Design review notes", 66),
        ],
      }),
    })),
    { name: "invitation", email: invitationEmail(invitation) },
    ...TRANSLATED.map((locale) => ({
      name: `invitation-${locale.toLowerCase()}`,
      email: invitationEmail({ ...invitation, locale }),
    })),
    { name: "grace-notice-start", email: graceNoticeEmail(grace) },
    {
      name: "grace-notice-two-weeks",
      email: graceNoticeEmail({ ...grace, moment: "two_weeks" }),
    },
    {
      name: "grace-notice-three-days",
      email: graceNoticeEmail({ ...grace, moment: "three_days" }),
    },
    {
      name: "grace-notice-personal",
      email: graceNoticeEmail({
        ...grace,
        plan: "Pro",
        workspace: null,
        kinds: [{ kind: "versions", count: 12, from: graceEnd }],
        downloadUrl: "https://app.portifact.com/data",
        exportCommand: "portifact export ./portifact-export",
        requestUrl: "mailto:hello@portifact.com?subject=Portifact%20Pro%20plan%20request",
      }),
    },
    { name: "grace-notice-without-names", email: graceNoticeEmail(graceWithoutNames) },
    ...TRANSLATED.map((locale) => ({
      name: `grace-notice-${locale.toLowerCase()}`,
      email: graceNoticeEmail({ ...grace, moment: "two_weeks", locale }),
    })),
    ...TRANSLATED.map((locale) => ({
      name: `grace-notice-without-names-${locale.toLowerCase()}`,
      email: graceNoticeEmail({ ...graceWithoutNames, moment: "three_days", locale }),
    })),
    { name: "review-requested", email: reviewNoticeEmail({ ...review, kind: "requested" }) },
    { name: "review-approved", email: reviewNoticeEmail({ ...review, kind: "approved" }) },
    {
      name: "review-changes-requested",
      email: reviewNoticeEmail({ ...review, kind: "changes_requested" }),
    },
    {
      name: "review-requested-without-names",
      email: reviewNoticeEmail({ ...review, kind: "requested", names: false }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `review-requested-${locale.toLowerCase()}`,
      email: reviewNoticeEmail({ ...review, kind: "requested", locale }),
    })),
    { name: "moderation-artifact-suspended", email: moderationNoticeEmail(suspension) },
    {
      name: "moderation-artifact-suspended-without-names",
      email: moderationNoticeEmail({ ...suspension, artifactName: null }),
    },
    {
      name: "moderation-account-suspended",
      email: moderationNoticeEmail({ ...suspension, target: "account", source: "review" }),
    },
    {
      name: "moderation-brand-suspended",
      email: moderationNoticeEmail({ ...suspension, target: "brand", reason: "impersonation" }),
    },
    {
      name: "moderation-artifact-reinstated",
      email: moderationNoticeEmail({
        ...suspension,
        action: "reinstate",
        facts: "The owner removed the page and asked for a review.",
        ground: null,
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `moderation-artifact-suspended-${locale.toLowerCase()}`,
      email: moderationNoticeEmail({ ...suspension, locale }),
    })),
    {
      name: "report-outcome-actioned",
      email: reportOutcomeEmail({
        outcome: "actioned",
        artifactOrigin: "https://k7d2qm4xab.portifact.dev",
        reportedAt: CREATED_AT,
      }),
    },
    {
      name: "report-outcome-dismissed",
      email: reportOutcomeEmail({
        outcome: "dismissed",
        artifactOrigin: "https://k7d2qm4xab.portifact.dev",
        reportedAt: CREATED_AT,
      }),
    },
    ...TRANSLATED.map((locale) => ({
      name: `report-outcome-${locale.toLowerCase()}`,
      email: reportOutcomeEmail({
        outcome: "actioned",
        artifactOrigin: "https://k7d2qm4xab.portifact.dev",
        reportedAt: CREATED_AT,
        locale,
      }),
    })),
  ];
}
