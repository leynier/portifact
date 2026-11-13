// The change list routes of the fake API (decision 0027), as apps/app/src/api/suggestions.ts
// answers them: GET /artifacts/:id/changes (state, cursor, limit), GET and PATCH
// /artifacts/:id/changes/:itemId with an idempotency key, the owner side only.
import { type ChangeItemView, MarkChangeItem } from "@portifact/contracts";
import { error, type Reply } from "./fake-api.ts";

const PATH = /^\/artifacts\/([^/]+)\/changes(?:\/([^/]+))?$/;

/** The scope each change list route needs. */
export function changeScope(method: string, pathname: string): string | undefined {
  if (!PATH.test(pathname.slice("/api/v1".length))) return undefined;
  return method === "GET" ? "annotations:read" : "annotations:write";
}

export interface FakeChangeState {
  /** Items by artifact, oldest first. An artifact without an entry answers not_found. */
  items: Map<string, ChangeItemView[]>;
  /** Artifacts whose list the caller may not read (a reader, not the owner side). */
  forbidden: Set<string>;
}

export function createFakeChanges(clock: () => number) {
  const state: FakeChangeState = { items: new Map(), forbidden: new Set() };
  const replies = new Map<string, { raw: string; reply: Reply }>();

  function api(method: string, url: URL, key: string | undefined, raw: string): Reply | undefined {
    const match = PATH.exec(url.pathname.slice("/api/v1".length));
    if (!match) return undefined;
    const artifactId = decodeURIComponent(match[1] as string);
    const items = state.items.get(artifactId);
    if (!items) return error("not_found", "Artifact not found.");
    if (state.forbidden.has(artifactId)) {
      return error("forbidden", "Only the people who manage the artifact read its change list.");
    }
    const itemId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (itemId === undefined) {
      if (method !== "GET") return undefined;
      const wanted = url.searchParams.get("state");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const matching = items.filter((item) => wanted === null || item.state === wanted);
      const page = matching.slice(start, start + limit);
      const next = start + limit < matching.length ? String(start + limit) : null;
      return { status: 200, body: { items: page, nextCursor: next } };
    }
    const item = items.find((one) => one.id === itemId);
    if (!item) return error("not_found", "Change item not found.");
    if (method === "GET") return { status: 200, body: item };
    if (method !== "PATCH") return undefined;
    if (key === undefined) {
      return error("invalid_input", "Send an Idempotency-Key header (8 to 128 characters).");
    }
    const stored = replies.get(key);
    if (stored) {
      return stored.raw === raw
        ? stored.reply
        : error("invalid_input", "This Idempotency-Key was used for a different request.");
    }
    const body = MarkChangeItem.safeParse(JSON.parse(raw || "{}"));
    let reply: Reply;
    if (!body.success) {
      reply = error("invalid_input", body.error.issues[0]?.message ?? "Invalid input.");
    } else if (body.data.baseRevision !== item.revision) {
      reply = error("version_conflict", "The item changed meanwhile. Reload and try again.");
    } else {
      const reopening = body.data.state === "open";
      Object.assign(item, {
        state: body.data.state,
        closedAt: reopening ? null : clock(),
        closedVersionId: null,
        revision: item.revision + 1,
      });
      reply = { status: 200, body: { ...item } };
    }
    replies.set(key, { raw, reply });
    return reply;
  }

  return { state, api };
}
