// Abuse reports, operator suspensions and the account's own export and deletion (plan sections
// 5 and 13). Report text and the reporter's email are untrusted input from anyone on the web.
import { z } from "zod";
import { ArtifactId, Email } from "./core.ts";

/** Categories of the Acceptable Use Policy, used by reports and by suspensions. */
export const AbuseReason = z.enum([
  "phishing",
  "malware",
  "sexual_content",
  "child_safety",
  "copyright",
  "impersonation",
  "harassment",
  "private_information",
  "spam",
  "other",
]);
export type AbuseReason = z.infer<typeof AbuseReason>;

export const REPORT_LIMITS = {
  /** Code points of the free-text details. */
  detailsMax: 2_000,
  /** Bytes of the whole request body. */
  bodyMaxBytes: 8_192,
  perIp: { max: 10, windowSeconds: 3_600 },
  perArtifact: { max: 50, windowSeconds: 86_400 },
  global: { max: 1_000, windowSeconds: 86_400 },
} as const;

/** Control characters other than tab and line breaks are refused in report text. */
const hasControl = (value: string) => /\p{Cc}/u.test(value.replace(/[\t\n\r]/g, ""));

/** What the public report form sends. The artifact may be given as its ID or its address. */
export const AbuseReportInput = z
  .object({
    artifact: z.string().trim().min(1).max(300),
    reason: AbuseReason,
    details: z
      .string()
      .trim()
      .max(REPORT_LIMITS.detailsMax * 2)
      .refine((value) => [...value].length <= REPORT_LIMITS.detailsMax, {
        message: `Details can be at most ${REPORT_LIMITS.detailsMax} characters.`,
      })
      .refine((value) => !hasControl(value), { message: "Details hold control characters." })
      .optional(),
    email: z.union([Email, z.literal("")]).optional(),
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

/** Why the owner sees an artifact suspended. The operator's notes are never included. */
export const SuspensionView = z.object({
  reason: AbuseReason,
});
export type SuspensionView = z.infer<typeof SuspensionView>;

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

export const ExportArtifact = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["site", "markdown", "text"]),
  state: z.string(),
  accessMode: z.enum(["public", "authenticated", "restricted"]),
  readers: z.array(z.string()),
  annotations: z.enum(["off", "open", "locked"]),
  indexable: z.boolean(),
  embeddable: z.boolean(),
  suspension: SuspensionView.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  expiresAt: IsoOrNull,
  archivedAt: IsoOrNull,
  purgeAt: IsoOrNull,
  versions: z.array(ExportVersion),
  threads: z.array(ExportThread),
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
    signInMethods: z.array(z.object({ provider: z.string(), connectedAt: Iso })),
  }),
  artifacts: z.array(ExportArtifact),
  /** Threads on other people's artifacts where the account wrote, with only its own messages. */
  commentsElsewhere: z.array(ExportThread),
});
export type AccountExport = z.infer<typeof AccountExport>;
