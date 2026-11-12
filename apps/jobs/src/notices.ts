// The notice senders of the jobs Worker (docs/operations.md, "Expiry notices" and "Comment
// notices"): they render the emails with packages/emails in the recipient's language (English when
// they chose none) and send them through Cloudflare Email Service. Each is built for the region its
// job runs in (`JobMessage.region`), and what it may say about the owner's artifacts is decided
// only by `noticeDetail` in packages/domain (decision 0005): outside the default region, counts and
// links, never names. Expiry notices link each
// artifact, its page in the dashboard to renew it and the settings (or, without names, the
// dashboard's list of the space's artifacts expiring soon); comment and review notices link
// the artifact in the viewer, the settings and a signed one-click unsubscribe link (the same one:
// one setting covers both), also offered to mail clients through the `List-Unsubscribe` headers
// (RFC 8058).
import {
  DEFAULT_REGION,
  LIMITS,
  PLAN_LABELS,
  planRequestHref,
  WorkspaceSlug,
} from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import type { Region } from "@portifact/db";
import { noticeNames } from "@portifact/domain";
import {
  commentNoticeEmail,
  commentRetentionNoticeEmail,
  directoryNoticeEmail,
  domainNoticeEmail,
  expiryNoticeEmail,
  graceNoticeEmail,
  moderationNoticeEmail,
  reportOutcomeEmail,
  retentionNoticeEmail,
  reviewNoticeEmail,
} from "@portifact/emails";
import {
  type CommentNotifier,
  type CommentRetentionNotifier,
  type DirectoryNotifier,
  type DomainNotifier,
  type ExpiringArtifact,
  type ExpiryNotifier,
  type GraceNotifier,
  isRecipientSuppressed,
  type ModerationNotifier,
  type NoticeArtifact,
  RecipientSuppressedError,
  type ReportOutcomeNotifier,
  type RetentionNotifier,
  type ReviewNotifier,
  signUnsubscribeToken,
} from "@portifact/services";

export interface NoticeEnv {
  /** Cloudflare Email Service (`send_email`), sending from `noreply@portifact.com`. */
  EMAIL: SendEmail;
  /** The dashboard's origin, `https://app.portifact.com`. */
  APP_ORIGIN: string;
  /** The artifacts' domain, `portifact.dev`. */
  CONTENT_DOMAIN: string;
  /**
   * Signs the unsubscribe links of comment notices; the app Worker checks them with the same
   * secret. Without it comment notices are not sent (their jobs fail and wait).
   */
  UNSUBSCRIBE_SECRET?: string | undefined;
}

export const NOTICE_SENDER = { email: "noreply@portifact.com", name: "Portifact" } as const;

/** The email of one notice, with the environment's addresses. */
export function noticeEmail(
  env: Pick<NoticeEnv, "APP_ORIGIN" | "CONTENT_DOMAIN">,
  artifacts: ExpiringArtifact[],
  locale: LocaleCode | null = null,
  archiveMonths: number = LIMITS.archiveMonths,
  /** The artifacts' region: outside the default one, names stay out (decision 0005). */
  region: Region = DEFAULT_REGION,
  /** The workspace's slug, for the list the notice links without names; null when personal. */
  space: string | null = null,
) {
  const shown = noticeNames(region)
    ? { names: true as const }
    : { names: false as const, listUrl: expiringListUrl(env.APP_ORIGIN, space) };
  return expiryNoticeEmail({
    ...shown,
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      url: `https://${artifact.id}.${env.CONTENT_DOMAIN}/`,
      renewUrl: `${env.APP_ORIGIN}/artifacts/${artifact.id}`,
      expiresAt: artifact.expiresAt,
    })),
    settingsUrl: `${env.APP_ORIGIN}/settings`,
    activeDays: LIMITS.activeDays,
    archiveMonths,
    locale: locale ?? undefined,
  });
}

/** The dashboard's list of a space's active artifacts expiring soon (`expiring=soon`). */
export function expiringListUrl(appOrigin: string, space: string | null): string {
  const query = new URLSearchParams();
  if (space !== null) query.set("workspace", space);
  query.set("expiring", "soon");
  return `${appOrigin}/?${query}`;
}

