// Live updates of artifact data (decision 0026, delivery 7): the content Worker opens a page's
// WebSocket to the artifact's documents object and renews it every minute through these. The
// caller decides who connects (a grant's visitor, or a reader) from the claims it verified; here
// the switches, the artifact's state, the data row, budget protection's data step and the owner's
// plan decide whether and with which limits, and the object admits, counts and charges.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  LIVE_CONNECT_HEADER,
  type LiveConnectRequest,
} from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import { dataRefusalError, fail, ok, type Result } from "@portifact/domain";
import { eq } from "drizzle-orm";
import { type DataObjects, readDataRow } from "./artifact-data.ts";
import { checkDataWriteCapacity } from "./budget.ts";
import { ownerEntitlements } from "./plans.ts";

/** What the live services need besides the artifact's regional database. */
export interface LiveDeps {
  /** The artifact's region's objects; null without the binding. */
  objects: DataObjects | null;
  /** `ARTIFACT_DATA_ENABLED` and `DATA_LIVE_ENABLED` both on. */
  enabled: boolean;
}

/** Whether this deployment serves live updates (decision 0026, "Switches"). */
export function dataLiveEnabled(env: {
  ARTIFACT_DATA_ENABLED?: string | undefined;
  DATA_LIVE_ENABLED?: string | undefined;
}): boolean {
  return env.ARTIFACT_DATA_ENABLED === "true" && env.DATA_LIVE_ENABLED === "true";
}

/** Who holds the connection, as the caller verified it. */
export interface LiveCaller {
  artifactId: string;
  /** The grant's visitor, or null for a reader. */
  author: string | null;
  /** The grant's ID for a visitor, the read or link session's for a reader. */
  principal: string;
  /** The owner plan's per-artifact limits when the caller already holds them (no plan read). */
  limits?: ArtifactDataLimits | undefined;
  now: number;
}

const notAvailable = () => fail<never>("not_found", "Live updates are not available.");

interface LiveTarget {
  envelope: {
    artifactId: string;
    region: string;
    ownerId: string;
    generation: number;
    epoch: number;
  };
  limits: ArtifactDataLimits;
  objects: DataObjects;
}

/**
 * The artifact as live updates may reach it: switched on, active (a held artifact is suspended),
 * holding data, with the owner's plan's per-artifact limits. Nothing creates an object here.
 */
async function liveTarget(
  db: RegionalDb,
  deps: LiveDeps,
  input: { artifactId: string; limits?: ArtifactDataLimits | undefined; now: number },
): Promise<Result<LiveTarget>> {
  if (!deps.enabled) return notAvailable();
  if (deps.objects === null) {
    return fail("capacity_unavailable", "Live updates are unavailable. Try again later.");
  }
  const [artifact] = await db
    .select({ state: schema.artifacts.state })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, input.artifactId))
    .limit(1);
  if (artifact?.state !== "active") return notAvailable();
  const row = await readDataRow(db, deps.objects.region, input.artifactId);
  if (row === null) return notAvailable();
  const limits =
    input.limits ?? (await ownerEntitlements(db.global, row.ownerId, input.now)).data.perArtifact;
  return ok({
    envelope: {
      artifactId: row.artifactId,
      region: row.region,
      ownerId: row.ownerId,
      generation: row.generation,
      epoch: row.epoch,
    },
    limits,
    objects: deps.objects,
  });
}

/**
 * Opens a page's live connection: a new connect is growth work, so budget protection's data step
 * refuses it (`checkDataWriteCapacity`) before the object is called. The answer is the object's
 * `101` with the client end, to return to the browser as it is, or the object's refusal mapped to
 * the API's errors. Nothing from the browser's request reaches the object.
 */
export async function openLiveConnection(
  db: RegionalDb,
  deps: LiveDeps,
  input: LiveCaller,
): Promise<Result<Response>> {
  const found = await liveTarget(db, deps, input);
  if (!found.ok) return found;
  const capacity = await checkDataWriteCapacity(db.global, "connect", input.now);
  if (!capacity.ok) return capacity;
  const { envelope, limits, objects } = found.value;
  const request: LiveConnectRequest = {
    envelope,
    author: input.author,
    principal: input.principal,
    deadline: input.now + ARTIFACT_DATA.live.deadlineMs,
    limits,
    now: input.now,
  };
  const response = await objects.object(input.artifactId).fetch(
    new Request("https://documents.invalid/live", {
      headers: { upgrade: "websocket", [LIVE_CONNECT_HEADER]: JSON.stringify(request) },
    }),
  );
  if (response.status === 101) return ok(response);
  const refused = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
  } | null;
  if (typeof refused?.code !== "string") {
    return fail("capacity_unavailable", "Live updates are unavailable. Try again later.");
  }
  const error = dataRefusalError(refused.code, String(refused.message ?? ""));
  return fail(error.code, error.message);
}

/**
 * Renews a live connection for another minute, carrying the owner's current plan's daily message
 * limit. Refused once a switch is off or the artifact stopped being live: the connection then
 * closes at its deadline, within a minute.
 */
export async function renewLiveConnection(
  db: RegionalDb,
  deps: LiveDeps,
  input: LiveCaller & { socketId: string },
): Promise<Result<{ deadline: number }>> {
  const found = await liveTarget(db, deps, input);
  if (!found.ok) return found;
  const { envelope, limits, objects } = found.value;
  const deadline = input.now + ARTIFACT_DATA.live.deadlineMs;
  const renewed = await objects
    .object(input.artifactId)
    .liveRenew(envelope, input.socketId, input.principal, deadline, limits, input.now);
  return renewed ? ok({ deadline }) : notAvailable();
}
