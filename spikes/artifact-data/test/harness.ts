import { env } from "cloudflare:test";
import type { CallContext, Outcome } from "../src/documents.ts";
import type { Envelope } from "../src/envelope.ts";
import type { Caller, DataLimits } from "../src/model.ts";

/** Plan B's Free numbers (decision 0026, "Plans"); tests about other things use ROOMY. */
export const FREE: DataLimits = {
  bytesPerArtifact: 5_000_000,
  documentBytes: 16 * 1024,
  documentsPerCollection: 1_000,
  collections: 10,
  indexedFields: 3,
  writesPerAuthorPerMinute: 30,
  deletesPerAuthorPerMinute: 60,
  readsPerCallerPerMinute: 300,
  rowsReadPerDay: 500_000,
  rowsWrittenPerDay: 5_000,
  connectionsPerArtifact: 10,
  connectionsPerAuthor: 4,
  connectsPerAuthorPerMinute: 6,
  liveMessagesPerDay: 2_000,
  rightsRowsPerDay: 500,
  cleanupRowsPerDay: 5_000,
  exportRowsPerDay: 200_000,
};

/** Generous limits for tests that are about something else than limits. */
export const ROOMY: DataLimits = {
  ...FREE,
  bytesPerArtifact: 100_000_000,
  connectionsPerArtifact: 25,
  documentsPerCollection: 200_000,
  writesPerAuthorPerMinute: 100_000,
  deletesPerAuthorPerMinute: 100_000,
  readsPerCallerPerMinute: 100_000,
  rowsReadPerDay: 1_000_000_000,
  rowsWrittenPerDay: 100_000_000,
  liveMessagesPerDay: 10_000_000,
  rightsRowsPerDay: 100_000_000,
  cleanupRowsPerDay: 100_000_000,
  exportRowsPerDay: 100_000_000,
};

export const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

let counter = 0;

/** A fresh artifact: its envelope (owned by `owner`) and its object. */
export function artifact(owner = "owner_default") {
  counter += 1;
  const artifactId = `a${counter.toString().padStart(9, "0")}`;
  const envelope: Envelope = {
    artifactId,
    region: "default",
    ownerId: owner,
    generation: 0,
    epoch: 0,
  };
  return {
    envelope,
    owner,
    docs: env.DOCUMENTS.get(env.DOCUMENTS.idFromName(artifactId)),
  };
}

let ops = 0;
/** The envelope with a fresh durable operation ID, as the Worker sends a mutation. */
export function op(envelope: Envelope): Envelope {
  ops += 1;
  return { ...envelope, opId: `${NOW}.${ops}` };
}

export function context(
  caller: Caller,
  options: { limits?: DataLimits; now?: number } = {},
): CallContext {
  return { caller, limits: options.limits ?? ROOMY, now: options.now ?? NOW };
}

export const OWNER: Caller = { kind: "owner" };
export const READER: Caller = { kind: "reader" };

export function visitor(author: string, canWrite = true): Caller {
  return { kind: "visitor", author, canWrite };
}

/** The value of a successful outcome (undefined for a replay), failing the test otherwise. */
export function ok<O extends Outcome<unknown> | { ok: boolean }>(
  outcome: O,
): Extract<O, { ok: true; value: unknown }> extends { value: infer V } ? V : never {
  const result = outcome as { ok: boolean; error?: string; message?: string; value?: unknown };
  if (!result.ok) throw new Error(`expected success, got ${result.error}: ${result.message}`);
  return result.value as Extract<O, { ok: true; value: unknown }> extends { value: infer V }
    ? V
    : never;
}
