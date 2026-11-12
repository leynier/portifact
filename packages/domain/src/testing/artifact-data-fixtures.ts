// Fixtures for the artifact data protocols' tests: plan limits, envelopes, operation IDs and
// callers, with the shapes the contracts validate.
import type { ArtifactDataLimits, DataEnvelope } from "@portifact/contracts/artifact-data";
import type { Caller } from "../artifact-data/documents.ts";

/** Plan B's Free numbers per artifact (decision 0026, "Open questions"). */
export const FREE: ArtifactDataLimits = {
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
  cleanupRowsPerDay: 5_000,
  exportRowsPerDay: 200_000,
  rightsRowsPerDay: 500,
  liveMessagesPerDay: 2_000,
  connectionsPerArtifact: 10,
  connectionsPerAuthor: 4,
  connectsPerAuthorPerMinute: 6,
};

/** Generous limits for tests about something other than limits. */
export const ROOMY: ArtifactDataLimits = {
  ...FREE,
  bytesPerArtifact: 100_000_000,
  documentsPerCollection: 200_000,
  writesPerAuthorPerMinute: 100_000,
  deletesPerAuthorPerMinute: 100_000,
  readsPerCallerPerMinute: 100_000,
  rowsReadPerDay: 1_000_000_000,
  rowsWrittenPerDay: 100_000_000,
  cleanupRowsPerDay: 100_000_000,
  exportRowsPerDay: 100_000_000,
  rightsRowsPerDay: 100_000_000,
  liveMessagesPerDay: 10_000_000,
  connectionsPerArtifact: 25,
};

export const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
export const ARTIFACT = "abcdefgh23";

export function envelope(overrides: Partial<DataEnvelope> = {}): DataEnvelope {
  return {
    artifactId: ARTIFACT,
    region: "default",
    ownerId: "owner_a",
    generation: 0,
    epoch: 0,
    ...overrides,
  };
}

let counter = 0;
/** A fresh operation ID issued at `at`. */
export function opId(at = NOW): string {
  counter += 1;
  return `${at}.op${counter.toString().padStart(6, "0")}`;
}

/** The envelope with a fresh operation ID, as the Worker sends a mutation. */
export function op(base: DataEnvelope, at = NOW): DataEnvelope {
  return { ...base, opId: opId(at) };
}

export const OWNER: Caller = { kind: "owner" };
export const READER: Caller = { kind: "reader" };

export function visitor(name: string, canWrite = true): Caller {
  return { kind: "visitor", author: visitorId(name), canWrite };
}

/** A valid visitor ID for a short name. */
export function visitorId(name: string): string {
  return `v_${name.padEnd(16, "0")}`;
}

export function context(options: { limits?: ArtifactDataLimits; now?: number } = {}) {
  return { limits: options.limits ?? ROOMY, now: options.now ?? NOW };
}

/** The value of a successful answer, failing the test otherwise. */
export function value<T>(answer: { ok: boolean } & ({ value: T } | object)): T {
  const result = answer as { ok: boolean; code?: string; message?: string; value?: T };
  if (!result.ok || !("value" in result)) {
    throw new Error(`expected a value, got ${result.code ?? "a replay"}: ${result.message ?? ""}`);
  }
  return result.value as T;
}
