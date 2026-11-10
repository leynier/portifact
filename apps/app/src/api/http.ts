// Request and response helpers shared by the /api/v1 route modules.
import {
  ERROR_STATUS,
  type ErrorCode,
  IdempotencyKey,
  type OAuthScope,
} from "@portifact/contracts";
import { defaultDb } from "../regions.ts";
import { hashRequest, runIdempotent, type StoredResponse } from "@portifact/services";
import type { Context } from "hono";
import type { z } from "zod";
import type { Env } from "../env.ts";

export type ApiContext = Context<{ Bindings: Env }>;

/** Runs a handler for the calling user once the token or session allows `scope`. */
export type Guarded = (
  scope: OAuthScope,
  handler: (c: ApiContext, userId: string) => Promise<Response>,
) => (c: ApiContext) => Promise<Response>;

export function failure(code: ErrorCode, message: string): StoredResponse {
  return { status: ERROR_STATUS[code], body: { error: { code, message } } };
}

export function error(c: ApiContext, code: ErrorCode, message: string) {
  const { status, body } = failure(code, message);
  return c.json(body, status as 400);
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Reads and validates a JSON body. With `maxBytes`, a larger body is refused before parsing.
 */
export async function readJson<T extends z.ZodType>(
  c: ApiContext,
  schema: T,
  maxBytes?: number,
): Promise<{ ok: true; value: z.infer<T> } | { ok: false; response: Response }> {
  if (!c.req.header("content-type")?.includes("application/json")) {
    return { ok: false, response: error(c, "invalid_input", "Send a JSON body.") };
  }
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (maxBytes !== undefined && new TextEncoder().encode(text).length > maxBytes) {
      return {
        ok: false,
        response: error(c, "invalid_input", `The body can be at most ${maxBytes} bytes.`),
      };
    }
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: error(c, "invalid_input", "The body is not valid JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      ok: false,
      response: error(c, "invalid_input", `${where}${issue?.message ?? "Invalid input."}`),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Runs `work` once per `Idempotency-Key` for the user: a retry with the same key and request
 * gets the stored response. `request` must identify the whole request, path included.
 */
export async function idempotent(
  c: ApiContext,
  input: { userId: string; operation: string; request: unknown; now: number },
  work: () => Promise<StoredResponse>,
): Promise<Response> {
  const key = IdempotencyKey.safeParse(c.req.header("idempotency-key"));
  if (!key.success) {
    return error(c, "invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
  }
  const outcome = await runIdempotent(
    defaultDb(c.env),
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
  return c.json(outcome.response.body, outcome.response.status as 201);
}
