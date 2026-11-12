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
    case "directory":
      return actor.label === null
        ? "Directory (revoked SCIM token)"
        : `${plain(actor.label)} (directory)`;
    case "operator":
      return "Portifact operator";
    case "system":
      return "Portifact";
  }
}

const ROLE = { admin: "admin", editor: "editor", member: "member" } as const;

/** What happened, in plain words. */
/** The services of issue integrations, by name. */
const SERVICE: Readonly<Record<string, string>> = {
  github: "GitHub",
  linear: "Linear",
  jira: "Jira",
};
const service = (value: unknown) => SERVICE[String(value)] ?? String(value);

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
    case "integration.connected":
      return `Connected ${service(d.service)} with ${d.targets} ${d.targets === 1 ? "target" : "targets"}`;
    case "integration.changed": {
      const parts = [
        d.label ? "its label" : null,
        d.credential ? "its credential" : null,
        d.targets !== undefined ? `its targets (now ${d.targets})` : null,
      ].filter(Boolean);
      return `Changed a connection: ${parts.join(", ")}`;
    }
    case "integration.removed":
      return `Removed a ${service(d.service)} connection`;
    case "integration.failing":
      return d.reason === "key_unavailable"
        ? `A ${service(d.service)} connection's credential can no longer be opened`
        : `${service(d.service)} refused a connection's credential`;
    case "issue.created": {
      const sent = [
        d.link ? "the link" : null,
        d.artifactName ? "the name" : null,
        d.quote ? "the quote" : null,
        d.message ? "the first message" : null,
      ].filter(Boolean);
      return `Created a ${service(d.service)} issue in ${d.target} from a thread (sent: ${sent.length > 0 ? sent.join(", ") : "the title only"})`;
    }
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
      return `${member} joined as ${ROLE[d.role as keyof typeof ROLE]}${JOINED_VIA[d.via as keyof typeof JOINED_VIA] ?? ""}`;
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
    case "plan.grace_started":
      return `Grace started (${GRACE_STARTED[d.reason as keyof typeof GRACE_STARTED] ?? d.reason}): what the ${d.plan} plan kept is held until ${formatDate(String(d.until))}`;
    case "plan.grace_ended":
      return `Grace ended (${GRACE_ENDED[d.reason as keyof typeof GRACE_ENDED] ?? d.reason}) for what the ${d.plan} plan kept`;
    case "service_token.created":
      return `Created a service token (${(d.scopes as string[]).join(", ")}; ${d.days} day${d.days === 1 ? "" : "s"})`;
    case "service_token.revoked":
      return "Revoked a service token";
    case "github_trust.created":
      return `Trusted the GitHub repository ${d.repository} (${(d.events as string[]).join(", ")})`;
    case "github_trust.changed":
      return `Changed the trust of the GitHub repository ${d.repository} (${(d.events as string[]).join(", ")})`;
    case "github_trust.removed":
      return `Stopped trusting the GitHub repository ${d.repository}`;
    case "github_trust.exchanged":
      return `GitHub run ${d.runId} of ${d.repository} got a credential (${d.event})`;
    case "email_domain.verified":
      return `Verified the email domain ${d.domain}`;
    case "email_domain.removed":
      return d.reason === "removed"
        ? `Removed the email domain ${d.domain}`
        : `The email domain ${d.domain} was removed (${d.reason === "claimed" ? "another workspace proved it" : "its DNS record is missing"})`;
    case "group.created":
      return `Created the group ${groupName(event)}`;
    case "group.renamed":
      return `Renamed the group ${groupName(event)}`;
    case "group.deleted":
      return `Deleted the group ${groupName(event)}`;
    case "group.sync_stopped":
      return `Stopped syncing the group ${groupName(event)} from the directory`;
    case "group.member_added":
      return `Added ${member} to the group ${groupName(event)}`;
    case "group.member_removed":
      return `Removed ${member} from the group ${groupName(event)}`;
    case "sso.created":
      return `Set up single sign-on with ${d.issuerHost} for ${d.domains} domain${d.domains === 1 ? "" : "s"}`;
    case "sso.changed":
      return `Changed single sign-on (${(d.fields as string[]).map((field) => SSO_FIELD[field as keyof typeof SSO_FIELD]).join(", ")})`;
    case "sso.removed":
      return "Removed single sign-on";
    case "scim_token.created":
      return `Created a SCIM token (${d.days} day${d.days === 1 ? "" : "s"})`;
    case "scim_token.revoked":
      return "Revoked a SCIM token";
    case "member.provisioned":
      return `Provisioned someone at ${d.emailDomain} as ${ROLE[d.role as keyof typeof ROLE]}; they join when they sign in`;
    case "scim.changed":
      return scimChanges(d).join("; ");
    case "audit.exported":
      return `Exported the audit log as ${String(d.format).toUpperCase()}${d.from || d.to ? ` (${d.from ?? "start"} to ${d.to ?? "now"})` : ""}`;
    case "policy.changed":
      return `Changed the workspace's policies: ${policyParts(d).join(", ")}${d.confirmed ? " (existing artifacts changed)" : ""}`;
    case "policy.enforced":
      return `Applied the workspace's policies: ${enforcedParts(d).join(", ")}`;
    case "policy.sso_suspended":
      return `Single sign-on required no longer applies: the provider cannot sign anyone in (${SSO_CAUSES[String(d.cause)] ?? d.cause})`;
    case "policy.sso_resumed":
      return `Single sign-on required applies again: the provider can sign people in (${SSO_CAUSES[String(d.cause)] ?? d.cause})`;
    case "audit_stream.created":
      return `Started streaming the audit log to ${d.host}${d.start === "oldest" ? " from the oldest kept event" : ""}`;
    case "audit_stream.changed":
      return `Changed the audit stream to ${d.host}: ${streamChanges(d).join(", ")}`;
    case "audit_stream.removed":
      return `Removed the audit stream to ${d.host}`;
    case "audit_stream.paused":
      return `Paused the audit stream to ${d.host} (${STREAM_PAUSE[d.reason as keyof typeof STREAM_PAUSE]})`;
  }
}

