// The /api/v1/artifacts/:id/annotations routes of the fake server. They follow apps/app's
// contract for one signed-in user who owns every seeded artifact: the same shapes (validated with
// packages/contracts), error codes, Idempotency-Key replay, message revisions, the current-version
// check and incremental cursors. Permissions beyond ownership live in the real service and its
// tests; here a test scripts the role with `role`.
import { randomUUID } from "node:crypto";
import {
  type AnnotationsState,
  type AnnotationThreadView,
  CreateThreadRequest,
  EditMessageRequest,
  IdempotencyKey,
  ModerateMessageRequest,
  ReplyRequest,
  UNTRUSTED_ANNOTATIONS_NOTICE,
} from "@portifact/contracts";
import { error, type FakeArtifact, type Reply } from "./fake-api.ts";

export interface FakeAnnotationState {
  /** Mode of each artifact; artifacts start with annotations off. */
  modes: Map<string, AnnotationsState>;
  threads: Map<string, AnnotationThreadView & { artifactId: string; seq: number }>;
  /** IDs of deleted threads with the sequence of their deletion, for incremental lists. */
  deleted: { id: string; artifactId: string; seq: number }[];
  /** The caller's role; a participant cannot moderate or change the mode. */
  role: "owner" | "participant";
  /** Which threads the caller sees; the fake lists every thread whatever it says. */
  commentScope: "all" | "own";
  /** Every request body the API received, by route, to check what the CLI sent. */
  bodies: unknown[];
}

const PATH = /^\/artifacts\/([^/]+)\/annotations(?:\/(.+))?$/;

/** The scope each annotation route needs, as apps/app/src/api/annotations.ts checks it. */
export function annotationScope(method: string, pathname: string): string | undefined {
  const match = PATH.exec(pathname.slice("/api/v1".length));
  if (!match) return undefined;
  const rest = match[2] ?? "";
  if (method === "GET") return "annotations:read";
  if (rest === "mode" || /\/moderation$/.test(rest)) return "annotations:moderate";
  if (method === "DELETE" && rest.startsWith("threads/")) return "annotations:moderate";
  return "annotations:write";
}

