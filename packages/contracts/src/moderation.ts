// Abuse reports, operator suspensions and the account's own export and deletion (plan sections
// 5 and 13). Report text and the reporter's email are untrusted input from anyone on the web.

import { z } from "zod";
import { AbuseReason, SuspensionStatement } from "./moderation-core.ts";

export { AbuseReason, DecisionSource, SuspensionStatement } from "./moderation-core.ts";

import { AccountSettings, Locale } from "./account.ts";
import { AuditEventView } from "./audit.ts";
import { Brand } from "./branding.ts";
import { AccessMode, ArtifactId, Email } from "./core.ts";
import { PlanView } from "./plans.ts";
import { ServiceTokenView } from "./service-tokens.ts";

export const REPORT_LIMITS = {
  /** Code points of the free-text explanation. */
  detailsMax: 8_000,
  /** Characters of the reported address or ID, kept in full. */
  addressMax: 2_048,
  /** Code points of the reporter's name. */
  nameMax: 200,
  /** Bytes of the whole request body: the explanation at four bytes a code point, and the rest. */
  bodyMaxBytes: 49_152,
  perIp: { max: 10, windowSeconds: 3_600 },
  /**
   * Outcome emails to one reporter address a day: the address is not verified, so the form must
   * not become a way to mail someone repeatedly.
   */
  outcomeEmailsPerRecipient: { max: 3, windowSeconds: 86_400 },
  perArtifact: { max: 50, windowSeconds: 86_400 },
  global: { max: 1_000, windowSeconds: 86_400 },
} as const;

/** Control characters other than tab and line breaks are refused in report text. */
const hasControl = (value: string) => /\p{Cc}/u.test(value.replace(/[\t\n\r]/g, ""));

/** Free text of a report: trimmed, bounded in code points, no control characters but line breaks. */
function reportText(max: number, label: string) {
  return z
    .string()
    .trim()
    .max(max * 2)
    .refine((value) => [...value].length <= max, {
      message: `${label} can be at most ${max} characters.`,
    })
    .refine((value) => !hasControl(value), { message: `${label} holds control characters.` });
}

/**
 * What the public report form sends. The artifact may be given as its ID or its exact address,
 * which is kept in full. `name` and `confirmed` make a full notice of illegal content: the
 * reporter's name (never asked for, and dropped, for child sexual abuse or exploitation) and the
 * statement that the information is accurate and complete and sent in good faith. Both are
 * optional for the API, so an older page still sends a report; the form requires the statement.
 * `locale` is the form's language, for the email that tells the reporter the outcome.
 */
export const AbuseReportInput = z
  .object({
    artifact: z.string().trim().min(1).max(REPORT_LIMITS.addressMax),
    reason: AbuseReason,
    details: reportText(REPORT_LIMITS.detailsMax, "Details").optional(),
    email: z.union([Email, z.literal("")]).optional(),
    name: reportText(REPORT_LIMITS.nameMax, "Name")
      .refine((value) => !/[\r\n]/.test(value), { message: "Name must be one line." })
      .optional(),
    confirmed: z.literal(true).optional(),
    locale: Locale.optional(),
  })
  .strict();
export type AbuseReportInput = z.infer<typeof AbuseReportInput>;

/**
 * The same answer whether or not the artifact exists, so the form cannot be used to probe for
 * private artifacts.
 */
export const AbuseReportReceipt = z.object({ received: z.literal(true) });
export type AbuseReportReceipt = z.infer<typeof AbuseReportReceipt>;

/**
 * The artifact ID in a report: a bare ID or the address of an artifact (`https://<id>.<domain>/...`).
 * Returns null for anything else.
 */
export function reportedArtifactId(value: string, contentDomain: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (ArtifactId.safeParse(trimmed).success) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const suffix = `.${contentDomain.toLowerCase()}`;
  if (!url.hostname.endsWith(suffix)) return null;
  const label = url.hostname.slice(0, -suffix.length);
  return ArtifactId.safeParse(label).success ? label : null;
}

/**
 * The exact address a report names, kept in full (its path, query and fragment) when its host is
 * an artifact's host on the content domain (`<id>.<domain>`) or the active custom host the caller
 * looked up for it: https or http, no credentials, at most `REPORT_LIMITS.addressMax` characters.
 * Null for a bare ID or anything else.
 */
export function reportedAddress(
  value: string,
  contentDomain: string,
  customHost: { hostname: string; artifactId: string } | null = null,
): string | null {
  const trimmed = value.trim();
  if (!trimmed.includes("://") && ArtifactId.safeParse(trimmed.toLowerCase()).success) return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const suffix = `.${contentDomain.toLowerCase()}`;
  const onContentDomain =
    url.hostname.endsWith(suffix) &&
    ArtifactId.safeParse(url.hostname.slice(0, -suffix.length)).success;
  const onCustomHost = customHost !== null && url.hostname === customHost.hostname.toLowerCase();
  if (!onContentDomain && !onCustomHost) return null;
  return url.href.length <= REPORT_LIMITS.addressMax ? url.href : null;
}