const STREAM_PAUSE = {
  failures: "the endpoint kept failing",
  plan: "the plan no longer includes it",
  invalid_url: "its URL no longer passes the checks",
  key_unavailable: "its URL and secret can no longer be opened",
} as const;

/** What an audit stream change did, one phrase per field. */
function streamChanges(d: Record<string, unknown>): string[] {
  return [
    d.label ? "its label" : null,
    d.url ? "its URL" : null,
    d.secret
      ? d.revoked
        ? "a new signing secret, the old one revoked at once"
        : "a new signing secret"
      : null,
    d.state === "active" ? "resumed" : d.state === "paused" ? "paused" : null,
  ].filter((part): part is string => part !== null);
}

/** What a directory settings change did, one phrase per field. */
function scimChanges(d: Record<string, unknown>): string[] {
  const fields = (d.fields as string[] | undefined) ?? [];
  const parts: string[] = [];
  if (fields.includes("invitationEmails")) {
    parts.push(
      d.invitationEmails
        ? "Turned on invitation emails for provisioned people"
        : "Turned off invitation emails for provisioned people",
    );
  }
  for (const role of ["editor", "admin"] as const) {
    const value = d[`${role}Group`];
    if (!fields.includes(`${role}Group`)) continue;
    parts.push(
      value === null
        ? `Stopped giving ${role} through a directory group`
        : `Gave ${role} to the members of a directory group`,
    );
  }
  return parts;
}

const JOINED_VIA = {
  sso: " through single sign-on",
  directory: " through the directory",
} as const;

const GRACE_STARTED = {
  lowered: "plan lowered",
  removed: "plan removed",
  expired: "plan ended",
  unreadable: "stored grace unreadable",
} as const;

const GRACE_ENDED = {
  renewed: "plan renewed",
  operator: "ended by Portifact",
  expired: "its days passed",
  folded: "folded into a later hold",
} as const;

const SSO_FIELD = {
  clientId: "client ID",
  clientSecret: "client secret",
  domains: "domains",
} as const;

