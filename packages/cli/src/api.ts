// Calls to the publishing and artifact API under /api/v1. Every call carries a valid access
// token through withAccessToken, answers are validated with the shared contracts, and API errors
// keep their documented code. No response body or token is ever printed.
import { ApiError } from "@portifact/contracts";
import type { z } from "zod";
import { CliError, isTransient } from "./errors.ts";
import { messages } from "./messages.ts";
import { readJson, send } from "./oauth.ts";
import { type Session, withAccessToken } from "./session.ts";

export interface ApiRequest<T> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path under /api/v1, starting with a slash. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Validates the answer; omitted when the answer has no body. */
  schema?: z.ZodType<T>;
}

export function callApi<T>(session: Session, request: ApiRequest<T>): Promise<T> {
  const { runtime, server } = session;
  return withAccessToken(session, async (token) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...request.headers,
    };
    const init: RequestInit = { method: request.method, headers };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(request.body);
    }
    const response = await send(runtime, server, `${server.apiResource}${request.path}`, init);
    if (response.status === 401) {
      await response.body?.cancel();
      return { kind: "unauthorized" };
    }
    if (!response.ok) throw await apiError(session, response);
    if (!request.schema) {
      await response.body?.cancel();
      return { kind: "ok", value: undefined as T };
    }
    const parsed = request.schema.safeParse(await readJson(response));
    if (!parsed.success) throw new CliError("server_error", messages.errors.server(server.origin));
    return { kind: "ok", value: parsed.data };
  });
}

async function apiError(session: Session, response: Response): Promise<CliError> {
  const body = await readJson(response);
  const parsed = ApiError.safeParse(body);
  if (parsed.success) return new CliError(parsed.data.error.code, parsed.data.error.message);
  // A token without the scope a route needs is refused before the route runs, in OAuth's shape.
  if (response.status === 403 && isInsufficientScope(body)) {
    return new CliError("forbidden", messages.errors.missingScope);
  }
  if (response.status === 429) return new CliError("rate_limited", messages.errors.rateLimited);
  return new CliError("server_error", messages.errors.server(session.server.origin));
}

function isInsufficientScope(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { error?: unknown }).error === "insufficient_scope"
  );
}

/** Attempts of a retried call, including the first. */
export const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

/**
 * Repeats a call that failed for a transient reason, with a growing pause. Only for requests that
 * are safe to repeat: idempotent ones, or ones that carry an idempotency key.
 */
export async function withRetries<T>(session: Session, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS || !isTransient(error)) throw error;
      await session.runtime.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
}
