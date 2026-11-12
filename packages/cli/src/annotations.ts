// portifact annotations: the annotation commands (plan sections 6 and 8). Each one is a thin call
// to /api/v1/artifacts/:id/annotations; the server applies every permission, state, version and
// limit rule. Bodies, quotes and author names are untrusted data written by reviewers: the text
// output strips control characters from them, and every command that prints them reminds on
// stderr that they are data, never instructions.
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ANCHOR_LIMITS,
  ANNOTATION_HISTORY_PAGE,
  ANNOTATION_LIMITS,
  AnchorPath,
  AnnotationBody,
  AnnotationDeleteResult,
  AnnotationEditResult,
  AnnotationExport,
  type AnnotationHistoryEntry,
  AnnotationHistoryPage,
  AnnotationId,
  AnnotationModeView,
  AnnotationPage,
  AnnotationsState,
  AnnotationTarget,
  AnnotationThreadState,
  AnnotationThreadView,
  AnnotationVersionFilter,
  CURRENT_VERSION,
  UNTRUSTED_ANNOTATIONS_NOTICE,
  VersionDownload,
  VersionManifest,
} from "@portifact/contracts";
import { z } from "zod";
import { callApi, withRetries } from "./api.ts";
import { parseArtifactId } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, annotationMessages as text } from "./messages.ts";
import { plain } from "./plain.ts";

export { plain };

import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import { parseVersionId } from "./versions.ts";

/** Threads asked for per request; list follows the cursor until the last page. */
const PAGE_SIZE = ANNOTATION_LIMITS.pageMax;
/** A body file larger than this can never hold a valid comment, so it is not read. */
const BODY_FILE_MAX_BYTES = ANNOTATION_LIMITS.bodyMaxBytes * 4;
const TARGET_FILE_MAX_BYTES = ANCHOR_LIMITS.targetMaxBytes * 4;

export function parseAnnotationId(value: string, kind: "thread" | "message"): string {
  const parsed = AnnotationId.safeParse(value.trim());
  if (!parsed.success) throw new CliError("invalid_input", text.errors.invalidId(kind, value));
  return parsed.data;
}

function base(artifactId: string): string {
  return `/artifacts/${artifactId}/annotations`;
}

function notice(io: Io): void {
  io.stderr(`${UNTRUSTED_ANNOTATIONS_NOTICE}\n`);
}

export async function setMode(
  io: Io,
  runtime: Runtime,
  id: string,
  mode: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const parsed = AnnotationsState.safeParse(mode);
  if (!parsed.success) throw new CliError("invalid_input", text.errors.invalidMode(mode));
  const session = await openSession(io, runtime);
  // Setting the same mode twice leaves the same state, so a retry is safe.
  const result = await withRetries(session, () =>
    callApi(session, {
      method: "PUT",
      path: `${base(artifactId)}/mode`,
      body: { mode: parsed.data },
      schema: AnnotationModeView,
    }),
  );
  if (options.json) {
    writeJson(io, { artifactId, ...result });
    return;
  }
  io.stdout(`${text.modeSet(artifactId, result.annotations)}\n`);
}

export interface ListOptions extends OutputOptions {
  status?: string | undefined;
  version?: string | undefined;
  cursor?: string | undefined;
}

export async function list(
  io: Io,
  runtime: Runtime,
  id: string,
  options: ListOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const filters = parseFilters(options);
  const session = await openSession(io, runtime);
  const threads: AnnotationThreadView[] = [];
  const removed: string[] = [];
  let cursor = options.cursor;
  let page: AnnotationPage;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...filters });
    if (cursor !== undefined) query.set("cursor", cursor);
    page = await callApi(session, {
      method: "GET",
      path: `${base(artifactId)}?${query}`,
      schema: AnnotationPage,
    });
    threads.push(...page.threads);
    removed.push(...page.removed);
    cursor = page.cursor;
  } while (page.hasMore);

  notice(io);
  if (options.json) {
    writeJson(io, {
      artifactId: page.artifactId,
      annotations: page.annotations,
      currentVersionId: page.currentVersionId,
      role: page.role,
      commentScope: page.commentScope,
      humanCheck: page.humanCheck,
      threads,
      removed,
      cursor: page.cursor,
    });
    return;
  }
  if (threads.length === 0) {
    io.stdout(`${text.listEmpty(artifactId, page.annotations)}\n`);
  } else {
    io.stdout(threads.map(formatThread).join("\n"));
  }
  if (removed.length > 0) io.stdout(`${text.removed(removed)}\n`);
  if (page.commentScope === "own") io.stderr(`${text.ownScope}\n`);
  io.stderr(`${text.listCursor(artifactId, page.cursor)}\n`);
}

