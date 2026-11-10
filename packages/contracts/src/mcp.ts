// Inputs of the remote MCP tools (plan section 6). Outputs are the `/api/v1` shapes, so an
// agent reads the same fields the CLI and the dashboard read.
import { z } from "zod";
import {
  AccessMode,
  AnnotationsState,
  ArtifactId,
  ArtifactType,
  CommentVisibility,
} from "./core.ts";
import { LIMITS } from "./limits.ts";
import {
  IdempotencyKey,
  LIST_SEARCH_MAX,
  ListedArtifactState,
  ManifestFile,
  PublishRequest,
  ReaderCommentVisibility,
  SourceOrigin,
  UploadedPart,
} from "./publishing.ts";
import { SEARCH_LIMITS, SearchText } from "./search.ts";
import { PublishKey } from "./service-tokens.ts";
import { WorkspaceSlug } from "./workspaces.ts";

const keyArg = PublishKey.optional().describe(
  "A stable key such as pr-123 or docs/main: the first publish with it creates an artifact that carries it, and every later publish with the same key updates that artifact, from its current version. Not with artifactId.",
);

/**
 * The `workspace` argument of the tools that create or list: a workspace's slug from
 * list_workspaces, or omitted for the user's personal space.
 */
export const workspaceArg = WorkspaceSlug.optional().describe(
  "The slug of a workspace from list_workspaces to act in that workspace. Omit it for the user's personal space. When the user belongs to any workspace and did not say where, ask them which space to use before creating anything.",
);

const artifactId = ArtifactId.describe(
  "The artifact ID, as list_artifacts or get_artifact return it.",
);

export const ArtifactRef = z.object({ artifactId });
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const ListArtifactsInput = z.object({
  workspace: workspaceArg,
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
    "Only artifacts with this access mode: public, authenticated, restricted, workspace or domain.",
  ),
  annotations: AnnotationsState.optional().describe(
    "Only artifacts whose annotations are off, open or locked.",
  ),
  key: PublishKey.optional().describe("Only the artifact published with this key, if any."),
});
export type ListArtifactsInput = z.infer<typeof ListArtifactsInput>;

/**
 * Content sent inline in the tool call. The byte limit applies to the UTF-8 encoding; the
 * length bound here is a cheap upper bound, because every UTF-16 code unit takes at least a byte.
 */
