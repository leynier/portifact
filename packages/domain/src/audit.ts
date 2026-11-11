// Rules of the audit log (premium plan T10): what an event's detail may hold, which events a page
// shows and how the actor is shown. The services write and read; these functions decide.
import {
  AUDIT_DETAILS,
  AUDIT_LIMITS,
  type AuditActorType,
  type AuditActorView,
  type AuditDetail,
  type AuditKind,
} from "@portifact/contracts";
import { fail, ok, type Result } from "./result.ts";

const DAY_MS = 86_400_000;

/**
 * The kind's detail, checked against the catalog. A detail outside it is a bug in the writer, so
 * it throws instead of storing something no reader expects (or something that should never be
 * stored, which the strict schemas refuse).
 */
export function auditDetail<K extends AuditKind>(kind: K, detail: AuditDetail<K>): AuditDetail<K> {
  const parsed = AUDIT_DETAILS[kind].safeParse(detail);
  if (!parsed.success) throw new Error(`Invalid detail for audit event ${kind}`);
  return parsed.data as AuditDetail<K>;
}

/** The distinct domains of some email addresses, sorted, at most the catalog's cap. */
export function emailDomains(emails: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const email of emails) {
    const at = email.lastIndexOf("@");
    if (at < 0) continue;
    const domain = email.slice(at + 1).toLowerCase();
    if (/^[a-z0-9.-]{1,253}$/.test(domain)) domains.add(domain);
  }
  return [...domains].sort().slice(0, AUDIT_LIMITS.readerDomains);
}

/** One email address's domain, for an invitation's event. */
export function emailDomain(email: string): string {
  return emailDomains([email])[0] ?? "invalid";
}

/** The oldest moment still kept for a retention in days. */
export function auditCutoff(retentionDays: number, now: number): number {
  return now - retentionDays * DAY_MS;
}

/**
 * What the retention sweep deletes before: events whose `at` is older. The sweep and audit
 * streams' gap rule both use this one function, unrounded, so a stream can never think an event
 * is still kept after the sweep deleted it (decision 0019, "Retention and gaps").
 */
export function auditPruneCutoff(retentionDays: number, now: number): number {
  return auditCutoff(retentionDays, now);
}

export interface AuditWindow {
  /** Inclusive. */
  from: number;
  /** Exclusive. */
  to: number;
}

/**
 * The time window a query reads: what it asks for, never older than the retention, so an event
 * past it is not listed even before the scan deletes it.
 */
export function auditWindow(
  filters: { from?: string | undefined; to?: string | undefined },
  retentionDays: number,
  now: number,
): Result<AuditWindow> {
  const from = filters.from === undefined ? undefined : Date.parse(filters.from);
  const to = filters.to === undefined ? undefined : Date.parse(filters.to);
  if (from !== undefined && to !== undefined && from >= to) {
    return fail("invalid_input", "The start of the range must be before its end.");
  }
  return ok({
    from: Math.max(from ?? Number.NEGATIVE_INFINITY, auditCutoff(retentionDays, now)),
    to: Math.min(to ?? Number.POSITIVE_INFINITY, now + 1),
  });
}

export interface AuditPosition {
  at: number;
  id: string;
}

/** The opaque cursor after an event: its time and ID, newest first. */
export function encodeAuditCursor(position: AuditPosition): string {
  return btoa(JSON.stringify([position.at, position.id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The position a cursor names, or an `invalid_input` failure for anything else. */
export function decodeAuditCursor(cursor: string): Result<AuditPosition> {
  const invalid = () => fail<never>("invalid_input", "The cursor is not valid.");
  try {
    const value: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      typeof value[1] === "string" &&
      value[1].length > 0 &&
      value[1].length <= 100
    ) {
      return ok({ at: value[0], id: value[1] });
    }
    return invalid();
  } catch {
    return invalid();
  }
}

/**
 * How an event shows who acted: a current member (in a personal space, its user) by name, any
 * other account as a removed member, never by email. The opaque ID stays, so a reader can filter.
 * A service token shows its current label (`tokens`), or none once it is gone; so does a
 * directory's SCIM token (decision 0017), whose labels share the map (the IDs never collide).
 */
export function auditActorView(
  type: AuditActorType,
  id: string | null,
  names: ReadonlyMap<string, string>,
  tokens: ReadonlyMap<string, string> = new Map(),
): AuditActorView {
  if (type === "operator") return { type: "operator" };
  if (type === "system" || id === null) return { type: "system" };
  if (type === "token") return { type: "service_token", id, label: tokens.get(id) ?? null };
  if (type === "directory") return { type: "directory", id, label: tokens.get(id) ?? null };
  const name = names.get(id);
  return name === undefined ? { type: "removed_member", id } : { type: "member", id, name };
}

/** A new event ID: `ae_` and 24 lowercase hex characters, unique per write. */
export function newAuditEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `ae_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
