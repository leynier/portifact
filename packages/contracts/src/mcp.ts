// Inputs of the remote MCP tools (plan section 6). Outputs are the `/api/v1` shapes, so an
// agent reads the same fields the CLI and the dashboard read.
import { z } from "zod";
import { AccessMode, AnnotationsState, ArtifactId, ArtifactType } from "./core.ts";
import { LIMITS } from "./limits.ts";
import { IdempotencyKey, LIST_SEARCH_MAX, ListedArtifactState } from "./publishing.ts";

const artifactId = ArtifactId.describe(
  "The artifact ID, as list_artifacts or get_artifact return it.",
);

export const ArtifactRef = z.object({ artifactId });
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const ListArtifactsInput = z.object({
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe("The nextCursor of the previous page. Omit it for the first page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("How many artifacts to return, 1 to 100."),
  search: z
    .string()
    .trim()
    .min(1)
    .max(LIST_SEARCH_MAX)
    .optional()
    .describe("Only artifacts whose name or ID contains this text (letters in any case)."),
  state: ListedArtifactState.optional().describe(
    "Only artifacts in this state: active, archived, suspended or purging.",
  ),
  type: ArtifactType.optional().describe("Only artifacts of this type: site, markdown or text."),
  access: AccessMode.optional().describe(
    "Only artifacts with this access mode: public, authenticated or restricted.",
  ),
  annotations: AnnotationsState.optional().describe(
    "Only artifacts whose annotations are off, open or locked.",
  ),
});
export type ListArtifactsInput = z.infer<typeof ListArtifactsInput>;

/**
 * Content sent inline in the tool call. The byte limit applies to the UTF-8 encoding; the
 * length bound here is a cheap upper bound, because every UTF-16 code unit takes at least a byte.
 */
export const PublishDocumentInput = z.object({
  type: ArtifactType.describe(
    "markdown for a Markdown document, text for plain text, site for one self-contained HTML page. It cannot change after the first publish.",
  ),
  name: z.string().trim().min(1).max(200).describe("A short title the owner will recognize."),
  content: z
    .string()
    .max(LIMITS.inlineMcpBytes)
    .describe(
      `The whole document as UTF-8 text, at most ${LIMITS.inlineMcpBytes} bytes. HTML must be one file with its CSS and scripts inline. Never a local file path: this server cannot read the user's files.`,
    ),
  artifactId: artifactId
    .optional()
    .describe("Only to publish a new version of an existing artifact. Omit it to create one."),
  baseVersionId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Required with artifactId: the currentVersionId you last read from get_artifact. A newer version published since then makes the call fail with version_conflict instead of overwriting it.",
    ),
  idempotencyKey: IdempotencyKey.optional().describe(
    "A unique string (8 to 128 letters, digits, '.', '_', ':' or '-') for this publish. Retrying with the same key and arguments returns the first result instead of publishing twice.",
  ),
});
export type PublishDocumentInput = z.infer<typeof PublishDocumentInput>;

export const DeleteArtifactInput = z.object({
  artifactId,
  confirm: z
    .string()
    .describe(
      "The artifact ID again, typed only after the user explicitly confirmed this deletion.",
    ),
});
export type DeleteArtifactInput = z.infer<typeof DeleteArtifactInput>;

export const SetPortifactBarInput = z.object({
  artifactId,
  enabled: z
    .boolean()
    .describe(
      "true opens the artifact's pages in Portifact's viewer, with the Portifact bar and the comments sidebar; false serves the artifact itself, full screen.",
    ),
});
export type SetPortifactBarInput = z.infer<typeof SetPortifactBarInput>;