export function expiryNotifierFromEnv(
  env: NoticeEnv,
  region: Region = DEFAULT_REGION,
): ExpiryNotifier {
  return {
    async send({ to, artifacts, locale, archiveMonths, space }) {
      try {
        await env.EMAIL.send({
          from: NOTICE_SENDER,
          to,
          ...noticeEmail(env, artifacts, locale, archiveMonths, region, space),
        });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/** The unsubscribe page and the one-click endpoint mail clients post to (RFC 8058). */
export function unsubscribeUrls(appOrigin: string, token: string) {
  const query = `token=${encodeURIComponent(token)}`;
  return {
    page: `${appOrigin}/unsubscribe?${query}`,
    oneClick: `${appOrigin}/api/v1/notices/unsubscribe?${query}`,
  };
}

/** The email of one comment notice, with the environment's addresses and a signed link. */
export function commentEmail(
  env: Pick<NoticeEnv, "APP_ORIGIN">,
  notice: { artifacts: NoticeArtifact[]; more: number; locale: LocaleCode | null },
  token: string,
  /** The artifacts' region: outside the default one, names stay out (decision 0005). */
  region: Region = DEFAULT_REGION,
) {
  const urls = unsubscribeUrls(env.APP_ORIGIN, token);
  const email = commentNoticeEmail({
    artifacts: notice.artifacts.map((artifact) => ({
      name: artifact.name,
      url: `${env.APP_ORIGIN}/view/${artifact.artifactId}`,
      newThreads: artifact.newThreads,
      newReplies: artifact.newReplies,
      resolvedThreads: artifact.resolvedThreads,
    })),
    more: notice.more,
    settingsUrl: `${env.APP_ORIGIN}/settings`,
    unsubscribeUrl: urls.page,
    names: noticeNames(region),
    locale: notice.locale ?? undefined,
  });
  return {
    ...email,
    headers: {
      "List-Unsubscribe": `<${urls.oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export function commentNotifierFromEnv(
  env: NoticeEnv,
  region: Region = DEFAULT_REGION,
): CommentNotifier {
  return {
    async send({ to, userId, issuedAt, artifacts, more, locale }) {
      const secret = env.UNSUBSCRIBE_SECRET;
      // Thrown before sending: the job goes back to the outbox until the secret is set.
      if (!secret) throw new Error("comment notices need UNSUBSCRIBE_SECRET");
      const token = await signUnsubscribeToken(secret, userId, issuedAt);
      const email = commentEmail(env, { artifacts, more, locale }, token, region);
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...email });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

type ReviewNotice = Parameters<ReviewNotifier["send"]>[0];

/**
 * The email of one review notice (decision 0013, "Emails"), with the environment's addresses and
 * the same signed unsubscribe link as comment notices: one setting covers both.
 */
export function reviewEmail(
  env: Pick<NoticeEnv, "APP_ORIGIN">,
  notice: Omit<ReviewNotice, "to" | "userId" | "issuedAt">,
  token: string,
  /** The artifact's region: outside the default one, its name stays out (decision 0005). */
  region: Region = DEFAULT_REGION,
) {
  const urls = unsubscribeUrls(env.APP_ORIGIN, token);
  const email = reviewNoticeEmail({
    kind: notice.kind === "requested" ? "requested" : (notice.status ?? "approved"),
    name: notice.name,
    version: notice.version,
    url: `${env.APP_ORIGIN}/view/${notice.artifactId}`,
    settingsUrl: `${env.APP_ORIGIN}/settings`,
    unsubscribeUrl: urls.page,
    names: noticeNames(region),
    locale: notice.locale ?? undefined,
  });
  return {
    ...email,
    headers: {
      "List-Unsubscribe": `<${urls.oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export function reviewNotifierFromEnv(
  env: NoticeEnv,
  region: Region = DEFAULT_REGION,
): ReviewNotifier {
  return {
    async send({ to, userId, issuedAt, ...notice }) {
      const secret = env.UNSUBSCRIBE_SECRET;
      // Thrown before sending: the job goes back to the outbox until the secret is set.
      if (!secret) throw new Error("review notices need UNSUBSCRIBE_SECRET");
      const token = await signUnsubscribeToken(secret, userId, issuedAt);
      try {
        await env.EMAIL.send({
          from: NOTICE_SENDER,
          to,
          ...reviewEmail(env, notice, token, region),
        });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/**
 * The notice of being added to a workspace by its directory (decision 0017), linking the
 * workspace and its Members page, where the person can leave.
 */
export function directoryNotifierFromEnv(
  env: Pick<NoticeEnv, "EMAIL" | "APP_ORIGIN">,
): DirectoryNotifier {
  return {
    async send({ to, workspaceName, workspaceSlug, locale }) {
      const space = `workspace=${encodeURIComponent(workspaceSlug)}`;
      const email = directoryNoticeEmail({
        workspaceName,
        workspaceUrl: `${env.APP_ORIGIN}/?${space}`,
        membersUrl: `${env.APP_ORIGIN}/members?${space}`,
        locale: locale ?? undefined,
      });
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...email });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/** The downgrade notice of custom domains, linking the dashboard's usage page (decision 0006). */
export function domainNotifierFromEnv(
  env: Pick<NoticeEnv, "EMAIL" | "APP_ORIGIN">,
): DomainNotifier {
  return {
    async send({ to, hostnames, detachAt, limit, locale }) {
      const email = domainNoticeEmail({
        hostnames,
        detachAt,
        limit,
        usageUrl: `${env.APP_ORIGIN}/usage`,
        locale: locale ?? undefined,
      });
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...email });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

type GraceNotice = Parameters<GraceNotifier["send"]>[0];

/**
 * The grace email (decision 0022, third delivery), with the environment's addresses: the space's
 * "Download your data" page, the `portifact export` command for it and the plan request. It names
 * the workspace only in the default region (decision 0005). A service notice: no unsubscribe
 * link or `List-Unsubscribe` header, since it announces the deletion of the recipient's data.
 */
export function graceEmail(
  env: Pick<NoticeEnv, "APP_ORIGIN">,
  notice: Omit<GraceNotice, "to">,
  /** The owner's region: outside the default one, the workspace stays unnamed. */
  region: Region = DEFAULT_REGION,
) {
  // Checked again here, since it goes into a shell command the reader may copy.
  const slug = notice.space ? (WorkspaceSlug.safeParse(notice.space.slug).data ?? "<slug>") : null;
  const query = slug === null ? "" : `?workspace=${encodeURIComponent(slug)}`;
  return graceNoticeEmail({
    moment: notice.moment,
    until: notice.until,
    plan: PLAN_LABELS[notice.plan],
    kinds: notice.kinds,
    workspace: notice.space?.name ?? null,
    names: noticeNames(region),
    downloadUrl: `${env.APP_ORIGIN}/data${query}`,
    exportCommand:
      slug === null
        ? "portifact export ./portifact-export"
        : `portifact export ./portifact-export --workspace ${slug}`,
    requestUrl: planRequestHref(notice.plan),
    locale: notice.locale ?? undefined,
  });
}

export function graceNotifierFromEnv(
  env: Pick<NoticeEnv, "EMAIL" | "APP_ORIGIN">,
  region: Region = DEFAULT_REGION,
): GraceNotifier {
  return {
    async send({ to, ...notice }) {
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...graceEmail(env, notice, region) });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/**
 * The admins' notice of a workspace's maximum life of artifacts (decision 0023), linking the
 * workspace's Policies page. Counts, days and a date only, so it is the same in every region.
 */
export function retentionNotifierFromEnv(
  env: Pick<NoticeEnv, "EMAIL" | "APP_ORIGIN">,
): RetentionNotifier {
  return {
    async send({ to, workspaceSlug, days, from, atStart, soon, locale }) {
      const email = retentionNoticeEmail({
        days,
        from,
        atStart,
        soon,
        policiesUrl: `${env.APP_ORIGIN}/policies?workspace=${encodeURIComponent(workspaceSlug)}`,
        locale: locale ?? undefined,
      });
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...email });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/**
 * The admins' notices of a workspace's comment retention (decision 0023), linking its Policies
 * page. Counts, days and dates only, so they are the same in every region.
 */
export function commentRetentionNotifierFromEnv(
  env: Pick<NoticeEnv, "EMAIL" | "APP_ORIGIN">,
): CommentRetentionNotifier {
  return {
    async send({ to, workspaceSlug, kind, days, from, at, threads, messages, locale }) {
      const email = commentRetentionNoticeEmail({
        kind,
        days,
        from,
        at,
        threads,
        messages,
        policiesUrl: `${env.APP_ORIGIN}/policies?workspace=${encodeURIComponent(workspaceSlug)}`,
        locale: locale ?? undefined,
      });
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...email });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/**
 * The statement of reasons (docs/operations.md, "Reports"), linking the dashboard where the
 * recipient sees it: the artifact's page, the Branding page or Settings, in the workspace's space.
 * The artifact's name only in the default region (decision 0005); the operator's facts and ground
 * are written for the region they go to. A service notice: no unsubscribe link.
 */
export function moderationNotifierFromEnv(
  env: Pick<NoticeEnv, "EMAIL" | "APP_ORIGIN">,
  region: Region,
): ModerationNotifier {
  return {
    async send(notice) {
      const space = notice.workspaceSlug
        ? `?workspace=${encodeURIComponent(notice.workspaceSlug)}`
        : "";
      const page =
        notice.target === "artifact"
          ? `/artifacts/${encodeURIComponent(notice.artifactId ?? "")}`
          : notice.target === "brand"
            ? "/branding"
            : "/settings";
      const email = moderationNoticeEmail({
        action: notice.action,
        target: notice.target,
        artifactId: notice.artifactId ?? undefined,
        artifactName: noticeNames(region) ? notice.artifactName : null,
        reason: notice.reason,
        source: notice.source,
        facts: notice.facts,
        ground: notice.ground,
        decidedAt: notice.decidedAt,
        dashboardUrl: `${env.APP_ORIGIN}${page}${space}`,
        locale: notice.locale ?? undefined,
      });
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to: notice.to, ...email });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}

/**
 * The outcome of a report, to the address the reporter gave: the artifact's own origin and the
 * date, never who manages the content, the path or anything the reporter typed.
 */
export function reportOutcomeNotifierFromEnv(
  env: Pick<NoticeEnv, "EMAIL" | "CONTENT_DOMAIN">,
): ReportOutcomeNotifier {
  return {
    async send(notice) {
      const email = reportOutcomeEmail({
        outcome: notice.outcome,
        artifactOrigin: `https://${notice.artifactId}.${env.CONTENT_DOMAIN}`,
        reportedAt: notice.reportedAt,
        locale: notice.locale ?? undefined,
      });
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to: notice.to, ...email });
      } catch (error) {
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}