export async function show(
  io: Io,
  runtime: Runtime,
  id: string,
  thread: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const threadId = parseAnnotationId(thread, "thread");
  const session = await openSession(io, runtime);
  const result = await callApi(session, {
    method: "GET",
    path: `${base(artifactId)}/threads/${threadId}`,
    schema: AnnotationThreadView,
  });
  writeThread(io, result, options);
}

export interface CreateOptions extends OutputOptions {
  bodyFile: string;
  target?: string | undefined;
  path?: string | undefined;
  version?: string | undefined;
}

export async function create(
  io: Io,
  runtime: Runtime,
  id: string,
  options: CreateOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  if (options.target !== undefined && options.path !== undefined) {
    throw new CliError("invalid_input", text.errors.targetAndPath);
  }
  const body = await readBody(options.bodyFile);
  const fromFile = options.target === undefined ? undefined : await readTarget(options.target);
  const path = options.path === undefined ? undefined : parsePath(options.path);
  const pinned = options.version === undefined ? undefined : parseVersionId(options.version);
  const session = await openSession(io, runtime);

  const versionId = pinned ?? (await currentVersion(session, artifactId));
  const target = fromFile ?? {
    schema: 1 as const,
    path: path ?? (await entrypoint(session, artifactId, versionId)),
    anchor: { kind: "document" as const },
  };
  // One key for every attempt, so a retry after a lost answer does not post twice.
  const idempotencyKey = randomUUID();
  const result = await withRetries(session, () =>
    callApi(session, {
      method: "POST",
      path: `${base(artifactId)}/threads`,
      headers: { "idempotency-key": idempotencyKey },
      body: { versionId, target, body },
      schema: AnnotationThreadView,
    }),
  );
  writeThread(io, result, options, text.created(result.id));
}

export interface BodyOptions extends OutputOptions {
  bodyFile: string;
}

export async function reply(
  io: Io,
  runtime: Runtime,
  id: string,
  thread: string,
  options: BodyOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const threadId = parseAnnotationId(thread, "thread");
  const body = await readBody(options.bodyFile);
  const session = await openSession(io, runtime);
  const idempotencyKey = randomUUID();
  const result = await withRetries(session, () =>
    callApi(session, {
      method: "POST",
      path: `${base(artifactId)}/threads/${threadId}/messages`,
      headers: { "idempotency-key": idempotencyKey },
      body: { body },
      schema: AnnotationThreadView,
    }),
  );
  writeThread(io, result, options, text.replied(result.id));
}

export interface EditOptions extends BodyOptions {
  revision: number;
}

export async function edit(
  io: Io,
  runtime: Runtime,
  id: string,
  message: string,
  options: EditOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const messageId = parseAnnotationId(message, "message");
  const body = await readBody(options.bodyFile);
  const session = await openSession(io, runtime);
  // Not retried: a retry after a lost answer would fail on the revision it already raised.
  const result = await callApi(session, {
    method: "PATCH",
    path: `${base(artifactId)}/messages/${messageId}`,
    body: { body, revision: options.revision },
    schema: AnnotationEditResult,
  });
  if ("thread" in result && result.thread === null) {
    // The edit applied in a thread the reader no longer sees.
    writeDeleted(io, artifactId, result, options, text.edited(messageId), false);
    return;
  }
  writeThread(io, result as AnnotationThreadView, options, text.edited(messageId));
}

