// Edit suggestions, the owner's draft and the change list (decision 0027), thin over the services
// in `@portifact/services`, which apply every permission, state, version and limit rule. Behind
// `SUGGESTIONS_ENABLED`: switched off, none of these routes exists.
//
// Suggesting, planning, deciding and drafts are the viewer's: only the dashboard's session from
// the app's own pages (a request with an `Authorization` header is refused before its token is
// even checked), so no bearer token accepts, rejects, withdraws or publishes (decision 0027,
// "Who reads and closes"). Reading a suggestion and the change list also take a person's OAuth
// token (the CLI and the owner's agent); a service token has no annotation role and gets what a
// missing artifact gives. Edits, envelopes and notes are untrusted reviewer text.

import type { ErrorCode, ErrorDetail } from "@portifact/contracts";
import {
  AcceptanceStarted,
  ArtifactId,
  ChangeItemList,
  ChangeItemListQuery,
  ChangeItemView,
  ConfirmPlan,
  DecideSuggestionRequest,
  DRAFT_LIMITS,
  DraftView,
  EDIT_LIMITS,
  IdempotencyKey,
  MarkChangeItem,
  Plan,
  RebaseDraftRequest,
  RebasedDraft,
  SaveDraftRequest,
  SubmitSuggestionRequest,
  SuggestionThreadView,
  SuggestionView,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { suggestionsEnabled } from "@portifact/domain";
import type { StoredResponse } from "@portifact/services";
import {
  acceptSuggestion,
  discardDraft,
  getAnnotationThread,
  getChangeItem,
  getDraft,
  getSuggestion,
  hashRequest,
  idempotentThreadWrite,
  listChangeItems,
  markChangeItemOnce,
  planDraft,
  planSuggestion,
  publishDraft,
  rebaseDraft,
  rejectSuggestion,
  replayAcceptance,
  runIdempotent,
  saveDraft,
  submitSuggestion,
  withdrawSuggestion,
} from "@portifact/services";
import { Hono } from "hono";
import type { FetchLike } from "../auth/deps.ts";
import type { Env } from "../env.ts";
import { artifactRegion } from "../regions.ts";
import { humanCheck } from "../turnstile.ts";
import { type ApiContext, error, failure, type Guarded, readJson } from "./http.ts";

const BASE = "/api/v1/artifacts/:artifactId";

/** The note's room besides the edit, in bytes of the request body. */
const SUBMIT_MAX_BYTES = EDIT_LIMITS.editMaxBytes + 32 * 1024;
const DRAFT_MAX_BYTES = DRAFT_LIMITS.editMaxBytes + 4 * 1024;

type Handler = (c: ApiContext, userId: string) => Promise<Response>;

export function suggestionRoutes(
  guarded: Guarded,
  now: () => number,
  siteverify: (env: Env) => FetchLike,
) {
  const api = new Hono<{ Bindings: Env }>();
  const param = (c: ApiContext, name: string) => c.req.param(name) as string;

  /** A route that exists only while suggestions are on, for an artifact ID that can exist. */
  const route =
    (scope: Parameters<Guarded>[0], handler: Handler, sessionOnly: boolean) =>
    async (c: ApiContext) => {
      if (!suggestionsEnabled(c.env)) return error(c, "not_found", "Not found.");
      if (sessionOnly && c.req.raw.headers.has("authorization")) {
        return error(c, "forbidden", "Suggestions are made and decided in the viewer.");
      }
      if (!ArtifactId.safeParse(param(c, "artifactId")).success) {
        return error(c, "not_found", "Artifact not found.");
      }
      return guarded(scope, handler)(c);
    };
  const session = (scope: Parameters<Guarded>[0], handler: Handler) => route(scope, handler, true);
  const anyone = (scope: Parameters<Guarded>[0], handler: Handler) => route(scope, handler, false);

  const region = (c: ApiContext) => artifactRegion(c.env, param(c, "artifactId"));
  const actor = (c: ApiContext, userId: string, at = now()) => ({
    userId,
    artifactId: param(c, "artifactId"),
    now: at,
  });

  // Suggestions

  api.post(
    `${BASE}/suggestions`,
    session("annotations:write", async (c, userId) => {
      const body = await readJson(c, SubmitSuggestionRequest, SUBMIT_MAX_BYTES);
      if (!body.ok) return body.response;
      const at = now();
      const id = param(c, "artifactId");
      const { turnstileToken, ...suggestion } = body.value;
      const { db } = await region(c);
      const key = IdempotencyKey.safeParse(c.req.header("idempotency-key"));
      if (!key.success) {
        return error(c, "invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
      }
      const reader = { userId, artifactId: id, now: at };
      // The stored answer is the thread's reference only, rebuilt on replay under the caller's
      // current authorization (`idempotentThreadWrite`), as for comments.
      const outcome = await idempotentThreadWrite(
        db,
        {
          actorId: userId,
          key: key.data,
          // The single-use token is not part of what the request asks for (as for comments).
          operation: "suggestions.create",
          requestHash: await hashRequest([id, suggestion]),
          now: at,
        },
        reader,
        () =>
          submitSuggestion(db, {
            ...actor(c, userId, at),
            ...suggestion,
            humanCheck: humanCheck(c.env, siteverify(c.env), c.req.raw, turnstileToken),
          }),
      );
      if (outcome.kind === "mismatch") {
        return error(c, "invalid_input", "This Idempotency-Key was used for a different request.");
      }
      if (outcome.kind === "in_progress") {
        return error(
          c,
          "version_conflict",
          "A request with this Idempotency-Key is still running.",
        );
      }
      if (!outcome.result.ok) return refused(c, outcome.result);
      // The route answers the suggestion's thread with its kind and suggestion block, read under
      // the same authorization as `?fields=suggestion`.
      const view = await getAnnotationThread(db, {
        ...reader,
        threadId: outcome.result.value.id,
        suggestionFields: true,
      });
      if (!view.ok) return refused(c, view);
      return c.json(SuggestionThreadView.parse(view.value), 201);
    }),
  );

  api.get(
    `${BASE}/suggestions/:threadId`,
    anyone("annotations:read", async (c, userId) => {
      const { db } = await region(c);
      const result = await getSuggestion(db, {
        ...actor(c, userId),
        threadId: param(c, "threadId"),
      });
      if (!result.ok) return refused(c, result);
      return c.json(SuggestionView.parse(result.value));
    }),
  );

  api.post(
    `${BASE}/suggestions/:threadId/plan`,
    session("annotations:write", async (c, userId) => {
      const { db, bucket } = await region(c);
      if (!bucket) return error(c, "capacity_unavailable", "Plans are unavailable.");
      const result = await planSuggestion(db, bucket, {
        ...actor(c, userId),
        threadId: param(c, "threadId"),
        contentDomain: c.env.CONTENT_DOMAIN,
      });
      if (!result.ok) return refused(c, result);
      return c.json(Plan.parse(result.value));
    }),
  );

  api.post(
    `${BASE}/suggestions/:threadId/accept`,
    session("annotations:moderate", async (c, userId) => {
      const body = await readJson(c, ConfirmPlan, 1_024);
      if (!body.ok) return body.response;
      const at = now();
      const threadId = param(c, "threadId");
      const { db, bucket } = await region(c);
      if (!bucket) return error(c, "capacity_unavailable", "Accepting is unavailable.");
      return startOnce(
        c,
        db,
        {
          userId,
          operation: "suggestions.accept",
          request: [param(c, "artifactId"), threadId, body.value.digest],
          now: at,
        },
        threadId,
        async () =>
          started(
            await acceptSuggestion(db, bucket, {
              ...actor(c, userId, at),
              threadId,
              digest: body.value.digest,
              contentDomain: c.env.CONTENT_DOMAIN,
            }),
          ),
      );
    }),
  );

  for (const [action, decide, scope] of [
    ["reject", rejectSuggestion, "annotations:moderate"],
    ["withdraw", withdrawSuggestion, "annotations:write"],
  ] as const) {
    api.post(
      `${BASE}/suggestions/:threadId/${action}`,
      session(scope, async (c, userId) => {
        const body = await readJson(c, DecideSuggestionRequest, 1_024);
        if (!body.ok) return body.response;
        const { db } = await region(c);
        const result = await decide(db, {
          ...actor(c, userId),
          threadId: param(c, "threadId"),
          revision: body.value.revision,
        });
        if (!result.ok) return refused(c, result);
        return c.json(SuggestionView.parse(result.value));
      }),
    );
  }

  // The owner's draft: its author's only

  api.get(
    `${BASE}/draft`,
    session("annotations:read", async (c, userId) => {
      const { db } = await region(c);
      const result = await getDraft(db, actor(c, userId));
      if (!result.ok) return refused(c, result);
      return c.json(DraftView.parse(result.value));
    }),
  );

  // Saving is held to the revision the author holds, so a repeated save is refused, never
  // applied twice: no idempotency key.
  api.put(
    `${BASE}/draft`,
    session("annotations:write", async (c, userId) => {
      const body = await readJson(c, SaveDraftRequest, DRAFT_MAX_BYTES);
      if (!body.ok) return body.response;
      const { db } = await region(c);
      const result = await saveDraft(db, { ...actor(c, userId), ...body.value });
      if (!result.ok) return refused(c, result);
      return c.json(DraftView.parse(result.value));
    }),
  );

  api.delete(
    `${BASE}/draft`,
    session("annotations:write", async (c, userId) => {
      const { db } = await region(c);
      const result = await discardDraft(db, actor(c, userId));
      if (!result.ok) return refused(c, result);
      return c.body(null, 204);
    }),
  );

  api.post(
    `${BASE}/draft/plan`,
    session("annotations:write", async (c, userId) => {
      const { db, bucket } = await region(c);
      if (!bucket) return error(c, "capacity_unavailable", "Plans are unavailable.");
      const result = await planDraft(db, bucket, {
        ...actor(c, userId),
        contentDomain: c.env.CONTENT_DOMAIN,
      });
      if (!result.ok) return refused(c, result);
      return c.json(Plan.parse(result.value));
    }),
  );

  // Rebasing is held to the revision and incarnation the author holds: no idempotency key.
  api.post(
    `${BASE}/draft/rebase`,
    session("annotations:write", async (c, userId) => {
      const body = await readJson(c, RebaseDraftRequest, 1_024);
      if (!body.ok) return body.response;
      const { db, bucket } = await region(c);
      if (!bucket) return error(c, "capacity_unavailable", "Rebasing is unavailable.");
      const result = await rebaseDraft(db, bucket, {
        ...actor(c, userId),
        ...body.value,
        contentDomain: c.env.CONTENT_DOMAIN,
      });
      if (!result.ok) return refused(c, result);
      return c.json(RebasedDraft.parse(result.value));
    }),
  );

  api.post(
    `${BASE}/draft/publish`,
    session("annotations:moderate", async (c, userId) => {
      const body = await readJson(c, ConfirmPlan, 1_024);
      if (!body.ok) return body.response;
      const at = now();
      const { db, bucket } = await region(c);
      if (!bucket) return error(c, "capacity_unavailable", "Publishing is unavailable.");
      return startOnce(
        c,
        db,
        {
          userId,
          operation: "drafts.publish",
          request: [param(c, "artifactId"), body.value.digest],
          now: at,
        },
        null,
        async () =>
          started(
            await publishDraft(db, bucket, {
              ...actor(c, userId, at),
              digest: body.value.digest,
              contentDomain: c.env.CONTENT_DOMAIN,
            }),
          ),
      );
    }),
  );

  // The change list: people only, their tokens included

  api.get(
    `${BASE}/changes`,
    anyone("annotations:read", async (c, userId) => {
      const query = ChangeItemListQuery.safeParse(c.req.query());
      if (!query.success) return error(c, "invalid_input", "Invalid state, cursor or limit.");
      const { db } = await region(c);
      const result = await listChangeItems(db, { ...actor(c, userId), ...query.data });
      if (!result.ok) return refused(c, result);
      return c.json(ChangeItemList.parse(result.value));
    }),
  );

  api.get(
    `${BASE}/changes/:itemId`,
    anyone("annotations:read", async (c, userId) => {
      const { db } = await region(c);
      const result = await getChangeItem(db, { ...actor(c, userId), itemId: param(c, "itemId") });
      if (!result.ok) return refused(c, result);
      return c.json(ChangeItemView.parse(result.value));
    }),
  );

  api.patch(
    `${BASE}/changes/:itemId`,
    anyone("annotations:write", async (c, userId) => {
      const body = await readJson(c, MarkChangeItem, 1_024);
      if (!body.ok) return body.response;
      const at = now();
      const itemId = param(c, "itemId");
      const key = IdempotencyKey.safeParse(c.req.header("idempotency-key"));
      if (!key.success) {
        return error(c, "invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
      }
      const { db } = await region(c);
      const outcome = await markChangeItemOnce(
        db,
        {
          actorId: userId,
          key: key.data,
          operation: "changes.mark",
          requestHash: await hashRequest([param(c, "artifactId"), itemId, body.value]),
          now: at,
        },
        { ...actor(c, userId, at), itemId, ...body.value },
      );
      if (outcome.kind === "mismatch") {
        return error(c, "invalid_input", "This Idempotency-Key was used for a different request.");
      }
      if (outcome.kind === "in_progress") {
        return error(
          c,
          "version_conflict",
          "A request with this Idempotency-Key is still running.",
        );
      }
      if (!outcome.result.ok) return refused(c, outcome.result);
      return c.json(ChangeItemView.parse(outcome.result.value));
    }),
  );

  return api;
}

interface Failed {
  code: ErrorCode;
  message: string;
  detail?: ErrorDetail | undefined;
}

/** A refusal as stored and sent: `details.reason` tells `plan_changed` from other conflicts. */
function failureOf(result: Failed): StoredResponse {
  const stored = failure(result.code, result.message);
  if (!result.detail) return stored;
  return {
    status: stored.status,
    body: {
      error: { code: result.code, message: result.message, details: { reason: result.detail } },
    },
  };
}

function refused(c: ApiContext, result: Failed): Response {
  const { status, body } = failureOf(result);
  return c.json(body, status as 400);
}

/**
 * Starts an acceptance or a draft publish once per idempotency key. The stored answer holds the
 * attempt's ID only; a replay answers again only under the caller's current authorization
 * (`replayAcceptance`), never from the stored answer alone.
 */
async function startOnce(
  c: ApiContext,
  db: RegionalDb,
  input: { userId: string; operation: string; request: unknown; now: number },
  threadId: string | null,
  work: () => Promise<StoredResponse>,
): Promise<Response> {
  const key = IdempotencyKey.safeParse(c.req.header("idempotency-key"));
  if (!key.success) {
    return error(c, "invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
  }
  const outcome = await runIdempotent(
    db,
    {
      actorId: input.userId,
      key: key.data,
      operation: input.operation,
      requestHash: await hashRequest(input.request),
      now: input.now,
    },
    work,
  );
  if (outcome.kind === "mismatch") {
    return error(c, "invalid_input", "This Idempotency-Key was used for a different request.");
  }
  if (outcome.kind === "in_progress") {
    return error(c, "version_conflict", "A request with this Idempotency-Key is still running.");
  }
  const { status, body } = outcome.response;
  if (outcome.kind === "replayed" && status === 202) {
    const again = await replayAcceptance(db, {
      userId: input.userId,
      artifactId: c.req.param("artifactId") as string,
      now: input.now,
      attemptId: AcceptanceStarted.parse(body).attemptId,
      threadId,
    });
    if (!again.ok) return refused(c, again);
    return c.json(AcceptanceStarted.parse(again.value), 202);
  }
  return c.json(body as object, status as 202);
}

function started(result: Awaited<ReturnType<typeof acceptSuggestion>>): StoredResponse {
  return result.ok
    ? { status: 202, body: AcceptanceStarted.parse(result.value) }
    : failureOf(result);
}
