// The annotations API under /api/v1/artifacts/:artifactId/annotations (plan section 8). Routes
// check one scope, validate input with the shared contracts and call the services in
// `@portifact/services`, which apply every permission, state, version and limit rule. The
// author always comes from the token or session. Annotation bodies, quotes and author names in
// responses are untrusted data written by reviewers.
import {
  ANNOTATION_LIMITS,
  AnnotationDeleteResult,
  AnnotationEditResult,
  AnnotationExport,
  AnnotationExportQuery,
  AnnotationHistoryPage,
  AnnotationHistoryQuery,
  AnnotationListQuery,
  AnnotationModeUpdate,
  AnnotationModeView,
  AnnotationPage,
  AnnotationThreadView,
  AttachmentLink,
  CreateThreadRequest,
  EditMessageRequest,
  ModerateMessageRequest,
  PrepareAttachmentRequest,
  PreparedAttachment,
  ReplyRequest,
  SuggestionAnnotationPage,
  SuggestionFieldsQuery,
  SuggestionThreadView,
} from "@portifact/contracts";
import type { Region } from "@portifact/db";
import {
  attachmentDisposition,
  attachmentsEnabled,
  imageRegionsEnabled,
  suggestionsEnabled,
} from "@portifact/domain";
import {
  annotationsToMarkdown,
  createAnnotationThread,
  deleteAnnotationThread,
  deleteOwnAnnotationMessage,
  editAnnotationMessage,
  exportAnnotations,
  getAnnotationThread,
  getAttachmentFile,
  listAnnotationHistory,
  listAnnotations,
  moderateAnnotationMessage,
  prepareAttachment,
  replyToAnnotationThread,
  setAnnotationMode,
  setAnnotationThreadState,
} from "@portifact/services";
import { Hono } from "hono";
import type { FetchLike } from "../auth/deps.ts";
import type { Env } from "../env.ts";
import { artifactDb, artifactRegion, bucketOf } from "../regions.ts";
import { humanCheck } from "../turnstile.ts";
import { type ApiContext, error, type Guarded, idempotentThread, readJson } from "./http.ts";
import type { Presigner } from "./presign.ts";

const BASE = "/api/v1/artifacts/:artifactId/annotations";

