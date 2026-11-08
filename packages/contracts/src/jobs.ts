// Shapes that cross the jobs Worker's boundaries: messages on the `portifact-jobs` queue, the
// payloads of outbox rows, and the tombstone markers the operator exports before restoring a
// backup and applies after it (docs/operations.md).
import { z } from "zod";

export const OutboxTopic = z.enum(["purge_artifact", "account_deletion", "delete_objects"]);
export type OutboxTopic = z.infer<typeof OutboxTopic>;

/** A queue message only points at its outbox row; the row is the job's source of truth. */
export const JobMessage = z.strictObject({
  id: z.number().int().positive(),
  topic: OutboxTopic,
});
export type JobMessage = z.infer<typeof JobMessage>;

/** Payload of a `delete_objects` job: the R2 keys whose rows its batch deleted. */
export const DeleteObjectsPayload = z.object({
  keys: z.array(z.string().min(1).max(200)).max(100),
});

/** One purged or deleted artifact or account that a restored backup must not bring back. */
export const TombstoneMarker = z.strictObject({
  kind: z.enum(["artifact", "account"]),
  id: z.string().min(1).max(200),
  deletedAt: z.number().int().nonnegative(),
});
export type TombstoneMarker = z.infer<typeof TombstoneMarker>;
