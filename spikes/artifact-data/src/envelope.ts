// The one envelope every command to an artifact's objects carries (decision 0026, "Fencing"). The
// calling Worker fills it from D1 after authorization; the object checks it before doing anything,
// so a routing mistake, a stale request after a transfer or hold, or an erase retried after new
// data was created is refused by the object itself.

export interface Envelope {
  artifactId: string;
  region: string;
  /** The data generation: raised by every erase of the whole data, so an erase targets one. */
  generation: number;
  /** The lifecycle epoch: raised by holds, releases, transfers, suspensions and access changes. */
  epoch: number;
  /** A durable operation ID for mutations: a retry with the same ID replays its first outcome. */
  opId?: string;
}

export type ObjectState = "open" | "held" | "erasing" | "erased";

/** What an object remembers about itself, compared with every envelope. */
export interface Fence {
  artifactId: string;
  region: string;
  generation: number;
  epoch: number;
  state: ObjectState;
}

export type FenceVerdict =
  | { ok: true; adopt: boolean }
  | { ok: false; error: "forbidden" | "stale" | "held"; message: string };

/**
 * Decides whether a command may run. A different artifact or region is refused (a Worker bug
 * would otherwise mix two artifacts' data); an older generation or epoch is stale; a newer epoch
 * is adopted (D1 moved first); a held object runs only operator commands.
 */
export function checkFence(
  stored: Fence | null,
  envelope: Envelope,
  operator = false,
): FenceVerdict {
  if (stored === null) return { ok: true, adopt: true };
  if (stored.artifactId !== envelope.artifactId || stored.region !== envelope.region) {
    return { ok: false, error: "forbidden", message: "artifact reference mismatch" };
  }
  if (envelope.generation !== stored.generation) {
    return { ok: false, error: "stale", message: "the data was erased since this request began" };
  }
  if (envelope.epoch < stored.epoch) {
    return { ok: false, error: "stale", message: "the artifact changed since this request began" };
  }
  if (stored.state === "held" && !operator) {
    return { ok: false, error: "held", message: "This artifact cannot be changed right now." };
  }
  return { ok: true, adopt: envelope.epoch > stored.epoch };
}
