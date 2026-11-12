// What a log line may say. Workers observability is global, outside every region (decision 0005,
// "What leaves the EU"), so a log line carries only facts that cannot hold a person's content: an
// event name, IDs, counts, enum values, a region and an error's label. Every log line of the
// Workers and the shared packages goes through `logEvent` (or `logSummary` for the two run
// summaries), whose types refuse free text where they can; `scripts/log-fields.test.ts` refuses
// every other use of `console` in shipped source and checks the values the types cannot see.
import type { Region } from "@portifact/contracts";

/**
 * Codes of the errors Portifact throws itself. A new code is added here deliberately; its
 * message stays fixed text written by Portifact, but only the code and the status are logged.
 */
export const PORTIFACT_ERROR_CODES = [
  "ANALYTICS_HTTP",
  "ANALYTICS_GRAPHQL_ERRORS",
  "ANALYTICS_ACCOUNT_NOT_VISIBLE",
  "CF_HOSTNAMES_HTTP",
  "DOH_HTTP",
  "DOH_RCODE",
  "BUCKET_NOT_BOUND",
] as const;
export type PortifactErrorCode = (typeof PORTIFACT_ERROR_CODES)[number];

/**
 * An error Portifact throws with a machine code, an optional status (an HTTP status, a DNS rcode)
 * and optional numeric details (Cloudflare's error codes). All of them are numbers or a code from
 * the list, so `errorLabel` can log them without any risk of carrying content.
 */
export class CodedError extends Error {
  constructor(
    readonly code: PortifactErrorCode,
    readonly status?: number,
    readonly details: readonly number[] = [],
  ) {
    super(
      `${code}${status === undefined ? "" : ` ${status}`}${details.length ? ` ${details.join(",")}` : ""}`,
    );
  }
}

/**
 * Codes the platform puts at the start of its error messages (D1, Email Service), kept by
 * `errorLabel` only from this list, so text that merely looks like a code is never logged.
 */
const PLATFORM_CODES = new Set([
  "D1_ERROR",
  "D1_EXEC_ERROR",
  "D1_TYPE_ERROR",
  "D1_COLUMN_NOTFOUND",
  "D1_DUMP_ERROR",
  "D1_RESET_DO",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RATE_LIMIT_EXCEEDED",
  "E_VALIDATION_ERROR",
  "E_INTERNAL_SERVER_ERROR",
]);

/** SQLite's primary result code names, which D1 appends to its messages. */
const SQLITE_CODES = new Set([
  "SQLITE_ERROR",
  "SQLITE_INTERNAL",
  "SQLITE_PERM",
  "SQLITE_ABORT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_SCHEMA",
  "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH",
  "SQLITE_MISUSE",
  "SQLITE_RANGE",
  "SQLITE_AUTH",
  "SQLITE_NOTADB",
]);

declare const labelBrand: unique symbol;
/** What `errorLabel` returns: the only value a log line's `error` field takes. */
export type ErrorLabel = string & { readonly [labelBrand]: true };

const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/**
 * An error as a log line may name it, never with its message's text: the error's name, then a
 * `CodedError`'s code, status and numeric details, or the platform's own codes found in the
 * message (a D1 code and SQLite result code name, an R2 error number such as `10025`).
 * `Error:D1_ERROR:SQLITE_CONSTRAINT`, `Error:ANALYTICS_HTTP:401`, `Error:r2_10025`, `TypeError`,
 * or `string` for a thrown value that is not an error.
 */
export function errorLabel(error: unknown): ErrorLabel {
  if (!(error instanceof Error)) return typeof error as ErrorLabel;
  const name = NAME.test(error.name) ? error.name : "Error";
  const parts = [name];
  if (error instanceof CodedError) {
    parts.push(error.code);
    if (Number.isInteger(error.status)) parts.push(String(error.status));
    for (const detail of error.details) if (Number.isInteger(detail)) parts.push(String(detail));
    return parts.join(":") as ErrorLabel;
  }
  const message = typeof error.message === "string" ? error.message : "";
  const leading = /^([A-Z][A-Z0-9_]{2,39})(?=:|$|\s)/.exec(message)?.[1];
  if (leading && PLATFORM_CODES.has(leading)) parts.push(leading);
  const sqlite = [...message.matchAll(/\b(SQLITE_[A-Z]+)\b/g)]
    .map((match) => match[1] as string)
    .find((code) => SQLITE_CODES.has(code));
  if (sqlite && leading?.startsWith("D1_")) parts.push(sqlite);
  // R2 reports its error numbers in parentheses, such as `(10025)`; only the digits are kept.
  const r2 = /\((1\d{4})\)/.exec(message)?.[1];
  if (r2) parts.push(`r2_${r2}`);
  return parts.join(":") as ErrorLabel;
}

/**
 * The fields a log line may carry, each of a kind that holds no content: IDs, counts, enum
 * values (`reason`, `outcome`, `type`, `topic`, `moment` must be literal unions, never `string`), a region
 * and an error's label. `scripts/log-fields.test.ts` lists the same names and checks values.
 */
export interface LogFields {
  reason?: string;
  outcome?: string;
  type?: string;
  topic?: string;
  /** A grace email's moment (decision 0022): `start`, `two_weeks`, `three_days`. */
  moment?: string;
  error?: ErrorLabel;
  region?: Region | undefined;
  /** A queue message's ID. */
  messageId?: string;
  /** Email Service's event ID. */
  eventId?: string | null;
  /** An outbox row's ID. */
  id?: number;
  /** An opaque workspace ID (`ws_` and hex); the guard checks the value names one. */
  workspaceId?: string;
  /**
   * An owner's opaque ID (an account's or a workspace's), for a row the operator must fix
   * (decision 0022, an unreadable plan grace); never a name or an address.
   */
  ownerId?: string;
  artifacts?: number;
  threads?: number;
  recipients?: number;
  alerts?: number;
  /** Links of a Slack event worth looking up (decision 0025): a count. */
  candidates?: number;
  /** Links of a Slack event sent with a preview: a count. */
  unfurled?: number;
}

type EnumField = "reason" | "outcome" | "type" | "topic" | "moment";

/** Refuses a field typed as plain `string` where a literal union is required. */
export type LiteralEnums<F> = {
  [K in keyof F]: K extends EnumField ? (string extends F[K] ? never : F[K]) : F[K];
};

export type LogLevel = "log" | "warn" | "error";

function write(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * The one way to log: `{"event":"<event>",...fields}` as JSON on one line. `event` must be a
 * string literal and `fields` the kinds above.
 */
export function logEvent<const E extends string, const F extends LogFields = Record<never, never>>(
  level: LogLevel,
  event: string extends E ? never : E,
  fields?: F & LiteralEnums<F>,
): void {
  write(level, JSON.stringify({ event, ...(fields ?? {}) }));
}

/**
 * A scheduled run's summary (the maintenance and the budget run): counts per scan and region and
 * the budget's level and actions. Its strings are not typed as enums, so the guard allows it only
 * at the call sites it lists.
 */
export function logSummary<const E extends string>(
  level: LogLevel,
  event: string extends E ? never : E,
  summary: object,
): void {
  write(level, JSON.stringify({ event, ...summary }));
}
