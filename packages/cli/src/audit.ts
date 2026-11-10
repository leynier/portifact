// portifact audit: who changed what in your personal space or a workspace, as GET /api/v1/audit
// reports it (premium plan T10). Only admins can read it, on plans that include the audit log;
// the API answers forbidden or plan_required otherwise. This follows the cursor up to --limit.
import { open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AUDIT_EXPORT_CURSOR_HEADER,
  AUDIT_KINDS,
  type AuditEventView,
  AuditExportFormat,
  AuditKind,
  AuditLogView,
} from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi, downloadApi, withRetries } from "./api.ts";
import { table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { parseSince } from "./logs.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import { chosenWorkspace, workspaceQuery } from "./workspaces.ts";

/** Events asked for per request: the API's largest page. */
const PAGE_SIZE = 100;
const MAX_EVENTS = 1_000;

export interface AuditOptions extends OutputOptions {
  workspace?: string | undefined;
  kind?: string[] | undefined;
  actor?: string | undefined;
  target?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: string | undefined;
}

function parseKinds(values: readonly string[]): string[] {
  const kinds = values.flatMap((value) => value.split(",")).map((kind) => kind.trim());
  for (const kind of kinds) {
    if (!AuditKind.safeParse(kind).success) {
      throw new CliError(
        "invalid_input",
        `${JSON.stringify(kind)} is not an audit event kind. Kinds: ${AUDIT_KINDS.join(", ")}.`,
      );
    }
  }
  return kinds;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return PAGE_SIZE;
  const limit = Number(value);
  if (!/^\d{1,4}$/.test(value) || limit < 1 || limit > MAX_EVENTS) {
    throw new CliError("invalid_input", `--limit must be a whole number from 1 to ${MAX_EVENTS}.`);
  }
  return limit;
}

/** Who acted, in words. */
export function auditActor(actor: AuditEventView["actor"]): string {
  switch (actor.type) {
    case "member":
      return plain(actor.name);
    case "removed_member":
      return "Removed member";
    case "service_token":
      return actor.label === null
        ? "Revoked service token"
        : `${plain(actor.label)} (service token)`;
    case "operator":
      return "Portifact operator";
    case "system":
      return "Portifact";
  }
}

const ROLE = { admin: "admin", editor: "editor", member: "member" } as const;

/** What happened, in plain words. */
export function auditSummary(event: AuditEventView): string {
  const d = event.detail as Record<string, unknown>;
  const member = event.target.member ? auditActor(event.target.member) : "a member";
  switch (event.kind) {
    case "artifact.published":
      return d.first
        ? `Published version ${d.version} (new artifact)`
        : `Published version ${d.version}`;
    case "artifact.rolled_back":
      return `Rolled back to the files of version ${d.from} (now version ${d.version})`;
    case "artifact.renewed":
      return "Renewed";
    case "artifact.archived":
      return "Archived";
    case "artifact.restored":
      return "Restored";
    case "artifact.deleted":
      return "Deleted";
    case "artifact.pinned":
      return "Pinned";
    case "artifact.unpinned":
      return "Unpinned";
    case "artifact.transferred_in":
      return `Moved here from ${d.from === "workspace" ? "a workspace" : "a personal space"}`;
    case "artifact.transferred_out":
      return `Moved to ${d.to === "workspace" ? "a workspace" : "a personal space"}`;
    case "access.changed":
      return `Changed access: ${accessParts(d).join(", ")}`;
    case "share_link.created":
      return `Created a share link${d.password ? " with a password" : ""}${d.expires ? " that expires" : ""}`;
    case "share_link.revoked":
      return "Revoked a share link";
    case "review.requested":
      return `Asked ${d.reviewers} ${d.reviewers === 1 ? "person" : "people"} to review${d.required === null ? "" : ` (${d.required} approval${d.required === 1 ? "" : "s"} required)`}`;
    case "review.changed":
      return `Changed a review request${[
        d.added === undefined ? "" : `: ${d.added} added`,
        d.removed === undefined ? "" : `${d.added === undefined ? ":" : ","} ${d.removed} removed`,
      ].join("")}`;
    case "review.cancelled":
      return "Cancelled a review request";
    case "review.verdict":
      return d.verdict === "approve"
        ? `Approved version ${d.version}`
        : `Asked for changes to version ${d.version}`;
    case "domain.attached":
      return `Attached the domain ${d.hostname}`;
    case "domain.removed":
      return `Removed the domain ${d.hostname} (${String(d.reason).replaceAll("_", " ")})`;
    case "webhook.created":
      return `Created a ${d.format} webhook to ${d.host}`;
    case "webhook.changed":
      return d.enabled === undefined
        ? "Changed a webhook's events"
        : d.enabled
          ? "Enabled a webhook"
          : "Disabled a webhook";
    case "webhook.removed":
      return "Removed a webhook";
    case "brand.changed":
      return (d.fields as string[]).includes("logo")
        ? "Changed the brand's logo"
        : "Changed the brand";
    case "brand.removed":
      return (d.fields as string[]).includes("logo")
        ? "Removed the brand's logo"
        : "Removed the brand";
    case "member.invited":
      return `Invited someone at ${d.emailDomain} as ${ROLE[d.role as keyof typeof ROLE]}`;
    case "member.invitation_revoked":
      return "Revoked an invitation";
    case "member.joined":
      return `${member} joined as ${ROLE[d.role as keyof typeof ROLE]}`;
    case "member.role_changed":
      return `Changed ${member} from ${d.from} to ${d.to}`;
    case "member.removed":
      return `Removed ${member}`;
    case "member.left":
      return `${member} left`;
    case "plan.granted":
      return `Plan set to ${d.plan} with ${d.seats} seat${d.seats === 1 ? "" : "s"}${d.validUntil ? ` until ${formatDate(String(d.validUntil))}` : ""}`;
    case "plan.removed":
      return "Plan removed (back to free)";
    case "service_token.created":
      return `Created a service token (${(d.scopes as string[]).join(", ")}; ${d.days} day${d.days === 1 ? "" : "s"})`;
    case "service_token.revoked":
      return "Revoked a service token";
    case "email_domain.verified":
      return `Verified the email domain ${d.domain}`;
    case "email_domain.removed":
      return d.reason === "removed"
        ? `Removed the email domain ${d.domain}`
        : `The email domain ${d.domain} was removed (${d.reason === "claimed" ? "another workspace proved it" : "its DNS record is missing"})`;
    case "audit.exported":
      return `Exported the audit log as ${String(d.format).toUpperCase()}${d.from || d.to ? ` (${d.from ?? "start"} to ${d.to ?? "now"})` : ""}`;
  }
}

function accessParts(d: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (d.mode) parts.push(`mode ${d.mode}`);
  if (d.readersAdded) parts.push(`${d.readersAdded} reader(s) added`);
  if (d.readersRemoved) parts.push(`${d.readersRemoved} reader(s) removed`);
  if (Array.isArray(d.readerDomains) && d.readerDomains.length > 0) {
    parts.push(`at ${d.readerDomains.join(", ")}`);
  }
  if (d.readerExceptions) parts.push(`${d.readerExceptions} comment exception(s)`);
  if (d.bar !== undefined) parts.push(`bar ${d.bar ? "on" : "off"}`);
  if (d.commentVisibility) parts.push(`comments visible to ${d.commentVisibility}`);
  if (d.indexable !== undefined) parts.push(`indexing ${d.indexable ? "on" : "off"}`);
  if (d.embeddable !== undefined) parts.push(`embedding ${d.embeddable ? "on" : "off"}`);
  return parts;
}

function auditTarget(event: AuditEventView): string {
  if (event.artifact) return plain(event.artifact.name ?? `${event.artifact.id} (gone)`);
  return event.target.id ?? "";
}

export async function audit(io: Io, runtime: Runtime, options: AuditOptions): Promise<void> {
  const kinds = parseKinds(options.kind ?? []);
  const limit = parseLimit(options.limit);
  const from = options.since === undefined ? undefined : parseSince(options.since, runtime.now());
  const to = options.until === undefined ? undefined : parseSince(options.until, runtime.now());
  const session = await openSession(io, runtime);
  // Only the flag: the audit log never follows the default workspace without asking.
  const workspace =
    options.workspace === undefined ? undefined : await chosenWorkspace(session, options.workspace);
  const events: AuditEventView[] = [];
  let cursor: string | null = null;
  let page: AuditLogView;
  do {
    const query = new URLSearchParams({
      limit: String(Math.min(PAGE_SIZE, limit - events.length)),
    });
    for (const kind of kinds) query.append("kind", kind);
    if (options.actor) query.set("actor", options.actor);
    if (options.target) query.set("target", options.target);
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (cursor !== null) query.set("cursor", cursor);
    page = await callApi(session, {
      method: "GET",
      path: `/audit${workspaceQuery(workspace, query)}`,
      schema: AuditLogView,
    });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor !== null && events.length < limit);

  if (options.json) {
    writeJson(io, { ...page, events, nextCursor: cursor });
    return;
  }
  if (events.length === 0) {
    io.stdout(`No audit events in the last ${page.retentionDays} days match.\n`);
  } else {
    io.stdout(
      table([
        ["WHEN", "WHO", "WHAT", "ON"],
        ...events.map((event) => [
          formatDate(event.at),
          auditActor(event.actor),
          auditSummary(event),
          auditTarget(event),
        ]),
      ]),
    );
  }
  if (cursor !== null) {
    io.stdout(`More events exist: raise --limit (up to ${MAX_EVENTS}) or narrow the filters.\n`);
  }
  io.stdout(
    `Kept ${page.retentionDays} days. Members are shown by name; removed members never by address.\n`,
  );
}

export interface AuditExportOptions extends OutputOptions {
  format?: string | undefined;
  out?: string | undefined;
  workspace?: string | undefined;
  kind?: string[] | undefined;
  actor?: string | undefined;
  target?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
}

/**
 * portifact audit export: the whole audit log, or what the filters keep, as CSV or JSON Lines
 * (premium plan E3, Enterprise). The API answers one part at a time and names the next part's
 * cursor in a header; this follows it and appends each part, so the file is byte for byte what
 * the parts hold. With --out it writes a new file (never overwriting one, removed again if the
 * export fails); without it, standard output.
 */
export async function auditExport(
  io: Io,
  runtime: Runtime,
  options: AuditExportOptions,
): Promise<void> {
  const format = AuditExportFormat.safeParse(options.format);
  if (!format.success) throw new CliError("invalid_input", messages.auditExport.formatNeeded);
  const kinds = parseKinds(options.kind ?? []);
  const from = options.since === undefined ? undefined : parseSince(options.since, runtime.now());
  const to = options.until === undefined ? undefined : parseSince(options.until, runtime.now());
  const out = options.out === undefined ? undefined : resolve(options.out);
  if (out !== undefined && (await exists(out))) {
    throw new CliError("invalid_input", messages.auditExport.outExists(out));
  }
  const session = await openSession(io, runtime);
  const workspace =
    options.workspace === undefined ? undefined : await chosenWorkspace(session, options.workspace);
  const query = new URLSearchParams({ format: format.data });
  for (const kind of kinds) query.append("kind", kind);
  if (options.actor) query.set("actor", options.actor);
  if (options.target) query.set("target", options.target);
  if (from) query.set("from", from);
  if (to) query.set("to", to);

  const file = out === undefined ? undefined : await createFile(out);
  let bytes = 0;
  try {
    let cursor: string | null = null;
    do {
      const part = new URLSearchParams(query);
      if (cursor !== null) part.set("cursor", cursor);
      const path = `/audit/export${workspaceQuery(workspace, part)}`;
      // Only a resumed part is safe to repeat: the first one starts the export and records it.
      const answer: { text: string; headers: Headers } =
        cursor === null
          ? await downloadApi(session, path)
          : await withRetries(session, () => downloadApi(session, path));
      if (file) await file.write(answer.text);
      else io.stdout(answer.text);
      bytes += Buffer.byteLength(answer.text);
      cursor = answer.headers.get(AUDIT_EXPORT_CURSOR_HEADER);
    } while (cursor !== null);
  } catch (error) {
    if (file && out) {
      await file.close();
      await rm(out, { force: true });
    }
    throw error;
  }
  io.stderr(`${messages.auditExport.notice}\n`);
  if (!file || !out) return;
  await file.close();
  if (options.json) {
    writeJson(io, { format: format.data, out, bytes });
    return;
  }
  io.stdout(`${messages.auditExport.exported(format.data, out, bytes)}\n`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createFile(path: string) {
  try {
    // A new file only, so an export never overwrites anything.
    return await open(path, "wx");
  } catch {
    throw new CliError("invalid_input", messages.auditExport.cannotWrite(path));
  }
}