export async function setThreadState(
  io: Io,
  runtime: Runtime,
  action: "resolve" | "reopen",
  id: string,
  thread: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const threadId = parseAnnotationId(thread, "thread");
  const session = await openSession(io, runtime);
  // Resolving a resolved thread, or reopening an open one, changes nothing, so a retry is safe.
  const result = await withRetries(session, () =>
    callApi(session, {
      method: "POST",
      path: `${base(artifactId)}/threads/${threadId}/${action}`,
      schema: AnnotationThreadView,
    }),
  );
  writeThread(io, result, options, text.threadState(threadId, result.state));
}

export interface ConfirmOptions extends OutputOptions {
  /** Confirms a permanent deletion without a prompt. */
  yes?: boolean;
}

export async function deleteMessage(
  io: Io,
  runtime: Runtime,
  id: string,
  message: string,
  options: ConfirmOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const messageId = parseAnnotationId(message, "message");
  await confirm(
    runtime,
    options,
    text.confirmDeleteMessage(messageId),
    `delete ${artifactId} ${messageId}`,
  );
  const session = await openSession(io, runtime);
  const result = await callApi(session, {
    method: "DELETE",
    path: `${base(artifactId)}/messages/${messageId}`,
    schema: AnnotationDeleteResult,
  });
  writeDeleted(io, artifactId, result, options, text.deletedMessage(messageId));
}

export const MODERATION_ACTIONS = ["hide", "unhide", "delete"] as const;
type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export async function moderate(
  io: Io,
  runtime: Runtime,
  id: string,
  message: string,
  action: string,
  options: ConfirmOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const messageId = parseAnnotationId(message, "message");
  if (!MODERATION_ACTIONS.includes(action as ModerationAction)) {
    throw new CliError("invalid_input", text.errors.invalidAction(action));
  }
  if (action === "delete") {
    await confirm(
      runtime,
      options,
      text.confirmModerateDelete(messageId),
      `moderate ${artifactId} ${messageId} delete`,
    );
  }
  const session = await openSession(io, runtime);
  const result = await callApi(session, {
    method: "POST",
    path: `${base(artifactId)}/messages/${messageId}/moderation`,
    body: { action },
    schema: AnnotationDeleteResult,
  });
  writeDeleted(io, artifactId, result, options, text.moderated(messageId, action));
}

export async function deleteThread(
  io: Io,
  runtime: Runtime,
  id: string,
  thread: string,
  options: ConfirmOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const threadId = parseAnnotationId(thread, "thread");
  await confirm(
    runtime,
    options,
    text.confirmDeleteThread(threadId),
    `delete-thread ${artifactId} ${threadId}`,
  );
  const session = await openSession(io, runtime);
  await callApi(session, { method: "DELETE", path: `${base(artifactId)}/threads/${threadId}` });
  if (options.json) {
    writeJson(io, { artifactId, threadId, deleted: true });
    return;
  }
  io.stdout(`${text.deletedThread(threadId)}\n`);
}

export interface ExportOptions extends OutputOptions {
  format: "json" | "markdown";
  status?: string | undefined;
  version?: string | undefined;
  out?: string | undefined;
}

export async function exportAnnotations(
  io: Io,
  runtime: Runtime,
  id: string,
  options: ExportOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const filters = parseFilters(options);
  const out = options.out === undefined ? undefined : resolve(options.out);
  if (out !== undefined && (await exists(out))) {
    throw new CliError("invalid_input", text.errors.outExists(out));
  }
  const session = await openSession(io, runtime);
  const query = new URLSearchParams({ format: options.format, ...filters });
  const path = `${base(artifactId)}/export?${query}`;
  let content: string;
  let threads: number | undefined;
  if (options.format === "json") {
    const data = await callApi(session, { method: "GET", path, schema: AnnotationExport });
    content = `${JSON.stringify(data)}\n`;
    threads = data.threads.length;
  } else {
    content = await callApi(session, { method: "GET", path, schema: z.string(), text: true });
  }
  notice(io);

  if (out === undefined) {
    io.stdout(content);
    return;
  }
  try {
    // A new file only, so an export never overwrites anything.
    await writeFile(out, content, { flag: "wx" });
  } catch {
    throw new CliError("invalid_input", text.errors.cannotWrite(out));
  }
  if (options.json) {
    writeJson(io, {
      artifactId,
      format: options.format,
      out,
      bytes: Buffer.byteLength(content),
      ...(threads === undefined ? {} : { threads }),
    });
    return;
  }
  io.stdout(`${text.exported(artifactId, options.format, out)}\n`);
}

