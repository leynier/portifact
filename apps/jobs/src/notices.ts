// The expiry notice sender of the jobs Worker (docs/operations.md, "Expiry notices"): renders the
// email with packages/emails, with links to each artifact, its page in the dashboard to renew it
// and the settings page to turn the notices off, and sends it through Cloudflare Email Service.
import { LIMITS } from "@portifact/contracts";
import { expiryNoticeEmail } from "@portifact/emails";
import {
  type ExpiringArtifact,
  type ExpiryNotifier,
  isRecipientSuppressed,
  RecipientSuppressedError,
} from "@portifact/services";

export interface NoticeEnv {
  /** Cloudflare Email Service (`send_email`), sending from `noreply@portifact.com`. */
  EMAIL: SendEmail;
  /** The dashboard's origin, `https://app.portifact.com`. */
  APP_ORIGIN: string;
  /** The artifacts' domain, `portifact.dev`. */
  CONTENT_DOMAIN: string;
}

export const NOTICE_SENDER = { email: "noreply@portifact.com", name: "Portifact" } as const;

/** The email of one notice, with the environment's addresses. */
export function noticeEmail(
  env: Pick<NoticeEnv, "APP_ORIGIN" | "CONTENT_DOMAIN">,
  artifacts: ExpiringArtifact[],
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
  });
}

export function expiryNotifierFromEnv(env: NoticeEnv): ExpiryNotifier {
  return {
    async send({ to, artifacts }) {
      try {
        await env.EMAIL.send({ from: NOTICE_SENDER, to, ...noticeEmail(env, artifacts) });
      } catch (error) {
        // The provider error can echo the message and the address; nothing downstream logs it.
        if (isRecipientSuppressed(error)) throw new RecipientSuppressedError();
        throw new Error("email delivery failed");
      }
    },
  };
}