/** The fields of a policy change, in words. */
function policyParts(d: Record<string, unknown>): string[] {
  const parts: string[] = [];
  if (d.publicAccess !== undefined) parts.push(`public access ${d.publicAccess}`);
  if (d.defaultAccess !== undefined) parts.push(`new artifacts ${d.defaultAccess}`);
  if (d.readerDomains !== undefined) {
    parts.push(
      d.readerDomains === null
        ? "readers at any domain"
        : `readers only at ${(d.readerDomains as string[]).join(", ")}`,
    );
  }
  if (d.shareLinks !== undefined) {
    parts.push(`share links ${String(d.shareLinks).replaceAll("_", " ")}`);
  }
  if (d.shareLinkMaxDays !== undefined) {
    parts.push(
      d.shareLinkMaxDays === null
        ? "no share link lifetime limit"
        : `share links at most ${d.shareLinkMaxDays} days`,
    );
  }
  // Network allowlists are recorded as counts only (decision 0020).
  const networks = (count: unknown, who: string) =>
    count === null ? `${who} from any network` : `${who} only from ${count} network(s)`;
  if (d.ipRanges !== undefined) parts.push(networks(d.ipRanges, "people"));
  if (d.tokenIpRanges !== undefined) parts.push(networks(d.tokenIpRanges, "service tokens"));
  if (d.ssoRequired !== undefined) {
    parts.push(d.ssoRequired ? "single sign-on required" : "single sign-on not required");
  }
  if (d.reason === "sso_removed") parts.push("because the single sign-on provider was removed");
  if (d.artifactMaxDays !== undefined) {
    parts.push(
      d.artifactMaxDays === null
        ? "no maximum life of artifacts"
        : `artifacts archived ${d.artifactMaxDays} days after their last publish`,
    );
  }
  if (d.commentRetentionDays !== undefined) {
    parts.push(
      d.commentRetentionDays === null
        ? "no comment retention"
        : `comment threads deleted ${d.commentRetentionDays} days after their last activity`,
    );
  }
  if (d.reason === "plan_lapsed") parts.push("because the plan no longer includes policies");
  return parts;
}

const SSO_CAUSES: Record<string, string> = {
  domain: "a verified domain changed",
  plan: "the plan changed",
  provider: "the provider changed",
  scan: "noticed by the daily check",
};

/** What one enforcement step changed, as counts. */
function enforcedParts(d: Record<string, unknown>): string[] {
  const parts = [
    [d.artifactsNarrowed, "artifact(s) made workspace-only"],
    [d.readersRemoved, "reader(s) removed"],
    [d.linksRevoked, "share link(s) revoked"],
    [d.sessionsEnded, "link session(s) ended"],
    [d.deadlinesSet, "artifact expiry(ies) brought forward by the maximum life"],
    [d.deadlinesExtended, "artifact expiry(ies) given back"],
    [d.threadsDeleted, "comment thread(s) deleted by comment retention"],
    [d.messagesDeleted, "message(s) in them"],
  ] as const;
  const listed = parts
    .filter(([count]) => Number(count) > 0)
    .map(([count, what]) => `${count} ${what}`);
  return listed.length > 0 ? listed : ["nothing to change"];
}

/** A group by its current name, or as deleted: the event never stores the name. */
function groupName(event: AuditEventView): string {
  if (!event.group) return "(unknown)";
  return event.group.name === null ? "(deleted)" : `"${plain(event.group.name)}"`;
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
  if (d.groupsAdded) parts.push(`${d.groupsAdded} group(s) added`);
  if (d.groupsRemoved) parts.push(`${d.groupsRemoved} group(s) removed`);
  if (d.groupExceptions) parts.push(`${d.groupExceptions} group comment exception(s)`);
  if (d.bar !== undefined) parts.push(`bar ${d.bar ? "on" : "off"}`);
  if (d.commentVisibility) parts.push(`comments visible to ${d.commentVisibility}`);
  if (d.indexable !== undefined) parts.push(`indexing ${d.indexable ? "on" : "off"}`);
  if (d.embeddable !== undefined) parts.push(`embedding ${d.embeddable ? "on" : "off"}`);
  if (d.policy) parts.push("by the workspace's policy");
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
