// The owner document API's rules (decision 0026, delivery 5): how the object's refusals read
// as the API's errors, which audit event an obligation becomes and whether an export file is a
// consistent snapshot. Pure.
import type { DataRefusalCode, ErrorCode } from "@portifact/contracts";
import { HELD_MESSAGE } from "./moderation.ts";

/**
 * The API's error for a refusal of the object: the same code where the API has it; `stale` and
 * `conflict` are a version conflict the caller retries; `held` is the hold's own refusal, which
 * never says why; `quarantined` is a temporary unavailability while the operator reviews the data.
 */
export function dataRefusalError(
  code: DataRefusalCode | string,
  message: string,
): { code: ErrorCode; message: string } {
  switch (code) {
    case "held":
      return { code: "forbidden", message: HELD_MESSAGE };
    case "stale":
      return { code: "version_conflict", message: "The artifact's data changed; try again." };
    case "conflict":
      return { code: "version_conflict", message: capitalized(message) };
    case "quarantined":
      return {
        code: "capacity_unavailable",
        message: "This artifact's data is being checked. Try again later.",
      };
    case "forbidden":
    case "not_found":
    case "invalid_input":
    case "quota_exceeded":
    case "rate_limited":
      return { code, message: capitalized(message) };
    default:
      return {
        code: "capacity_unavailable",
        message: "Artifact data is unavailable. Try again later.",
      };
  }
}

function capitalized(message: string): string {
  const text = message.trim();
  if (text === "") return "Refused.";
  const first = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** The D1 audit kinds an owner-side obligation becomes; an index step records nothing. */
export const DATA_AUDIT_EVENTS = {
  "data.collection_set": "data.collection_set",
  "data.document_created": "data.document_created",
  "data.document_replaced": "data.document_replaced",
  "data.document_deleted": "data.document_deleted",
  "data.documents_created": "data.documents_created",
  "data.documents_replaced": "data.documents_replaced",
  "data.documents_deleted": "data.documents_deleted",
  "data.author_erased": "data.author_erased",
} as const;
export type DataAuditEventKind = (typeof DATA_AUDIT_EVENTS)[keyof typeof DATA_AUDIT_EVENTS];

const BULK_EVENTS = new Set<string>([
  "data.documents_created",
  "data.documents_replaced",
  "data.documents_deleted",
]);

/**
 * The audit event an obligation the object settled as committed becomes, with its detail, or
 * null when it records nothing (an index step , which only builds what a declaration recorded, or
 * a kind this code does not know). Bulk events carry their count, the others nothing.
 */
export function dataAuditEvent(
  kind: string,
  detail: Record<string, number | boolean> | null,
): { kind: DataAuditEventKind; detail: Record<string, number> } | null {
  if (!Object.hasOwn(DATA_AUDIT_EVENTS, kind)) return null;
  const event = DATA_AUDIT_EVENTS[kind as keyof typeof DATA_AUDIT_EVENTS];
  const count = (field: string) => {
    const value = detail?.[field];
    return typeof value === "number" && Number.isInteger(value) ? Math.max(0, value) : 0;
  };
  if (event === "data.author_erased") {
    return { kind: event, detail: { documents: count("documents"), edits: count("edits") } };
  }
  if (BULK_EVENTS.has(event)) return { kind: event, detail: { documents: count("documents") } };
  return { kind: event, detail: {} };
}

/**
 * Whether an export is a consistent snapshot: every page, and the description that gave the
 * header its collections, saw the same payload revision (it changes only when documents or
 * declarations change).
 */
export function exportConsistent(revisions: readonly number[]): boolean {
  return revisions.every((revision) => revision === revisions[0]);
}

/**
 * C1 controls and the format characters that reorder or hide text (bidirectional marks and
 * overrides, the line and paragraph separators): visitors write documents, and a terminal reads
 * U+009B as CSI. They only ever appear inside JSON strings in what these commands print and write,
 * so a JSON escape keeps every value as stored. The CLI escapes its output and
 * both export writers (CLI and dashboard) escape the file.
 */
const TERMINAL_UNSAFE = /[\u0080-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/** The text with every terminal-unsafe character as its JSON escape. */
export function escapeControls(text: string): string {
  return text.replace(
    TERMINAL_UNSAFE,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}