/**
 * The artifact's whole comment action history (owner side only), oldest first, every page: who
 * created, edited, deleted, hid, resolved or reopened what, and when, without any text.
 */
export async function history(
  io: Io,
  runtime: Runtime,
  id: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const session = await openSession(io, runtime);
  const entries = await wholeHistory(session, artifactId);
  notice(io);
  if (options.json) {
    writeJson(io, { artifactId, entries });
    return;
  }
  if (entries.length === 0) {
    io.stdout(`${text.historyEmpty(artifactId)}\n`);
    return;
  }
  for (const entry of entries) {
    io.stdout(
      `${text.historyLine(
        formatDate(entry.at),
        plain(entry.kind),
        plain(entry.threadId),
        entry.messageId === null ? null : plain(entry.messageId),
        entry.actor ? plain(entry.actor.name) : text.goneAuthor,
      )}\n`,
    );
  }
}

/** Every page of an artifact's comment action history. */
export async function wholeHistory(
  session: Session,
  artifactId: string,
): Promise<AnnotationHistoryEntry[]> {
  const entries: AnnotationHistoryEntry[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(ANNOTATION_HISTORY_PAGE.max) });
    if (cursor !== null) query.set("cursor", cursor);
    const page: AnnotationHistoryPage = await withRetries(session, () =>
      callApi(session, {
        method: "GET",
        path: `${base(artifactId)}/history?${query}`,
        schema: AnnotationHistoryPage,
      }),
    );
    entries.push(...page.entries);
    cursor = page.entries.length === 0 ? null : page.nextCursor;
  } while (cursor !== null);
  return entries;
}

// Helpers

function parseFilters(options: { status?: string | undefined; version?: string | undefined }) {
  const filters: Record<string, string> = {};
  if (options.status !== undefined) {
    const state = AnnotationThreadState.safeParse(options.status);
    if (!state.success)
      throw new CliError("invalid_input", text.errors.invalidStatus(options.status));
    filters.state = state.data;
  }
  if (options.version !== undefined) {
    const version = AnnotationVersionFilter.safeParse(options.version);
    if (!version.success) {
      throw new CliError("invalid_input", text.errors.invalidVersion(options.version));
    }
    filters.version = version.data;
  }
  return filters;
}

async function readLimited(path: string, max: number): Promise<Buffer> {
  const absolute = resolve(path);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new CliError("invalid_input", text.errors.unreadable(absolute));
  }
  if (size > max) throw new CliError("invalid_input", text.errors.fileTooLarge(absolute, max));
  try {
    return await readFile(absolute);
  } catch {
    throw new CliError("invalid_input", text.errors.unreadable(absolute));
  }
}

function decode(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new CliError("invalid_input", text.errors.notUtf8(resolve(path)));
  }
}

/** Reads and checks a comment the same way the server will, before anything is sent. */
async function readBody(path: string): Promise<string> {
  const content = decode(await readLimited(path, BODY_FILE_MAX_BYTES), path);
  const parsed = AnnotationBody.safeParse(content);
  if (!parsed.success) {
    throw new CliError("invalid_input", text.errors.invalidBody(firstIssue(parsed.error)));
  }
  return parsed.data;
}

/** Reads a target file: one AnnotationTarget as JSON, checked with the shared contract. */
async function readTarget(path: string): Promise<AnnotationTarget> {
  const content = decode(await readLimited(path, TARGET_FILE_MAX_BYTES), path);
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new CliError("invalid_input", text.errors.targetNotJson(resolve(path)));
  }
  const parsed = AnnotationTarget.safeParse(raw);
  if (!parsed.success) {
    throw new CliError("invalid_input", text.errors.invalidTarget(firstIssue(parsed.error)));
  }
  return parsed.data;
}