export const PublishDocumentInput = z.object({
  workspace: workspaceArg.describe(
    "Where a new artifact goes: the slug of a workspace from list_workspaces, or omitted for the user's personal space. Ignored with artifactId (an update stays where the artifact is). When the user belongs to any workspace and did not say where to publish, ask them first: a workspace's admins and editors can see and manage what is published there.",
  ),
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
  key: keyArg,
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

/** Who sees comments, and exceptions for readers on the list; validated as an `AccessUpdate`. */
export const SetCommentVisibilityInput = z.object({
  artifactId,
  commentVisibility: CommentVisibility.optional().describe(
    "owner (the default): each reader sees only the threads they started and the threads the owner started, with every reply in them. everyone: every reader sees every thread. The owner always sees all.",
  ),
  readerCommentVisibility: z
    .array(
      z.object({
        email: z.string().max(254).describe("A reader already on the artifact's reader list."),
        commentVisibility: ReaderCommentVisibility.describe(
          "all: every thread. own: only their threads and the owner's. inherit: follow commentVisibility again.",
        ),
      }),
    )
    .max(LIMITS.readersPerChange)
    .optional()
    .describe(
      "Exceptions for readers on the list. They apply to whoever signs in with that verified address, in any access mode.",
    ),
});
export type SetCommentVisibilityInput = z.infer<typeof SetCommentVisibilityInput>;

/** The access mode and search and embedding settings; validated as an `AccessUpdate`. */
export const SetAccessInput = z.object({
  artifactId,
  mode: AccessMode.optional().describe(
    "restricted: only the owner and the readers on the list, after signing in. authenticated: anyone signed in to Portifact. public: anyone with the link, no sign-in. workspace (workspace artifacts only): every member of the owning workspace. domain (workspace artifacts only): every member plus anyone signed in with a verified address at one of the workspace's verified email domains. Ask the user before choosing authenticated, public, workspace or domain.",
  ),
  indexable: z
    .boolean()
    .optional()
    .describe(
      "true lets search engines index the artifact while it is public; false keeps it noindex, the default.",
    ),
  embeddable: z
    .boolean()
    .optional()
    .describe(
      "true lets other sites embed the artifact in a frame while it is public; false refuses it, the default.",
    ),
});
export type SetAccessInput = z.infer<typeof SetAccessInput>;

/** Addresses to add to or remove from the reader list; validated as an `AccessUpdate`. */
export const ReaderChangeInput = z.object({
  artifactId,
  emails: z
    .array(z.string().max(254))
    .min(1)
    .max(LIMITS.readersPerChange)
    .describe(
      `Email addresses, at most ${LIMITS.readersPerChange} per call. Portifact sends them nothing: share the link yourself.`,
    ),
});
export type ReaderChangeInput = z.infer<typeof ReaderChangeInput>;

const manifestFile = z.object({
  path: ManifestFile.shape.path.describe(
    "The file's path in the artifact, with forward slashes, for example index.html or assets/app.js.",
  ),
  kind: ManifestFile.shape.kind.describe(
    "published (the default) for files the artifact serves; source for private sources only the owner can download.",
  ),
  sha256: ManifestFile.shape.sha256.describe(
    "SHA-256 of the file's exact bytes, in lowercase hex.",
  ),
  size: ManifestFile.shape.size.describe("Size of the file in bytes."),
  contentType: ManifestFile.shape.contentType.describe(
    "The file's media type, for example text/html; charset=utf-8.",
  ),
});

/** A publish of several or large files: the API's `PublishRequest` with a required key. */
export const PrepareUploadInput = z.object({
  workspace: workspaceArg.describe(
    "Where a new artifact goes: the slug of a workspace from list_workspaces, or omitted for the user's personal space. Ignored with artifactId. When the user belongs to any workspace and did not say where to publish, ask them first: a workspace's admins and editors can see and manage what is published there.",
  ),
  type: PublishRequest.shape.type.describe(
    "site for HTML with its assets, markdown or text for one document. It cannot change after the first publish.",
  ),
  name: PublishRequest.shape.name.describe("A short title the owner will recognize."),
  entrypoint: PublishRequest.shape.entrypoint.describe(
    "The path of the main file among files: index.html for a site, the document for markdown or text.",
  ),
  files: z
    .array(manifestFile)
    .min(1)
    .max(LIMITS.filesPerVersion)
    .describe(
      `Every file of the version, at most ${LIMITS.filesPerVersion}, within the per-artifact size of the owner's plan in all (get_usage: plan.limits.artifactBytes). Files the account already stores are not uploaded again.`,
    ),
  artifactId: artifactId
    .optional()
    .describe("Only to publish a new version of an existing artifact. Omit it to create one."),
  baseVersionId: PublishRequest.shape.baseVersionId.describe(
    "Required with artifactId: the currentVersionId you last read from get_artifact. A newer version published since makes the commit fail with version_conflict.",
  ),
  sourceOrigin: SourceOrigin.optional().describe(
    "The git commit, branch and remote the source files came from, when there are source files.",
  ),
  key: keyArg,
  multipart: z
    .boolean()
    .optional()
    .describe(
      "true when you can upload large files in parts: files over 64 MiB then get one URL per part, and commit_upload needs each part's ETag. Omit it to get one PUT per file.",
    ),
  idempotencyKey: IdempotencyKey.describe(
    "A unique string (8 to 128 letters, digits, '.', '_', ':' or '-') for this publish. Retrying with the same key and arguments returns the first result instead of opening a second upload.",
  ),
});
export type PrepareUploadInput = z.infer<typeof PrepareUploadInput>;

const uploadId = z.string().min(1).max(128).describe("The uploadId prepare_upload returned.");

export const UploadRef = z.object({ uploadId });
export type UploadRef = z.infer<typeof UploadRef>;

export const CommitUploadInput = z.object({
  uploadId,
  parts: z
    .array(
      z.object({
        sha256: UploadedPart.shape.sha256.describe(
          "SHA-256 of the whole file the part belongs to.",
        ),
        partNumber: UploadedPart.shape.partNumber.describe("The part's partNumber."),
        etag: UploadedPart.shape.etag.describe(
          "The ETag header storage answered the part's PUT with.",
        ),
      }),
    )
    .max(1_000)
    .optional()
    .describe(
      "Only for multipart files: every part you uploaded and have not reported yet, with its ETag. Reporting a part twice is harmless.",
    ),
});
export type CommitUploadInput = z.infer<typeof CommitUploadInput>;

export const ListWorkspacesInput = z.object({});
export type ListWorkspacesInput = z.infer<typeof ListWorkspacesInput>;

export const TransferArtifactInput = z.object({
  artifactId,
  workspace: WorkspaceSlug.nullable().describe(
    "The slug of the workspace to move the artifact to, from list_workspaces, or null to move it to the user's personal space.",
  ),
});
export type TransferArtifactInput = z.infer<typeof TransferArtifactInput>;

/** Input of the MCP tool search_content; the acting user comes from the token. */
export const SearchContentInput = z.object({
  workspace: WorkspaceSlug.optional().describe(
    "The slug of a workspace from list_workspaces to search that workspace. Omit it for the user's personal space.",
  ),
  query: SearchText.describe(
    "Plain words to find in the artifacts' text; every word must appear. Quotes and operators are treated as ordinary characters.",
  ),
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe(
      "The nextCursor of the previous page, with the same query. Omit it for the first page.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMITS.pageMax)
    .default(SEARCH_LIMITS.pageDefault)
    .describe(`How many results to return, 1 to ${SEARCH_LIMITS.pageMax}.`),
});
export type SearchContentInput = z.infer<typeof SearchContentInput>;
