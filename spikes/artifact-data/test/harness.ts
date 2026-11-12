import { env } from "cloudflare:test";
import type { ArtifactRef, Outcome } from "../src/artifact-data.ts";
import type { Caller, DataLimits } from "../src/model.ts";

/** The free plan's numbers proposed in decision 0026, "Plans". */
export const FREE: DataLimits = {
  bytesPerArtifact: 10_000_000,
  documentBytes: 16 * 1024,
  documentsPerCollection: 1_000,
  collections: 10,
  writesPerAuthorPerMinute: 30,
  connectionsPerArtifact: 25,
  connectionsPerAuthor: 4,
};

export const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

let counter = 0;

/** A fresh artifact, so tests never share an object. */
export function artifact(): {
  ref: ArtifactRef;
  stub: DurableObjectStub<import("../src/artifact-data.ts").ArtifactData>;
} {
  counter += 1;
  const artifactId = `a${counter.toString().padStart(9, "0")}`;
  const stub = env.ARTIFACT_DATA.get(env.ARTIFACT_DATA.idFromName(artifactId));
  return { ref: { artifactId, region: "default" }, stub };
}

export const OWNER: Caller = { kind: "owner" };
export const READER: Caller = { kind: "reader" };

export function visitor(author: string, canWrite = true): Caller {
  return { kind: "visitor", author, canWrite };
}

/**
 * The value of a successful outcome, failing the test otherwise. Generic over the outcome itself
 * because an RPC stub returns the outcome's serialized (mapped) type, not `Outcome<T>`.
 */
export function ok<O extends Outcome<unknown> | { ok: boolean }>(
  outcome: O,
): Extract<O, { ok: true }> extends { value: infer V } ? V : never {
  const result = outcome as Outcome<unknown>;
  if (!result.ok) throw new Error(`expected success, got ${result.error}: ${result.message}`);
  return result.value as Extract<O, { ok: true }> extends { value: infer V } ? V : never;
}
