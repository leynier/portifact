// The dashboard's calls for edit suggestions (decision 0027), in one typed module: submitting,
// planning, previewing, accepting, rejecting and withdrawing a suggestion, the annotation list
// with each thread's kind, and the change list. Every route answers 404 while
// `SUGGESTIONS_ENABLED` is off, and every answer is validated with the shared contracts. The
// reviewer's text inside an edit, a plan or an envelope is untrusted: it is only ever rendered as
// text, through the typed display.
import {
  AcceptanceStarted,
  AnnotationThreadView,
  type AnnotationVersionFilter,
  ChangeItemList,
  type ChangeItemState,
  ChangeItemView,
  type ConfirmPlan,
  type DecideSuggestionRequest,
  type MarkChangeItem,
  Plan,
  PreviewResponse,
  type SubmitSuggestionRequest,
  SuggestionAnnotationPage,
  SuggestionView,
} from "@portifact/contracts";
import type { z } from "zod";

/** The dashboard's validated call: same origin, the session cookie, a schema for the answer. */
export type ApiCall = <T>(
  path: string,
  schema: z.ZodType<T>,
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  payload?: unknown,
  extraHeaders?: Record<string, string>,
) => Promise<T>;

export interface SuggestionsApi {
  /** A page of the threads of `version` with their kind and suggestion (`?fields=suggestion`). */
  listAnnotations(
    artifactId: string,
    cursor: string | undefined,
    version: AnnotationVersionFilter,
  ): Promise<SuggestionAnnotationPage>;
  /**
   * Starts a suggestion on the version the viewer shows: the edit and the reviewer's note. The
   * route answers the plain thread view (a replay rebuilds it like a comment's); its kind and
   * suggestion come with the next listing.
   */
  submit(
    artifactId: string,
    request: SubmitSuggestionRequest,
    idempotencyKey: string,
  ): Promise<AnnotationThreadView>;
  get(artifactId: string, threadId: string): Promise<SuggestionView>;
  /** Builds the plan of a pending suggestion on the current version (a dry run). */
  plan(artifactId: string, threadId: string): Promise<Plan>;
  /** A one-use URL of the built preview of a plan the person holds, or why there is none. */
  preview(artifactId: string, digest: string): Promise<PreviewResponse>;
  /** Accepts the plan the person confirmed by its digest; the jobs Worker applies it. */
  accept(
    artifactId: string,
    threadId: string,
    request: ConfirmPlan,
    idempotencyKey: string,
  ): Promise<AcceptanceStarted>;
  reject(
    artifactId: string,
    threadId: string,
    request: DecideSuggestionRequest,
  ): Promise<SuggestionView>;
  withdraw(
    artifactId: string,
    threadId: string,
    request: DecideSuggestionRequest,
  ): Promise<SuggestionView>;
  /** A page of the change list, one state or all, oldest first. */
  changes(
    artifactId: string,
    query?: { state?: ChangeItemState; cursor?: string },
  ): Promise<ChangeItemList>;
  markChange(
    artifactId: string,
    itemId: string,
    request: MarkChangeItem,
    idempotencyKey: string,
  ): Promise<ChangeItemView>;
}

const artifactPath = (artifactId: string) => `/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
const suggestionPath = (artifactId: string, threadId: string) =>
  `${artifactPath(artifactId)}/suggestions/${encodeURIComponent(threadId)}`;

export function suggestionsApi(call: ApiCall): SuggestionsApi {
  return {
    listAnnotations(artifactId, cursor, version) {
      const params = new URLSearchParams({ fields: "suggestion" });
      if (cursor) params.set("cursor", cursor);
      if (version !== "current") params.set("version", version);
      return call(`${artifactPath(artifactId)}/annotations?${params}`, SuggestionAnnotationPage);
    },
    submit(artifactId, request, idempotencyKey) {
      return call(
        `${artifactPath(artifactId)}/suggestions`,
        AnnotationThreadView,
        "POST",
        request,
        { "idempotency-key": idempotencyKey },
      );
    },
    get(artifactId, threadId) {
      return call(suggestionPath(artifactId, threadId), SuggestionView);
    },
    plan(artifactId, threadId) {
      return call(`${suggestionPath(artifactId, threadId)}/plan`, Plan, "POST");
    },
    preview(artifactId, digest) {
      return call(`${artifactPath(artifactId)}/previews`, PreviewResponse, "POST", { digest });
    },
    accept(artifactId, threadId, request, idempotencyKey) {
      return call(
        `${suggestionPath(artifactId, threadId)}/accept`,
        AcceptanceStarted,
        "POST",
        request,
        {
          "idempotency-key": idempotencyKey,
        },
      );
    },
    reject(artifactId, threadId, request) {
      return call(
        `${suggestionPath(artifactId, threadId)}/reject`,
        SuggestionView,
        "POST",
        request,
      );
    },
    withdraw(artifactId, threadId, request) {
      return call(
        `${suggestionPath(artifactId, threadId)}/withdraw`,
        SuggestionView,
        "POST",
        request,
      );
    },
    changes(artifactId, query = {}) {
      const params = new URLSearchParams();
      if (query.state) params.set("state", query.state);
      if (query.cursor) params.set("cursor", query.cursor);
      const search = params.size > 0 ? `?${params}` : "";
      return call(`${artifactPath(artifactId)}/changes${search}`, ChangeItemList);
    },
    markChange(artifactId, itemId, request, idempotencyKey) {
      return call(
        `${artifactPath(artifactId)}/changes/${encodeURIComponent(itemId)}`,
        ChangeItemView,
        "PATCH",
        request,
        { "idempotency-key": idempotencyKey },
      );
    },
  };
}