/** The host of a reported address, lowercased, or null when it is not an address at all. */
export function reportedHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.includes("://") && ArtifactId.safeParse(trimmed.toLowerCase()).success) return null;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
}

/** Bounds of the operator's text in a statement of reasons (code points). */
export const STATEMENT_LIMITS = { factsMax: 2_000, groundMax: 500 } as const;

/**
 * The operator's part of a statement of reasons: the facts relied on and the ground (the law or
 * the rule of the terms). Plain text, shown as written and always escaped.
 */
export const StatementText = z.strictObject({
  facts: reportText(STATEMENT_LIMITS.factsMax, "Facts").pipe(z.string().min(1)),
  ground: reportText(STATEMENT_LIMITS.groundMax, "Ground").pipe(z.string().min(1)),
});
export type StatementText = z.infer<typeof StatementText>;

/** Why the owner sees an artifact suspended. The operator's notes are never included. */
export const SuspensionView = z.object({
  reason: AbuseReason,
  /**
   * The statement of reasons the operator recorded, or null when none was (a suspension from
   * before statements were recorded, or one whose explanation the law requires to withhold).
   * Only on the single artifact's view.
   */
  statement: SuspensionStatement.nullable().optional(),
});
export type SuspensionView = z.infer<typeof SuspensionView>;

/**
 * Whether the operator suspended the signed-in account, for its Settings page
 * (`GET /api/v1/account/suspension`, session only): the category, and the statement of reasons
 * unless it was withheld.
 */
export const AccountSuspensionView = z.strictObject({
  suspended: z.boolean(),
  reason: AbuseReason.nullable(),
  statement: SuspensionStatement.nullable(),
});
export type AccountSuspensionView = z.infer<typeof AccountSuspensionView>;

/** Deleting the account: the user types their email to confirm. */
export const AccountDeletionInput = z.object({ confirmEmail: z.string().max(254) }).strict();
export type AccountDeletionInput = z.infer<typeof AccountDeletionInput>;

export const AccountDeletionResult = z.object({ deleted: z.literal(true) });
export type AccountDeletionResult = z.infer<typeof AccountDeletionResult>;

/**
 * How long after signing in a session may delete the account. Older sessions must sign in
 * again, so a borrowed or stolen session cannot delete an account on its own.
 */
export const FRESH_SESSION_MS = 10 * 60 * 1000;

const Iso = z.iso.datetime();
const IsoOrNull = Iso.nullable();

export const ExportFile = z.object({
  kind: z.enum(["published", "source"]),
  path: z.string(),
  size: z.number().int().min(0),
  sha256: z.string(),
  contentType: z.string(),
});

export const ExportVersion = z.object({
  id: z.string(),
  number: z.number().int().min(1),
  current: z.boolean(),
  entrypoint: z.string(),
  committedAt: IsoOrNull,
  expiresAt: IsoOrNull,
  /** API path that returns short-lived download links for this version's files. */
  download: z.string(),
  files: z.array(ExportFile),
});

export const ExportMessage = z.object({
  id: z.string(),
  /** True when the account wrote it. Other people are never identified by email. */
  own: z.boolean(),
  authorName: z.string().nullable(),
  state: z.enum(["visible", "hidden", "deleted"]),
  body: z.string().nullable(),
  createdAt: Iso,
  editedAt: IsoOrNull,
});

export const ExportThread = z.object({
  id: z.string(),
  artifactId: z.string(),
  versionId: z.string(),
  path: z.string(),
  target: z.unknown(),
  state: z.enum(["open", "resolved"]),
  createdAt: Iso,
  messages: z.array(ExportMessage),
});

/** A share link of an exported artifact: never its token or the token's hash. */
export const ExportShareLink = z.strictObject({
  label: z.string(),
  state: z.enum(["active", "expired", "revoked"]),
  hasPassword: z.boolean(),
  createdAt: Iso,
  expiresAt: IsoOrNull,
});

/** A custom domain or pending claim of an exported artifact (decision 0006). */
export const ExportCustomDomain = z.strictObject({
  hostname: z.string(),
  state: z.enum(["pending", "provisioning", "active", "removing"]),
  verifiedAt: IsoOrNull,
});

