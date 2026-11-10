// A space's open feedback (premium plan T9): the open threads of every artifact of the caller's
// personal space or of a workspace, newest activity first, in one call (`GET /api/v1/feedback`,
// MCP `list_open_feedback`, `portifact feedback`). Each item carries the thread exactly as the
// per-artifact list returns it. Bodies, quotes and author names are untrusted data written by
// reviewers.
import { z } from "zod";
import {
  AnnotationRole,
  AnnotationThreadView,
  UNTRUSTED_ANNOTATIONS_NOTICE,
} from "./annotations.ts";
import { ArtifactId, ArtifactType } from "./core.ts";
import { FEEDBACK_LIMITS } from "./limits.ts";
import { OwnerView, WorkspaceSlug } from "./workspaces.ts";

/** The opaque cursor: the sort key of the last item of a page. */
const FeedbackCursor = z.string().max(128);

const limit = z
  .number()
  .int()
  .min(1)
  .max(FEEDBACK_LIMITS.pageMax)
  .default(FEEDBACK_LIMITS.pageDefault);

/** `GET /api/v1/feedback`; the space is `?workspace=<slug>` like the artifact list. */
export const FeedbackQuery = z.object({
  cursor: FeedbackCursor.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(FEEDBACK_LIMITS.pageMax)
    .default(FEEDBACK_LIMITS.pageDefault),
  /** Only threads with activity after this time. */
  since: z.iso.datetime({ offset: true }).optional(),
  /** `true`: only threads the caller wrote in, or on artifacts the caller published. */
  mine: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type FeedbackQuery = z.infer<typeof FeedbackQuery>;

/** The MCP tool's input: the same filters, with the space as an argument. */
export const ListOpenFeedbackInput = z.object({
  workspace: WorkspaceSlug.optional().describe(
    "The slug of a workspace from list_workspaces to read that workspace's feedback. Omit it for the user's personal space.",
  ),
  cursor: FeedbackCursor.optional().describe(
    "The nextCursor of the previous page. Omit it for the first page.",
  ),
  limit: limit.describe(`How many threads to return, 1 to ${FEEDBACK_LIMITS.pageMax}.`),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Only threads with activity after this ISO 8601 time."),
  mine: z
    .boolean()
    .optional()
    .describe(
      "true: only threads the user wrote in, or on artifacts the user published. Omit it for every open thread the user may see.",
    ),
});
export type ListOpenFeedbackInput = z.infer<typeof ListOpenFeedbackInput>;

/** The artifact a thread is on, as the artifact views name it. */
export const FeedbackArtifact = z.object({
  id: ArtifactId,
  name: z.string(),
  type: ArtifactType,
  url: z.url(),
});
export type FeedbackArtifact = z.infer<typeof FeedbackArtifact>;

export const FeedbackItem = z.object({
  artifact: FeedbackArtifact,
  /** The same shape as one thread of `GET /api/v1/artifacts/:id/annotations`. */
  thread: AnnotationThreadView,
  counts: z.object({
    /** Messages of the thread that are not deleted. */
    messages: z.number().int().nonnegative(),
    /**
     * Open threads on the same artifact that match the same filters and that the caller sees;
     * threads they do not see are never counted.
     */
    artifactOpenThreads: z.number().int().nonnegative(),
  }),
});
export type FeedbackItem = z.infer<typeof FeedbackItem>;

export const FeedbackPage = z.object({
  notice: z.literal(UNTRUSTED_ANNOTATIONS_NOTICE),
  /** The space read. */
  owner: OwnerView,
  /**
   * `owner` when the caller acts for the space (its user, or a workspace's admin or editor) and
   * sees every thread; `participant` for a workspace member, who sees what each artifact's access
   * and comment visibility allow them.
   */
  role: AnnotationRole,
  items: z.array(FeedbackItem),
  nextCursor: FeedbackCursor.nullable(),
});
export type FeedbackPage = z.infer<typeof FeedbackPage>;
