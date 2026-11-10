// The notice senders of the jobs Worker (docs/operations.md, "Expiry notices" and "Comment
// notices"): they render the emails with packages/emails in the recipient's language (English when
// they chose none) and send them through Cloudflare Email Service. Expiry notices link each
// artifact, its page in the dashboard to renew it and the settings; comment notices link each
// artifact's comments in the viewer, the settings and a signed one-click unsubscribe link, also
// offered to mail clients through the `List-Unsubscribe` headers (RFC 8058).
import { LIMITS } from "@portifact/contracts";
import type { LocaleCode } from "@portifact/contracts/locales";
import { commentNoticeEmail, expiryNoticeEmail } from "@portifact/emails";
import {
  type CommentNotifier,
  type ExpiringArtifact,
  type ExpiryNotifier,
  isRecipientSuppressed,
  type NoticeArtifact,
  RecipientSuppressedError,
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
) {
  return expiryNoticeEmail({
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      url: `https://${artifact.id}.${env.CONTENT_DOMAIN}/`,
      renewUrl: `${env.APP_ORIGIN}/artifacts/${artifact.id}`,
      expiresAt: artifact.expiresAt,
    })),
    settingsUrl: `${env.APP_ORIGIN}/settings`,
    activeDays: LIMITS.activeDays,
    archiveMonths: LIMITS.archiveMonths,
    locale: locale ?? undefined,
  });
}

export function expiryNotifierFromEnv(env: NoticeEnv): ExpiryNotifier {
  return {
    async send({ to, artifacts, locale }) {
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...noticeEmail(env, artifacts, locale) });
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
    // Every artifact is stored in the one global region today (decision 0005); an EU workspace
    // will send its notices without names.
    names: true,
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

export function commentNotifierFromEnv(env: NoticeEnv): CommentNotifier {
  return {
    async send({ to, userId, issuedAt, artifacts, more, locale }) {
      const secret = env.UNSUBSCRIBE_SECRET;
      // Thrown before sending: the job goes back to the outbox until the secret is set.
      if (!secret) throw new Error("comment notices need UNSUBSCRIBE_SECRET");
      const token = await signUnsubscribeToken(secret, userId, issuedAt);
      const email = commentEmail(env, { artifacts, more, locale }, token);
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