export const ExportArtifact = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["site", "markdown", "text"]),
  state: z.string(),
  accessMode: AccessMode,
  readers: z.array(z.string()),
  annotations: z.enum(["off", "open", "locked"]),
  indexable: z.boolean(),
  embeddable: z.boolean(),
  bar: z.boolean(),
  pinned: z.boolean(),
  suspension: SuspensionView.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  expiresAt: IsoOrNull,
  archivedAt: IsoOrNull,
  purgeAt: IsoOrNull,
  versions: z.array(ExportVersion),
  threads: z.array(ExportThread),
  shareLinks: z.array(ExportShareLink),
  customDomains: z.array(ExportCustomDomain),
});

/** The account's data as JSON (plan section 5): offered before deletion, at any time. */
export const AccountExport = z.object({
  notice: z.string(),
  exportedAt: Iso,
  account: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    createdAt: Iso,
    termsVersion: z.string().nullable(),
    termsAcceptedAt: IsoOrNull,
    /**
     * Every version of the terms the account accepted, oldest first: when, and how (`sign_up`,
     * `sign_in`, `review` for "Agree and continue", `backfill` for the acceptance held when the
     * history started).
     */
    termsAcceptances: z.array(
      z.object({
        version: z.string(),
        acceptedAt: Iso,
        action: z.enum(["sign_up", "sign_in", "review", "backfill"]),
      }),
    ),
    signInMethods: z.array(z.object({ provider: z.string(), connectedAt: Iso })),
    /** The defaults for new artifacts, the built-in ones when the owner never changed them. */
    settings: AccountSettings,
    /** The account's plan as it applies at the export, `free` when it has none. */
    plan: PlanView,
    /** Artifacts whose comment notices the account muted. */
    commentNoticeMutes: z.array(z.string()),
    /** The account's webhooks (decision 0009): the host only, never the URL or the secret. */
    webhooks: z.array(
      z.object({
        id: z.string(),
        host: z.string(),
        format: z.enum(["generic", "slack", "discord"]),
        events: z.array(z.string()),
        disabled: z.boolean(),
        disabledReason: z.string().nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
    /**
     * The account's connections (decisions 0018 and 0025): the service, label, Jira site, identity
     * (a Slack workspace's name for Slack) and targets, never the credential (nor a Jira token's account email, sealed with it).
     */
    integrations: z.array(
      z.object({
        id: z.string(),
        service: z.enum(["github", "linear", "jira", "slack"]),
        label: z.string(),
        site: z.string().nullable(),
        identity: z.string(),
        targets: z.array(z.string()),
        createdAt: z.iso.datetime(),
      }),
    ),
    /**
     * The brand of the account's space for the viewer's bar, kept whatever the plan, or null.
     * The logo's bytes are on the Branding page; the export lists what it is.
     */
    brand: Brand.nullable(),
    /**
     * The personal space's audit log (premium plan T10) still kept, newest first. A workspace's
     * is for its admins on the Audit page, not in a member's export.
     */
    auditEvents: z.array(AuditEventView),
    /**
     * The service tokens of the workspaces the account administers (decision 0011): never the
     * secret or its hash.
     */
    serviceTokens: z.array(z.object({ workspace: z.string(), token: ServiceTokenView })),
  }),
  artifacts: z.array(ExportArtifact),
  /**
   * The workspaces the account is a member of, with its role; not their artifacts. For a
   * workspace the account is an admin of, its email domains (decision 0010), never their tokens.
   */
  workspaces: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      role: z.enum(["admin", "editor", "member"]),
      joinedAt: Iso,
      /** The groups the account is in there (decision 0014), never their other members. */
      groups: z.array(z.strictObject({ name: z.string(), addedAt: Iso })),
      domains: z
        .array(
          z.strictObject({
            domain: z.string(),
            state: z.enum(["pending", "verified"]),
            verifiedAt: IsoOrNull,
          }),
        )
        .optional(),
    }),
  ),
  /** Pending invitations addressed to the account's email. */
  invitations: z.array(
    z.object({
      workspace: z.object({ slug: z.string(), name: z.string() }),
      role: z.enum(["admin", "editor", "member"]),
      invitedBy: z.string().nullable(),
      expiresAt: Iso,
    }),
  ),
  /**
   * Threads on other people's artifacts where the account wrote, with only its own messages.
   * A thread the account no longer sees (the owner narrowed who sees comments) has no `state`
   * or `createdAt`: only where it points and the account's words.
   */
  commentsElsewhere: z.array(
    ExportThread.extend({ state: ExportThread.shape.state.optional(), createdAt: Iso.optional() }),
  ),
  /** Verdicts the account gave in approval reviews (decision 0013), with its notes. */
  reviewVerdicts: z.array(
    z.object({
      artifactId: z.string(),
      versionId: z.string(),
      verdict: z.enum(["approve", "changes"]),
      note: z.string().nullable(),
      decidedAt: Iso,
    }),
  ),
});
export type AccountExport = z.infer<typeof AccountExport>;
