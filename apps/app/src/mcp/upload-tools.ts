// MCP tools for uploads of several or large files (plan section 6: "MCP prepara la sesión, la CLI
// o un cliente HTTP sube los bytes y MCP consulta o completa la operación"): prepare_upload,
// get_upload_status and commit_upload. They run the services of POST /api/v1/publishes,
// GET /api/v1/publishes/:id, POST .../parts and POST .../commit with the same scope, quotas,
// budget protection and new-artifact defaults, and return the same bodies. The bytes never pass
// through this server: the agent PUTs them to the presigned URLs.
import {
  CommittedPublish,
  CommitUploadInput,
  type ErrorCode,
  type OAuthScope,
  PreparedPublish,
  PrepareUploadInput,
  PublishRequest,
  UploadRef,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { artifactDb, personalScope } from "../regions.ts";
import {
  commitPublish,
  hashRequest,
  reportUploadedPart,
  runIdempotent,
  uploadProgress,
} from "@portifact/services";
import { preparedPublish, prepareUpload } from "../api/uploads.ts";
import { committedPublish } from "./present.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const UPLOAD_TOOL_SCOPES: [string, OAuthScope][] = [
  ["prepare_upload", "artifacts:write"],
  ["get_upload_status", "artifacts:write"],
  ["commit_upload", "artifacts:write"],
];

/** What to do with the targets, for agents that read only the text. */
function nextSteps(body: PreparedPublish): string {
  if (body.uploads.length === 0) {
    return `Upload ${body.uploadId} needs no bytes: the account already stores every file. Call commit_upload with uploadId "${body.uploadId}".`;
  }
  const multipart = body.uploads.some((upload) => upload.method === "MULTIPART");
  return [
    `Upload ${body.uploadId} for artifact ${body.artifactId} (version ${body.versionNumber}) is open until ${body.expiresAt}.`,
    `Send ${body.uploads.length} file(s): for each upload, PUT the exact bytes of the file with that sha256 to its url, with exactly the listed headers and nothing else. Files not listed are already stored.`,
    multipart
      ? "A MULTIPART upload has one URL per part: PUT bytes [offset, offset + size) of the file to each, keep the ETag header of each answer, and pass every part to commit_upload as parts."
      : null,
    `URLs expire after 15 minutes; get_upload_status gives fresh ones. Then call commit_upload with uploadId "${body.uploadId}".`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function registerUploadTools(register: RegisterTool, context: ToolContext, db: RegionalDb): void {
  const uploadDeps = () => ({
    bucket: context.env.ARTIFACTS,
    presigner: context.presigner,
    multipart: context.multipart,
  });

  register(
    "prepare_upload",
    {
      title: "Prepare an upload",
      description:
        "Start publishing a folder, a site with several files or files too large to send inline. This server cannot read the user's files: list each file with its path, SHA-256, size and media type, and you get a presigned HTTP PUT for every file the account does not store yet. Upload the bytes with any HTTP client (curl works) or the portifact CLI, then call commit_upload. Nothing is published until the commit. Without artifactId it creates a new artifact with the user's defaults for new artifacts (private to the user unless they changed them); with artifactId and baseVersionId it prepares a new version and keeps the artifact's access. The upload stays open 24 hours and an account has at most two open at once. Quotas apply as for any publish. Returns the uploadId and the upload targets.",
      inputSchema: PrepareUploadInput,
      outputSchema: PreparedPublish,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args: PrepareUploadInput) => {
      const { idempotencyKey, ...rest } = args;
      // The same validation and defaults as the API's body.
      const request = PublishRequest.safeParse(rest);
      if (!request.success) {
        const issue = request.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        return failure("invalid_input", `${where}${issue?.message ?? "Invalid input."}`);
      }
      const now = context.now();
      const outcome = await runIdempotent(
        db,
        {
          actorId: context.userId,
          key: idempotencyKey,
          operation: "mcp.prepare_upload",
          requestHash: await hashRequest(request.data),
          now,
        },
        async () =>
          prepareUpload(
            request.data.artifactId
              ? await artifactDb(context.env, request.data.artifactId)
              : (await personalScope(context.env, context.userId)).db,
            uploadDeps(),
            context.userId,
            request.data,
            now,
          ),
      );
      if (outcome.kind === "mismatch") {
        return failure("invalid_input", "This idempotency key was used for a different request.");
      }
      if (outcome.kind === "in_progress") {
        return failure("version_conflict", "A request with this idempotency key is still running.");
      }
      const body = outcome.response.body as
        | PreparedPublish
        | { error: { code: ErrorCode; message: string } };
      if ("error" in body) return failure(body.error.code, body.error.message);
      return success(nextSteps(body), body);
    },
  );

  register(
    "get_upload_status",
    {
      title: "Get an upload's status",
      description:
        "Check an open upload from prepare_upload and get fresh presigned URLs (the earlier ones expire after 15 minutes). It lists every file the commit has not verified yet, including files already PUT (sending the same bytes again is harmless), and for multipart files the parts already reported, which need not be sent again. Fails with upload_incomplete once the upload was committed, cancelled or expired.",
      inputSchema: UploadRef,
      outputSchema: PreparedPublish,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: UploadRef) => {
      const now = context.now();
      const result = await uploadProgress(db, {
        userId: context.userId,
        sessionId: args.uploadId,
        now,
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = await preparedPublish(context.presigner, result.value, now);
      return success(nextSteps(body), body);
    },
  );

  register(
    "commit_upload",
    {
      title: "Commit an upload",
      description:
        "Publish an upload from prepare_upload once every file's bytes were PUT: the server checks each file's size and SHA-256, makes the new version current and returns its URL, version and expiry. For multipart files, pass every uploaded part with its ETag as parts. Fails with upload_incomplete while a file is missing or its bytes do not match (PUT it again, with a fresh URL from get_upload_status if needed) and with version_conflict if another version was published since the upload's base.",
      inputSchema: CommitUploadInput,
      outputSchema: CommittedPublish,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args: CommitUploadInput) => {
      const session = { userId: context.userId, sessionId: args.uploadId };
      // The same report as POST /api/v1/publishes/:uploadId/parts, once per part.
      for (const part of args.parts ?? []) {
        const reported = await reportUploadedPart(db, { ...session, ...part, now: context.now() });
        if (!reported.ok) return failure(reported.code, reported.message);
      }
      const result = await commitPublish(db, context.env.ARTIFACTS, {
        ...session,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = committedPublish(context.env, result.value);
      return success(
        `Published version ${body.versionNumber} of artifact ${body.artifactId} at ${body.url}. It expires ${body.expiresAt}. New artifacts start with the owner's defaults (private unless they changed them) and updates keep the existing access.`,
        body,
      );
    },
  );
}
