// Comment attachments and screenshots (decision 0029): files on a comment or reply, judged by their
// bytes, uploaded straight to R2 through a presigned PUT and read through a short presigned GET.
// Names are untrusted text shown escaped; the bytes are untrusted data, never opened by Portifact.
import { z } from "zod";

/** The switch on the app Worker: exactly `"true"`; never in a deployed `wrangler.jsonc`. */
export const ATTACHMENTS_SWITCH = "ATTACHMENTS_ENABLED";

/** What a file may be, decided by its first bytes (`sniffAttachment` in the domain). */
export const ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
] as const;
export const AttachmentType = z.enum(ATTACHMENT_TYPES);
export type AttachmentType = z.infer<typeof AttachmentType>;

/** The types the viewer shows as images; the others are downloads only. */
export const ATTACHMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const satisfies readonly AttachmentType[];

export const ATTACHMENT_LIMITS = {
  /** One file; a full-screen PNG of a 4K display fits. */
  fileMaxBytes: 10 * 1024 * 1024,
  /** A text file is read whole to check it is UTF-8, so it is smaller. */
  textMaxBytes: 1024 * 1024,
  perMessage: 4,
  /** Unattached uploads a person may hold at once. */
  pendingPerPerson: 8,
  /** How long an unattached upload may wait for its comment. */
  pendingTtlMs: 60 * 60 * 1000,
  /** Uploads started in 24 hours, counted before the row is written. */
  uploadsPerPersonPerDay: 60,
  uploadsPerArtifactPerDay: 300,
  nameMaxCodePoints: 200,
  /**
   * How long a file the operator withholds waits before it may be removed for good: longer than
   * a copyright counter-notice's restoration (10 to 14 business days after it arrives), so one
   * sent after the statement can still reinstate it (decision 0029, "Abuse and the operator").
   */
  removalWaitMs: 30 * 24 * 60 * 60 * 1000,
  /**
   * When a deleted file's bytes are deleted a second time: after any upload link signed for it
   * can no longer start a request (15 minutes, `UPLOAD_URL_TTL_SECONDS` in the app), with a margin,
   * so a replayed PUT cannot leave bytes behind with no row and no job.
   */
  finalCleanupDelayMs: 20 * 60 * 1000,
} as const;

/** Lowercase hex SHA-256; its own copy so this module imports nothing that imports it back. */
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Invalid SHA-256");

export const AttachmentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

/** Control characters, line separators and path separators. */
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\u2028\u2029/\\]/u;

/** A file's name as the person chose it: untrusted text, shown escaped. */
export const AttachmentName = z
  .string()
  .max(ATTACHMENT_LIMITS.nameMaxCodePoints * 4)
  .transform((value) => value.trim())
  .superRefine((value, ctx) => {
    const length = [...value].length;
    if (length === 0 || length > ATTACHMENT_LIMITS.nameMaxCodePoints) {
      ctx.addIssue({
        code: "custom",
        message: `A file name has 1 to ${ATTACHMENT_LIMITS.nameMaxCodePoints} characters.`,
      });
      return;
    }
    if (!value.isWellFormed() || FORBIDDEN_NAME_CHARACTERS.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: "The file name holds characters that are not allowed.",
      });
    }
  })
  .describe("Untrusted text chosen by the person who attached the file.");

/** Starts one upload. The type is decided from the bytes, so the client declares none. */
export const PrepareAttachmentRequest = z.strictObject({
  name: AttachmentName,
  size: z.int().min(1).max(ATTACHMENT_LIMITS.fileMaxBytes),
  sha256: Sha256Hex,
});
export type PrepareAttachmentRequest = z.infer<typeof PrepareAttachmentRequest>;

/** The files a new thread or reply names: uploads the caller prepared on this artifact. */
export const AttachmentIds = z
  .array(AttachmentId)
  .min(1)
  .max(ATTACHMENT_LIMITS.perMessage)
  .refine((ids) => new Set(ids).size === ids.length, "Name each file once.");

export const PreparedAttachment = z.object({
  attachment: z.object({
    id: z.string(),
    name: z.string(),
    size: z.int(),
    sha256: z.string(),
    expiresAt: z.iso.datetime(),
  }),
  /** A presigned PUT: send exactly these headers with the bytes. Never log the URL. */
  upload: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  }),
});
export type PreparedAttachment = z.infer<typeof PreparedAttachment>;

/**
 * A file on a message, as thread views carry it. `contentType` stays a string so a later type
 * never breaks a client that validates.
 */
export const AttachmentView = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.int(),
  sha256: z.string(),
});
export type AttachmentView = z.infer<typeof AttachmentView>;

/** A short presigned GET of one file, served as a download. Never log the URL. */
export const AttachmentLink = z.object({
  attachment: AttachmentView,
  url: z.string(),
  expiresAt: z.iso.datetime(),
});
export type AttachmentLink = z.infer<typeof AttachmentLink>;