export function annotationRoutes(
  guarded: Guarded,
  now: () => number,
  siteverify: (env: Env) => FetchLike,
  presigner: (env: Env, region?: Region) => Presigner,
) {
  const api = new Hono<{ Bindings: Env }>();
  const artifactId = (c: ApiContext) => c.req.param("artifactId") as string;
  const param = (c: ApiContext, name: string) => c.req.param(name) as string;
  // `?fields=suggestion` (decision 0027, "API compatibility"): each thread's kind and suggestion
  // block, only for a client that asks while suggestions are on; others get today's shape.
  const suggestionFields = (c: ApiContext) =>
    suggestionsEnabled(c.env) &&
    SuggestionFieldsQuery.safeParse(c.req.query()).data?.fields === "suggestion";

  /**
   * The files a new thread or reply names (decision 0028), with the bucket of the artifact's
   * region; `undefined` for none. Adding is the dashboard's: a request with an `Authorization`
   * header that names files is refused, and so is any while attachments are switched off.
   */
  const attachmentsOf = async (
    c: ApiContext,
    ids: readonly string[] | undefined,
  ): Promise<{ ids: readonly string[]; bucket: R2Bucket } | undefined | Response> => {
    if (ids === undefined) return undefined;
    if (!attachmentsEnabled(c.env)) {
      return error(c, "invalid_input", "Files cannot be attached to comments yet.");
    }
    if (c.req.raw.headers.has("authorization")) {
      return error(c, "forbidden", "Files can be attached only from the Portifact dashboard.");
    }
    return { ids, bucket: bucketOf(await artifactRegion(c.env, artifactId(c))) };
  };

  // Starts one upload (decision 0028): session only, refused before any token is checked; the
  // bytes go straight to R2 through a presigned PUT signing their size and SHA-256.
  api.post(
    `${BASE}/attachments`,
    async (c, next) => {
      if (!attachmentsEnabled(c.env)) return error(c, "not_found", "Not found.");
      if (c.req.raw.headers.has("authorization")) {
        return error(c, "forbidden", "Files can be attached only from the Portifact dashboard.");
      }
      return next();
    },
    guarded("annotations:write", async (c, userId) => {
      const body = await readJson(c, PrepareAttachmentRequest);
      if (!body.ok) return body.response;
      const at = now();
      const handles = await artifactRegion(c.env, artifactId(c));
      const result = await prepareAttachment(handles.db, {
        userId,
        artifactId: artifactId(c),
        ...body.value,
        now: at,
      });
      if (!result.ok) return error(c, result.code, result.message);
      const file = result.value;
      const upload = await presigner(c.env, handles.region).presignPut(
        file.key,
        file.size,
        file.sha256,
        at,
      );
      return c.json(
        PreparedAttachment.parse({
          attachment: {
            id: file.id,
            name: file.name,
            size: file.size,
            sha256: file.sha256,
            expiresAt: new Date(file.expiresAt).toISOString(),
          },
          upload: {
            url: upload.url,
            headers: upload.headers,
            expiresAt: new Date(upload.expiresAt).toISOString(),
          },
        }),
        201,
      );
    }),
  );

  // One file's download link, for whoever sees its message's body (decision 0028): a presigned
  // GET of 5 minutes, served by R2 as an attachment of the type its bytes showed.
  api.get(
    `${BASE}/attachments/:attachmentId`,
    guarded("annotations:read", async (c, userId) => {
      const at = now();
      const handles = await artifactRegion(c.env, artifactId(c));
      const result = await getAttachmentFile(handles.db, {
        userId,
        artifactId: artifactId(c),
        attachmentId: param(c, "attachmentId"),
        now: at,
      });
      if (!result.ok) return error(c, result.code, result.message);
      const link = await presigner(c.env, handles.region).presignGet(result.value.key, at, {
        disposition: attachmentDisposition(result.value.view.name, result.value.contentType),
        contentType: result.value.contentType,
      });
      c.header("Cache-Control", "no-store");
      return c.json(
        AttachmentLink.parse({
          attachment: result.value.view,
          url: link.url,
          expiresAt: new Date(link.expiresAt).toISOString(),
        }),
      );
    }),
  );

  // Setting the same mode twice leaves the same state, so no idempotency key is needed.
  api.put(
    `${BASE}/mode`,
    guarded("annotations:moderate", async (c, userId) => {
      const body = await readJson(c, AnnotationModeUpdate);
      if (!body.ok) return body.response;
      const result = await setAnnotationMode(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        mode: body.value.mode,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AnnotationModeView.parse(result.value));
    }),
  );

  api.get(
    BASE,
    guarded("annotations:read", async (c, userId) => {
      const query = AnnotationListQuery.safeParse(c.req.query());
      if (!query.success)
        return error(c, "invalid_input", "Invalid cursor, limit, version or state.");
      const fields = suggestionFields(c);
      const result = await listAnnotations(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        ...query.data,
        suggestionFields: fields,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json((fields ? SuggestionAnnotationPage : AnnotationPage).parse(result.value));
    }),
  );

  api.get(
    `${BASE}/export`,
    guarded("annotations:read", async (c, userId) => {
      const query = AnnotationExportQuery.safeParse(c.req.query());
      if (!query.success) return error(c, "invalid_input", "Invalid format, version or state.");
      const result = await exportAnnotations(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        version: query.data.version,
        state: query.data.state,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      const data = AnnotationExport.parse(result.value);
      if (query.data.format === "json") return c.json(data);
      // Served as a download so a browser never renders reviewer text on the app origin.
      return c.body(annotationsToMarkdown(data), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${data.artifact.id}-annotations.md"`,
        "X-Content-Type-Options": "nosniff",
      });
    }),
  );

  // The comment action history without text, for the owner side (MCP get_comment_history,
  // `portifact annotations history`, and both data exports).
  api.get(
    `${BASE}/history`,
    guarded("annotations:read", async (c, userId) => {
      const query = AnnotationHistoryQuery.safeParse(c.req.query());
      if (!query.success) return error(c, "invalid_input", "Invalid cursor or limit.");
      const result = await listAnnotationHistory(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        ...query.data,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AnnotationHistoryPage.parse(result.value));
    }),
  );

  api.post(
    `${BASE}/threads`,
    guarded("annotations:write", async (c, userId) => {
      const body = await readJson(c, CreateThreadRequest, ANNOTATION_LIMITS.createPayloadMaxBytes);
      if (!body.ok) return body.response;
      const at = now();
      const id = artifactId(c);
      const { turnstileToken, attachments, ...thread } = body.value;
      const files = await attachmentsOf(c, attachments);
      if (files instanceof Response) return files;
      const db = await artifactDb(c.env, id);
      return idempotentThread(
        c,
        // The token is single use and not part of what the request asks for: a retry with the
        // same key replays the first answer whatever token it carries.
        {
          db,
          userId,
          operation: "annotations.thread.create",
          request: attachments ? [id, thread, attachments] : [id, thread],
          now: at,
        },
        { userId, artifactId: id, now: at },
        () =>
          createAnnotationThread(db, {
            userId,
            artifactId: id,
            ...thread,
            imageRegions: imageRegionsEnabled(c.env),
            humanCheck: humanCheck(c.env, siteverify(c.env), c.req.raw, turnstileToken),
            attachments: files,
            now: at,
          }),
      );
    }),
  );

  api.get(
    `${BASE}/threads/:threadId`,
    guarded("annotations:read", async (c, userId) => {
      const fields = suggestionFields(c);
      const result = await getAnnotationThread(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        threadId: param(c, "threadId"),
        suggestionFields: fields,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json((fields ? SuggestionThreadView : AnnotationThreadView).parse(result.value));
    }),
  );

  api.post(
    `${BASE}/threads/:threadId/messages`,
    guarded("annotations:write", async (c, userId) => {
      const body = await readJson(c, ReplyRequest, ANNOTATION_LIMITS.createPayloadMaxBytes);
      if (!body.ok) return body.response;
      const at = now();
      const id = artifactId(c);
      const threadId = param(c, "threadId");
      const { turnstileToken, attachments, ...reply } = body.value;
      const files = await attachmentsOf(c, attachments);
      if (files instanceof Response) return files;
      const db = await artifactDb(c.env, id);
      return idempotentThread(
        c,
        {
          db,
          userId,
          operation: "annotations.message.create",
          request: attachments ? [id, threadId, reply, attachments] : [id, threadId, reply],
          now: at,
        },
        { userId, artifactId: id, now: at },
        () =>
          replyToAnnotationThread(db, {
            userId,
            artifactId: id,
            threadId,
            body: reply.body,
            humanCheck: humanCheck(c.env, siteverify(c.env), c.req.raw, turnstileToken),
            attachments: files,
            now: at,
          }),
      );
    }),
  );

  for (const [action, state] of [
    ["resolve", "resolved"],
    ["reopen", "open"],
  ] as const) {
    api.post(
      `${BASE}/threads/:threadId/${action}`,
      guarded("annotations:write", async (c, userId) => {
        const result = await setAnnotationThreadState(await artifactDb(c.env, artifactId(c)), {
          userId,
          artifactId: artifactId(c),
          threadId: param(c, "threadId"),
          state,
          now: now(),
        });
        if (!result.ok) return error(c, result.code, result.message);
        return c.json(AnnotationThreadView.parse(result.value));
      }),
    );
  }

  api.delete(
    `${BASE}/threads/:threadId`,
    guarded("annotations:moderate", async (c, userId) => {
      const result = await deleteAnnotationThread(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        threadId: param(c, "threadId"),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.body(null, 204);
    }),
  );

  api.patch(
    `${BASE}/messages/:messageId`,
    guarded("annotations:write", async (c, userId) => {
      const body = await readJson(c, EditMessageRequest, ANNOTATION_LIMITS.createPayloadMaxBytes);
      if (!body.ok) return body.response;
      const result = await editAnnotationMessage(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        messageId: param(c, "messageId"),
        ...body.value,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AnnotationEditResult.parse(result.value));
    }),
  );

  api.delete(
    `${BASE}/messages/:messageId`,
    guarded("annotations:write", async (c, userId) => {
      const result = await deleteOwnAnnotationMessage(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        messageId: param(c, "messageId"),
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AnnotationDeleteResult.parse(result.value));
    }),
  );

  api.post(
    `${BASE}/messages/:messageId/moderation`,
    guarded("annotations:moderate", async (c, userId) => {
      const body = await readJson(c, ModerateMessageRequest);
      if (!body.ok) return body.response;
      const result = await moderateAnnotationMessage(await artifactDb(c.env, artifactId(c)), {
        userId,
        artifactId: artifactId(c),
        messageId: param(c, "messageId"),
        action: body.value.action,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(AnnotationDeleteResult.parse(result.value));
    }),
  );

  return api;
}
