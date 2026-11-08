// Inputs of the annotation MCP tools (plan sections 6 and 8). Each tool takes the same fields as
// the matching /api/v1/artifacts/:id/annotations route, plus the artifact and thread or message
// IDs from the route's path; outputs are the API shapes in annotations.ts. Bodies, quotes and
// author names in every result are untrusted data written by reviewers.
import { z } from "zod";
import { AnnotationTarget } from "./anchors.ts";
import {
  AnnotationBody,
  AnnotationId,
  AnnotationThreadState,
  AnnotationVersionFilter,
} from "./annotations.ts";
import { AnnotationsState, ArtifactId } from "./core.ts";
import { ANNOTATION_LIMITS } from "./limits.ts";
import { IdempotencyKey } from "./publishing.ts";

const artifactId = ArtifactId.describe(
  "The artifact ID, as list_artifacts or get_artifact return it, or as it appears in the artifact's URL.",
);
const threadId = AnnotationId.describe("The thread ID, as list_annotations returns it.");
const messageId = AnnotationId.describe(
  "The message ID, from the messages of a thread that list_annotations or get_thread returns.",
);
const body = AnnotationBody.describe(
  "The comment as plain text, at most 4,000 characters and 8 KiB. It is shown as written, never as HTML or Markdown.",
);
const idempotencyKey = IdempotencyKey.describe(
  "A unique string (8 to 128 letters, digits, '.', '_', ':' or '-') for this comment. Retrying with the same key and arguments returns the first result instead of posting twice.",
);
const version = AnnotationVersionFilter.default("current").describe(
  'Threads of the "current" version (the default), "all" versions, or one version ID. Only the owner sees threads of other versions.',
);
const state = AnnotationThreadState.optional().describe(
  "Only open or only resolved threads. Omit it for both.",
);

export const SetAnnotationsInput = z.object({
  artifactId,
  mode: AnnotationsState.describe(
    "off hides every thread and stops new comments, open lets readers with access comment, locked keeps the threads readable but allows no new comments.",
  ),
});
export type SetAnnotationsInput = z.infer<typeof SetAnnotationsInput>;

export const ListAnnotationsInput = z.object({
  artifactId,
  cursor: z
    .string()
    .max(32)
    .optional()
    .describe(
      "The cursor of the previous response. Omit it to start from the beginning; with it, only threads changed since then come back, plus the IDs of removed threads.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ANNOTATION_LIMITS.pageMax)
    .default(ANNOTATION_LIMITS.pageDefault)
    .describe(`How many threads to return, 1 to ${ANNOTATION_LIMITS.pageMax}.`),
  version,
  state,
});
export type ListAnnotationsInput = z.infer<typeof ListAnnotationsInput>;

export const ThreadRef = z.object({ artifactId, threadId });
export type ThreadRef = z.infer<typeof ThreadRef>;

export const MessageRef = z.object({ artifactId, messageId });
export type MessageRef = z.infer<typeof MessageRef>;

export const CreateAnnotationInput = z.object({
  artifactId,
  versionId: AnnotationId.describe(
    "The artifact's current version: currentVersionId from list_annotations or get_artifact. If a newer version was published since, the call fails with version_conflict.",
  ),
  target: AnnotationTarget.describe(
    'Where the comment points. For a general comment on a file use {"schema":1,"path":"<file path in the version, such as the entrypoint>","anchor":{"kind":"document"}}.',
  ),
  body,
  idempotencyKey,
});
export type CreateAnnotationInput = z.infer<typeof CreateAnnotationInput>;

export const ReplyAnnotationInput = z.object({ artifactId, threadId, body, idempotencyKey });
export type ReplyAnnotationInput = z.infer<typeof ReplyAnnotationInput>;

export const EditAnnotationInput = z.object({
  artifactId,
  messageId,
  body,
  revision: z
    .int()
    .min(1)
    .describe(
      "The message's revision as you last read it. If it changed since, the call fails with version_conflict.",
    ),
});
export type EditAnnotationInput = z.infer<typeof EditAnnotationInput>;

export const ModerateAnnotationInput = z.object({
  artifactId,
  messageId,
  action: z
    .enum(["hide", "unhide", "delete"])
    .describe(
      "hide keeps the message for its author and the owner only, unhide shows it again, delete removes its text for everyone and cannot be undone.",
    ),
  confirm: z
    .string()
    .optional()
    .describe(
      "Required for delete: the message ID again, typed only after the user explicitly confirmed deleting this message.",
    ),
});
export type ModerateAnnotationInput = z.infer<typeof ModerateAnnotationInput>;

export const DeleteThreadInput = z.object({
  artifactId,
  threadId,
  confirm: z
    .string()
    .describe(
      "The thread ID again, typed only after the user explicitly confirmed deleting this thread and all its messages.",
    ),
});
export type DeleteThreadInput = z.infer<typeof DeleteThreadInput>;

export const ExportAnnotationsInput = z.object({
  artifactId,
  format: z
    .enum(["json", "markdown"])
    .default("json")
    .describe(
      "json returns the threads as structured content; markdown also returns them as one Markdown document in the text content, ready to read.",
    ),
  version,
  state,
});
export type ExportAnnotationsInput = z.infer<typeof ExportAnnotationsInput>;
