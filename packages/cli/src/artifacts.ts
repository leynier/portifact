// list, info, the lifecycle commands (renew, archive, restore, delete, pin, unpin) and access
// control. Each
// is a thin call to the API; the server applies every rule and the CLI only shapes the output.
import {
  AccessMode,
  AccessPolicyView,
  type AccessUpdate,
  ArtifactId,
  ArtifactList,
  type ArtifactListFilters,
  ArtifactSummary,
  CommentVisibility,
  Email,
  LIMITS,
  LifecycleResult,
  PublishKey,
  ReaderCommentVisibility,
} from "@portifact/contracts";
import { callApi } from "./api.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import { chosenWorkspace, ownerLabel, workspaceQuery } from "./workspaces.ts";

export function parseArtifactId(value: string): string {
  const parsed = ArtifactId.safeParse(value.trim());
  if (!parsed.success)
    throw new CliError("invalid_input", messages.errors.invalidArtifactId(value));
  return parsed.data;
}

export interface ListOptions extends OutputOptions {
  /** A workspace slug or `personal`; the device's default when absent. */
  workspace?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  filters?: ArtifactListFilters | undefined;
}

/** A value as one shell word, so a printed command can be pasted back. */
function shellWord(value: string): string {
  return /^[\w.@:/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The filters as the flags that ask for them again, each with a leading space. */
function filterFlags(filters: ArtifactListFilters = {}): string {
  return Object.entries(filters)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ` --${name} ${shellWord(value)}`)
    .join("");
}

export async function list(io: Io, runtime: Runtime, options: ListOptions): Promise<void> {
  const session = await openSession(io, runtime);
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  for (const [name, value] of Object.entries(options.filters ?? {})) {
    if (typeof value === "string") query.set(name, value);
  }
  const workspace = await chosenWorkspace(session, options.workspace);
  const search = workspaceQuery(workspace, query);
  const page = await callApi(session, {
    method: "GET",
    path: `/artifacts${search}`,
    schema: ArtifactList,
  });

  if (options.json) {
    writeJson(io, page);
    return;
  }
  const filters = filterFlags(options.filters);
  const flags = filters + (workspace ? ` --workspace ${workspace}` : "");
  // A workspace's list says whose it is; the personal list looks as it always did.
  if (workspace !== undefined) io.stdout(`Workspace: ${workspace}\n`);
  if (page.items.length === 0 && page.nextCursor === null) {
    io.stdout(`${filters ? messages.listNoMatch : messages.listEmpty}\n`);
    return;
  }
  // A custom domain column only when an artifact on the page has one.
  const domains = page.items.some((item) => item.customHost !== undefined);
  const rows = [
    ["ID", "STATE", "ACCESS", "TYPE", "EXPIRES", ...(domains ? ["DOMAIN"] : []), "NAME"],
    ...page.items.map((item) => [
      item.id,
      item.state,
      item.accessMode,
      item.type,
      item.pinned ? "pinned" : item.expiresAt === null ? "never" : item.expiresAt.slice(0, 10),
      ...(domains ? [item.customHost ?? "-"] : []),
      item.name,
    ]),
  ];
  io.stdout(table(rows));
  if (page.nextCursor !== null) io.stderr(`${messages.listMore(page.nextCursor, flags)}\n`);
}

export async function info(
  io: Io,
  runtime: Runtime,
  id: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const session = await openSession(io, runtime);
  const artifact = await callApi(session, {
    method: "GET",
    path: `/artifacts/${artifactId}`,
    schema: ArtifactSummary,
  });
  if (options.json) {
    writeJson(io, artifact);
    return;
  }
  io.stdout(
    table([
      ["ID", artifact.id],
      ["Name", artifact.name],
      ["Type", artifact.type],
      ["State", artifact.state],
      ...(artifact.suspension
        ? [["Suspended", `${artifact.suspension.reason}; write to abuse@portifact.com to appeal`]]
        : []),
      ["Access", artifact.accessMode],
      ["Annotations", artifact.annotations],
      ["URL", artifact.url],
      ["Space", ownerLabel(artifact.owner)],
      ...(artifact.customHost ? [["Custom domain", artifact.customHost]] : []),
      ["Pinned", artifact.pinned ? "yes, no expiry" : "no"],
      ["Expires", formatDate(artifact.expiresAt)],
      ["Archived", formatDate(artifact.archivedAt)],
      ["Purge", formatDate(artifact.purgeAt)],
      ["Created", formatDate(artifact.createdAt)],
      ["Updated", formatDate(artifact.updatedAt)],
    ]),
  );
}

export type LifecycleAction = "renew" | "archive" | "restore" | "delete" | "pin" | "unpin";

export interface LifecycleOptions extends OutputOptions {
  /** Confirms a permanent deletion without a prompt. */
  yes?: boolean;
}

export async function lifecycle(
  io: Io,
  runtime: Runtime,
  action: LifecycleAction,
  id: string,
  options: LifecycleOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  if (action === "delete" && !options.yes && !runtime.prompt) {
    throw new CliError("invalid_input", messages.errors.confirmationRequired(artifactId));
  }
  const session = await openSession(io, runtime);

  if (action === "delete" && !options.yes && runtime.prompt) {
    const artifact = await callApi(session, {
      method: "GET",
      path: `/artifacts/${artifactId}`,
      schema: ArtifactSummary,
    });
    const answer = await runtime.prompt(messages.confirmDelete(artifact.id, artifact.name));
    if (answer.trim().toLowerCase() !== artifactId) {
      throw new CliError("cancelled", messages.errors.deleteCancelled);
    }
  }

  const result = await callApi(session, {
    method: action === "delete" ? "DELETE" : "POST",
    path: action === "delete" ? `/artifacts/${artifactId}` : `/artifacts/${artifactId}/${action}`,
    schema: LifecycleResult,
  });
  if (options.json) {
    writeJson(io, { artifactId, ...result });
    return;
  }
  const text = {
    renew: () => messages.renewed(artifactId, result.expiresAt),
    archive: () => messages.archived(artifactId, result.purgeAt),
    restore: () => messages.restored(artifactId, result.expiresAt),
    pin: () => messages.pinned(artifactId),
    unpin: () => messages.unpinned(artifactId, result.expiresAt),
    delete: () => messages.deleted(artifactId),
  }[action]();
  io.stdout(`${text}\n`);
}

/**
 * `portifact delete --key`: finds the space's artifact with the key and deletes it by ID through
 * the same route, scopes and confirmation. A key nothing holds deletes nothing and succeeds, so
 * a CI job that cleans up a closed pull request can run twice.
 */
export async function deleteByKey(
  io: Io,
  runtime: Runtime,
  rawKey: string,
  options: LifecycleOptions & { workspace?: string | undefined },
): Promise<void> {
  const key = parsePublishKey(rawKey);
  if (!options.yes && !runtime.prompt) {
    throw new CliError("invalid_input", messages.errors.keyConfirmationRequired(key));
  }
  const session = await openSession(io, runtime);
  const artifact = await artifactWithKey(
    session,
    key,
    await chosenWorkspace(session, options.workspace),
  );
  if (!artifact) {
    if (options.json) writeJson(io, { key, deleted: false });
    else io.stdout(`${messages.nothingWithKey(key)}\n`);
    return;
  }
  if (!options.yes && runtime.prompt) {
    const answer = await runtime.prompt(messages.confirmDelete(artifact.id, artifact.name));
    if (answer.trim().toLowerCase() !== artifact.id) {
      throw new CliError("cancelled", messages.errors.deleteCancelled);
    }
  }
  const result = await callApi(session, {
    method: "DELETE",
    path: `/artifacts/${artifact.id}`,
    schema: LifecycleResult,
  });
  if (options.json) {
    writeJson(io, { key, artifactId: artifact.id, deleted: true, ...result });
    return;
  }
  io.stdout(`${messages.deleted(artifact.id)}\n`);
}

/** A publish key from the command line, checked like the API checks it. */
export function parsePublishKey(value: string): string {
  const parsed = PublishKey.safeParse(value);
  if (!parsed.success) throw new CliError("invalid_input", messages.errors.invalidKey(value));
  return parsed.data;
}

/** The artifact of the space that holds `key`, if any. */
export async function artifactWithKey(
  session: Session,
  key: string,
  workspace: string | undefined,
): Promise<ArtifactSummary | undefined> {
  const list = await callApi(session, {
    method: "GET",
    path: `/artifacts${workspaceQuery(workspace, new URLSearchParams({ key }))}`,
    schema: ArtifactList,
  });
  return list.items[0];
}

export async function showAccess(
  io: Io,
  runtime: Runtime,
  id: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const session = await openSession(io, runtime);
  const policy = await callApi(session, {
    method: "GET",
    path: `/artifacts/${artifactId}/access`,
    schema: AccessPolicyView,
  });
  writeAccess(io, artifactId, policy, options);
}

export type AccessChange =
  | { kind: "mode"; mode: string }
  | { kind: "bar"; state: string }
  | { kind: "comments"; visibility: string }
  | { kind: "reader-comments"; email: string; visibility: string }
  | { kind: "add" | "remove"; emails: readonly string[] };

export async function changeAccess(
  io: Io,
  runtime: Runtime,
  id: string,
  change: AccessChange,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const update = accessUpdate(change);
  const session = await openSession(io, runtime);
  const policy = await callApi(session, {
    method: "PATCH",
    path: `/artifacts/${artifactId}/access`,
    body: update,
    schema: AccessPolicyView,
  });
  if (!options.json) io.stdout(`${messages.accessChanged(artifactId)}\n`);
  if (change.kind === "add" && policy.mode !== "restricted") {
    io.stderr(`${messages.readersOnlyWhenRestricted(policy.mode)}\n`);
  }
  writeAccess(io, artifactId, policy, options);
}

// Checked before any request, so a typo never reaches the server as a partial change.
function accessUpdate(change: AccessChange): AccessUpdate {
  if (change.kind === "mode") {
    const mode = AccessMode.safeParse(change.mode);
    if (!mode.success)
      throw new CliError("invalid_input", messages.errors.invalidMode(change.mode));
    return { mode: mode.data };
  }
  if (change.kind === "bar") {
    if (change.state !== "on" && change.state !== "off") {
      throw new CliError("invalid_input", messages.errors.invalidBarState(change.state));
    }
    return { bar: change.state === "on" };
  }
  if (change.kind === "comments") {
    const visibility = CommentVisibility.safeParse(change.visibility);
    if (!visibility.success) {
      throw new CliError(
        "invalid_input",
        messages.errors.invalidCommentVisibility(change.visibility),
      );
    }
    return { commentVisibility: visibility.data };
  }
  if (change.kind === "reader-comments") {
    const email = Email.safeParse(change.email.trim());
    if (!email.success)
      throw new CliError("invalid_input", messages.errors.invalidEmail(change.email));
    const visibility = ReaderCommentVisibility.safeParse(change.visibility);
    if (!visibility.success) {
      throw new CliError(
        "invalid_input",
        messages.errors.invalidReaderCommentVisibility(change.visibility),
      );
    }
    return { readerCommentVisibility: [{ email: email.data, commentVisibility: visibility.data }] };
  }
  if (change.emails.length > LIMITS.readersPerChange) {
    throw new CliError("invalid_input", messages.errors.tooManyReaders(LIMITS.readersPerChange));
  }
  const emails = change.emails.map((email) => {
    const parsed = Email.safeParse(email.trim());
    if (!parsed.success) throw new CliError("invalid_input", messages.errors.invalidEmail(email));
    return parsed.data;
  });
  return change.kind === "add" ? { addReaders: emails } : { removeReaders: emails };
}

function writeAccess(
  io: Io,
  artifactId: string,
  policy: AccessPolicyView,
  options: OutputOptions,
): void {
  if (options.json) {
    writeJson(io, { artifactId, ...policy });
    return;
  }
  const exceptions = new Map(
    policy.readerCommentVisibility.map((entry) => [entry.email, entry.commentVisibility]),
  );
  const reader = (email: string) => {
    const exception = exceptions.get(email);
    return exception === undefined ? email : `${email} (${messages.readerSees[exception]})`;
  };
  io.stdout(
    table([
      ["Access", policy.mode],
      ["Readers", policy.readers.length > 0 ? policy.readers.map(reader).join(", ") : "none"],
      ["Comments", messages.commentVisibility[policy.commentVisibility]],
      ["Indexable", policy.indexable ? "yes" : "no"],
      ["Embeddable", policy.embeddable ? "yes" : "no"],
      ["Portifact bar", policy.bar ? "on" : "off"],
    ]),
  );
}

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join("  "),
    )
    .map((line) => `${line}\n`)
    .join("");
}
