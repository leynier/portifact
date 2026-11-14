// Who may write to an artifact's data from its page (decision 0026, delivery 9): the owner side
// reads and changes `artifact_data.writers` here, for the API, the MCP tool and the CLI alike.
// `anyone` is checked against the owner's plan and the workspace's policy (`checkDataWriters`)
// after authorization; narrowing back to `signed_in` is never refused for the plan, the policy or
// the terms. The setting is D1's alone: the object never sees it, because the content Worker
// decides the page's caller before any command reaches it.
import type { DataWriters, DataWritersView } from "@portifact/contracts";
import { isWorkspaceId } from "@portifact/contracts";
import { type RegionalDb, schema } from "@portifact/db";
import {
  type AnonymousOwner,
  anonymousState,
  checkDataWriters,
  fail,
  ok,
  type Result,
} from "@portifact/domain";
import { and, eq, sql } from "drizzle-orm";
import { authorizeOn } from "./actors.ts";
import { auditEvent } from "./audit.ts";
import { heldRefusal, isHeld, notHeldSql } from "./legal-holds.ts";
import { ownerEntitlements } from "./plans.ts";
import { actsWithoutCurrentTerms, narrowingOnly } from "./terms.ts";

const missing = () => fail<never>("not_found", "Artifact not found.");
const unavailable = () => fail<never>("not_found", "Artifact data is not available.");
const noData = () =>
  fail<never>("not_found", "This artifact has no data yet. Declare a collection first.");

const d = schema.artifactData;
const a = schema.artifacts;

export interface DataWritersInput {
  userId: string;
  artifactId: string;
  now: number;
}

interface Found {
  ownerId: string;
  writers: DataWriters;
  /** The owner as anonymous writing reads it: plan and policy, read once. */
  owner: AnonymousOwner;
  view: DataWritersView;
}

/**
 * The artifact and its setting, after authorization (role action `data` on its owner, so a
 * token's restriction applies), as the owner side may see it: not while artifact data is off,
 * not while held, and only for an artifact that holds data.
 */
async function load(
  db: RegionalDb,
  enabled: boolean,
  input: DataWritersInput,
  write: boolean,
): Promise<Result<Found>> {
  const [artifact] = await db
    .select({
      ownerId: a.ownerId,
      state: a.state,
      createdBy: a.createdBy,
      externalKey: a.externalKey,
      writers: d.writers,
    })
    .from(a)
    .leftJoin(d, eq(d.artifactId, a.id))
    .where(eq(a.id, input.artifactId))
    .limit(1);
  if (!artifact || artifact.state === "purging" || artifact.state === "deleted") return missing();
  const actor = await authorizeOn(db, input.userId, artifact, "data", missing);
  if (!actor.ok) return actor;
  if (!enabled) return unavailable();
  if (artifact.state === "suspended" && (await isHeld(db, input.artifactId))) return heldRefusal();
  if (write && artifact.state === "archived") {
    return fail("artifact_archived", "Restore the artifact to change its data.");
  }
  if (write && artifact.state !== "active") {
    return fail("forbidden", "A suspended artifact's data cannot be changed.");
  }
  if (artifact.writers === null) return noData();
  const owner: AnonymousOwner = {
    workspace: isWorkspaceId(artifact.ownerId),
    entitlements: await ownerEntitlements(db.global, artifact.ownerId, input.now),
    // The policy came with the membership (decision 0015), never an added read.
    policy: actor.value.policy,
  };
  return ok({
    ownerId: artifact.ownerId,
    writers: artifact.writers,
    owner,
    view: {
      artifactId: input.artifactId,
      writers: artifact.writers,
      anonymous: anonymousState(artifact.writers, owner),
    },
  });
}

/** Who may write from the page, and whether anonymous writing works now. */
export async function getDataWriters(
  db: RegionalDb,
  deps: { enabled: boolean },
  input: DataWritersInput,
): Promise<Result<DataWritersView>> {
  const found = await load(db, deps.enabled, input, false);
  return found.ok ? ok(found.value.view) : found;
}

/**
 * Changes who may write from the page. `anyone` needs the owner to allow anonymous writing (a
 * personal space, or a workspace with `policies` whose policy allows it) and, for a person's
 * token, the current terms; `signed_in` only narrows. The change and its `data.writers_changed`
 * event are one batch, held to the owner and state that were authorized and to the artifact not
 * being held; a change that changes nothing records nothing.
 */
export async function setDataWriters(
  db: RegionalDb,
  deps: { enabled: boolean },
  input: DataWritersInput & { writers: DataWriters },
): Promise<Result<DataWritersView>> {
  const found = await load(db, deps.enabled, input, true);
  if (!found.ok) return found;
  const { ownerId, writers, owner } = found.value;
  if (input.writers === "anyone" && actsWithoutCurrentTerms(db.global)) return narrowingOnly();
  const allowed = checkDataWriters(input.writers, owner);
  if (!allowed.ok) return allowed;
  const view: DataWritersView = {
    artifactId: input.artifactId,
    writers: input.writers,
    anonymous: anonymousState(input.writers, owner),
  };
  if (writers === input.writers) return ok(view);
  const still = sql`exists (select 1 from ${a} where ${a.id} = ${input.artifactId} and ${a.ownerId} = ${ownerId} and ${a.state} = 'active' and ${notHeldSql(sql`${input.artifactId}`)}) and exists (select 1 from ${d} where ${d.artifactId} = ${input.artifactId} and ${d.writers} = ${writers})`;
  const [, changed] = await db.batch([
    auditEvent(
      db,
      {
        ownerId,
        kind: "data.writers_changed",
        actor: { type: "user", id: input.userId },
        targetId: input.artifactId,
        artifactId: input.artifactId,
        detail: { writers: input.writers },
        now: input.now,
      },
      still,
    ),
    db
      .update(d)
      .set({ writers: input.writers, updatedAt: input.now })
      .where(and(eq(d.artifactId, input.artifactId), still))
      .returning({ writers: d.writers }),
  ]);
  if (changed.length === 0) {
    return fail("version_conflict", "The artifact changed meanwhile. Try again.");
  }
  return ok(view);
}