export function createFakeAnnotations(
  artifacts: Map<string, FakeArtifact>,
  userId: () => string,
  clock: () => number,
) {
  const idempotency = new Map<string, { hash: string; reply: Reply }>();
  let seq = 0;
  const state: FakeAnnotationState = {
    modes: new Map(),
    threads: new Map(),
    deleted: [],
    role: "owner",
    commentScope: "all",
    bodies: [],
  };

  const iso = () => new Date(clock()).toISOString();
  const view = ({
    artifactId: _a,
    seq: _s,
    ...thread
  }: AnnotationThreadView & {
    artifactId: string;
    seq: number;
  }): AnnotationThreadView => thread;

  function touch(thread: AnnotationThreadView & { artifactId: string; seq: number }) {
    seq += 1;
    thread.seq = seq;
    thread.updatedAt = iso();
  }

  function replay(key: string | undefined, hash: string, run: () => Reply): Reply {
    const parsed = IdempotencyKey.safeParse(key);
    if (!parsed.success) return error("invalid_input", "Send an Idempotency-Key header.");
    const previous = idempotency.get(parsed.data);
    if (previous) {
      if (previous.hash !== hash) return error("invalid_input", "Key used for another request.");
      return previous.reply;
    }
    const reply = run();
    idempotency.set(parsed.data, { hash, reply });
    return reply;
  }

  function writable(artifact: FakeArtifact): Reply | undefined {
    if (artifact.state === "archived") return error("artifact_archived", "Artifact archived.");
    const mode = state.modes.get(artifact.id) ?? "off";
    if (mode !== "open") return error("forbidden", `Annotations are ${mode}.`);
    return undefined;
  }

  function message(body: string) {
    return {
      id: randomUUID(),
      author: { id: userId(), name: "Ada", image: null },
      own: true,
      state: "visible" as const,
      body,
      revision: 1,
      createdAt: iso(),
      editedAt: null,
    };
  }

  function findMessage(artifactId: string, messageId: string) {
    for (const thread of state.threads.values()) {
      if (thread.artifactId !== artifactId) continue;
      const found = thread.messages.find((m) => m.id === messageId);
      if (found) return { thread, message: found };
    }
    return undefined;
  }

  function afterRemoval(thread: AnnotationThreadView & { artifactId: string; seq: number }) {
    if (thread.messages.every((m) => m.state === "deleted")) {
      state.threads.delete(thread.id);
      seq += 1;
      state.deleted.push({ id: thread.id, artifactId: thread.artifactId, seq });
      return { status: 200, body: { threadId: thread.id, thread: null } };
    }
    touch(thread);
    return { status: 200, body: { threadId: thread.id, thread: view(thread) } };
  }

  function list(artifact: FakeArtifact, url: URL): Reply {
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const cursor = url.searchParams.get("cursor");
    const since = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(since)) {
      return error("invalid_input", "Invalid cursor, limit, version or state.");
    }
    const status = url.searchParams.get("state");
    const changed = [...state.threads.values()]
      .filter((t) => t.artifactId === artifact.id && t.seq > since)
      .filter((t) => status === null || t.state === status)
      .sort((a, b) => a.seq - b.seq);
    const page = changed.slice(0, limit);
    const removed = state.deleted
      .filter((d) => d.artifactId === artifact.id && d.seq > since && cursor !== null)
      .map((d) => d.id);
    const last = page.at(-1)?.seq ?? Math.max(since, seq);
    return {
      status: 200,
      body: {
        artifactId: artifact.id,
        annotations: state.modes.get(artifact.id) ?? "off",
        currentVersionId: artifact.currentVersionId,
        role: state.role,
        commentScope: state.commentScope,
        threads: page.map(view),
        removed,
        cursor: String(changed.length > limit ? last : Math.max(last, seq)),
        hasMore: changed.length > limit,
      },
    };
  }

  function exportAll(artifact: FakeArtifact, url: URL): Reply {
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "markdown") {
      return error("invalid_input", "Invalid format, version or state.");
    }
    const status = url.searchParams.get("state");
    const threads = [...state.threads.values()]
      .filter((t) => t.artifactId === artifact.id && (status === null || t.state === status))
      .map(view);
    const data = {
      notice: UNTRUSTED_ANNOTATIONS_NOTICE,
      exportedAt: iso(),
      artifact: {
        id: artifact.id,
        name: artifact.name,
        type: artifact.type,
        annotations: state.modes.get(artifact.id) ?? "off",
        currentVersionId: artifact.currentVersionId,
      },
      threads,
    };
    if (format === "json") return { status: 200, body: data };
    const markdown = [
      `# Annotations on ${artifact.name}`,
      "",
      `> ${UNTRUSTED_ANNOTATIONS_NOTICE}`,
      "",
      ...threads.map(
        (t) => `## Thread ${t.id} (${t.state})\n\n${t.messages.map((m) => m.body).join("\n\n")}\n`,
      ),
    ].join("\n");
    return { status: 200, body: markdown };
  }

  /** Answers an annotation route, or undefined when the path is not one. */
  function api(method: string, url: URL, key: string | undefined, raw: string): Reply | undefined {
    const match = PATH.exec(url.pathname.slice("/api/v1".length));
    if (!match) return undefined;
    const artifact = artifacts.get(match[1] as string);
    if (!artifact || artifact.state === "deleted") return error("not_found", "Artifact not found.");
    const rest = match[2] ?? "";
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return error("invalid_input", "The body is not valid JSON.");
    }
    if (body !== undefined) state.bodies.push(body);

    if (method === "PUT" && rest === "mode") {
      if (state.role !== "owner") return error("not_found", "Artifact not found.");
      const mode = (body as { mode?: unknown } | undefined)?.mode;
      if (mode !== "off" && mode !== "open" && mode !== "locked") {
        return error("invalid_input", "mode: Invalid option");
      }
      state.modes.set(artifact.id, mode);
      return { status: 200, body: { annotations: mode } };
    }
    if (method === "GET" && rest === "") return list(artifact, url);
    if (method === "GET" && rest === "export") return exportAll(artifact, url);

    if (method === "POST" && rest === "threads") {
      return replay(key, `thread ${artifact.id} ${raw}`, () => {
        const parsed = CreateThreadRequest.safeParse(body);
        if (!parsed.success) return error("invalid_input", "Invalid thread.");
        const refused = writable(artifact);
        if (refused) return refused;
        if (parsed.data.versionId !== artifact.currentVersionId) {
          return error("version_conflict", "This version is no longer the current one.");
        }
        const thread = {
          id: randomUUID(),
          artifactId: artifact.id,
          seq: 0,
          versionId: parsed.data.versionId,
          current: true,
          path: parsed.data.target.path,
          target: parsed.data.target,
          state: "open" as const,
          author: { id: userId(), name: "Ada", image: null },
          own: true,
          revision: 1,
          createdAt: iso(),
          updatedAt: iso(),
          resolvedAt: null,
          messages: [message(parsed.data.body)],
        };
        touch(thread);
        state.threads.set(thread.id, thread);
        return { status: 201, body: view(thread) };
      });
    }

    let parts = /^threads\/([^/]+)(?:\/(messages|resolve|reopen))?$/.exec(rest);
    if (parts) {
      const thread = state.threads.get(parts[1] as string);
      if (!thread || thread.artifactId !== artifact.id)
        return error("not_found", "Thread not found.");
      const action = parts[2];
      if (method === "GET" && !action) return { status: 200, body: view(thread) };
      if (method === "DELETE" && !action) {
        if (state.role !== "owner") return error("forbidden", "Only the owner can delete threads.");
        state.threads.delete(thread.id);
        seq += 1;
        state.deleted.push({ id: thread.id, artifactId: artifact.id, seq });
        return { status: 204 };
      }
      if (method === "POST" && action === "messages") {
        return replay(key, `reply ${thread.id} ${raw}`, () => {
          const parsed = ReplyRequest.safeParse(body);
          if (!parsed.success) return error("invalid_input", "Invalid reply.");
          const refused = writable(artifact);
          if (refused) return refused;
          thread.messages.push(message(parsed.data.body));
          thread.revision += 1;
          touch(thread);
          return { status: 201, body: view(thread) };
        });
      }
      if (method === "POST" && (action === "resolve" || action === "reopen")) {
        const next = action === "resolve" ? "resolved" : "open";
        if (thread.state !== next) {
          thread.state = next;
          thread.resolvedAt = next === "resolved" ? iso() : null;
          thread.revision += 1;
          touch(thread);
        }
        return { status: 200, body: view(thread) };
      }
      return undefined;
    }

    parts = /^messages\/([^/]+)(\/moderation)?$/.exec(rest);
    if (parts) {
      const found = findMessage(artifact.id, parts[1] as string);
      if (!found) return error("not_found", "Message not found.");
      const { thread, message: target } = found;
      if (method === "PATCH" && !parts[2]) {
        const parsed = EditMessageRequest.safeParse(body);
        if (!parsed.success) return error("invalid_input", "Invalid edit.");
        if (!target.own) return error("forbidden", "You can only edit your own messages.");
        if (parsed.data.revision !== target.revision) {
          return error("version_conflict", "The annotations changed meanwhile.");
        }
        target.body = parsed.data.body;
        target.revision += 1;
        target.editedAt = iso();
        touch(thread);
        return { status: 200, body: view(thread) };
      }
      if (method === "DELETE" && !parts[2]) {
        if (!target.own) return error("forbidden", "You can only delete your own messages.");
        target.state = "deleted";
        target.body = null;
        return afterRemoval(thread);
      }
      if (method === "POST" && parts[2]) {
        const parsed = ModerateMessageRequest.safeParse(body);
        if (!parsed.success) return error("invalid_input", "action: Invalid option");
        if (state.role !== "owner") return error("forbidden", "Only the owner can moderate.");
        if (parsed.data.action === "delete") {
          target.state = "deleted";
          target.body = null;
          return afterRemoval(thread);
        }
        target.state = parsed.data.action === "hide" ? "hidden" : "visible";
        touch(thread);
        return { status: 200, body: { threadId: thread.id, thread: view(thread) } };
      }
    }
    return undefined;
  }

  return { state, api };
}