function parsePath(value: string): string {
  const parsed = AnchorPath.safeParse(value);
  if (!parsed.success) throw new CliError("invalid_input", text.errors.invalidPath(value));
  return parsed.data;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue?.message ?? "invalid"}`;
}

/** The version a new thread goes on; any reader with access can read it from the list. */
async function currentVersion(session: Session, artifactId: string): Promise<string> {
  const page = await callApi(session, {
    method: "GET",
    path: `${base(artifactId)}?limit=1`,
    schema: AnnotationPage,
  });
  if (page.currentVersionId === null) {
    throw new CliError("not_found", text.errors.noCurrentVersion(artifactId));
  }
  return page.currentVersionId;
}

/**
 * The page a general comment points at: the version's entrypoint. The owner reads it from the
 * manifest; a reader of a Markdown or text artifact from its download; anyone else names a file.
 */
async function entrypoint(session: Session, artifactId: string, versionId: string) {
  const versionPath = `/artifacts/${artifactId}/versions/${versionId}`;
  try {
    const manifest = await callApi(session, {
      method: "GET",
      path: versionPath,
      schema: VersionManifest,
    });
    return manifest.entrypoint;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    const download = await callApi(session, {
      method: "GET",
      path: `/artifacts/${artifactId}/versions/${CURRENT_VERSION}/download`,
      schema: VersionDownload,
    });
    if (download.versionId === versionId) return download.entrypoint;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  throw new CliError("invalid_input", text.errors.pathNeeded(artifactId));
}

function isMissing(error: unknown): boolean {
  return error instanceof CliError && (error.code === "not_found" || error.code === "forbidden");
}

async function confirm(
  runtime: Runtime,
  options: ConfirmOptions,
  question: string,
  command: string,
): Promise<void> {
  if (options.yes) return;
  if (!runtime.prompt) {
    throw new CliError("invalid_input", text.errors.confirmationRequired(command));
  }
  const answer = await runtime.prompt(question);
  if (answer.trim().toLowerCase() !== "delete") {
    throw new CliError("cancelled", text.errors.deleteCancelled);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function writeThread(
  io: Io,
  thread: AnnotationThreadView,
  options: OutputOptions,
  summary?: string,
): void {
  notice(io);
  if (options.json) {
    writeJson(io, thread);
    return;
  }
  if (summary) io.stdout(`${summary}\n`);
  io.stdout(formatThread(thread));
}

function writeDeleted(
  io: Io,
  artifactId: string,
  result: AnnotationDeleteResult,
  options: OutputOptions,
  summary: string,
  withArtifact = true,
): void {
  if (options.json) {
    writeJson(io, withArtifact ? { artifactId, ...result } : result);
    return;
  }
  io.stdout(`${summary}\n`);
  if (result.thread === null) io.stdout(`${text.threadGone(result.threadId)}\n`);
}

/** A thread as readable text; every reviewer-written value goes through `plain`. */
export function formatThread(thread: AnnotationThreadView): string {
  const lines = [
    text.threadHeader(
      thread.id,
      thread.state,
      plain(thread.path),
      thread.current ? null : thread.versionId,
    ),
  ];
  if (thread.target.anchor.kind === "text") {
    lines.push(`  ${text.quote(plain(thread.target.anchor.quote.exact))}`);
  } else if (thread.target.anchor.kind === "element") {
    const { tagName, fingerprint } = thread.target.anchor;
    lines.push(`  ${text.element(tagName, plain(fingerprint))}`);
  }
  for (const message of thread.messages) {
    const author = message.author === null ? text.goneAuthor : plain(message.author.name);
    const flags = [
      message.own ? "you" : null,
      message.state === "visible" ? null : message.state,
      message.editedAt === null ? null : "edited",
    ].filter(Boolean);
    lines.push(
      `  - ${message.id}  ${author || text.unnamed}  ${formatDate(message.createdAt)}  rev ${message.revision}${flags.length ? `  (${flags.join(", ")})` : ""}`,
    );
    const body = message.body === null ? text.noBody(message.state) : plain(message.body);
    for (const line of body.split("\n")) lines.push(`    ${line}`);
  }
  for (const issue of thread.issues ?? []) {
    lines.push(
      `  ${text.issue(issue.state, issue.key, plain(issue.target), issue.url, issue.failure)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
