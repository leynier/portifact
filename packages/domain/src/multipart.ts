// Which objects are uploaded in parts and how they are split (plan section 9, "Carga y commit":
// files over 64 MiB use presigned multipart with resumption). The services persist the plan
// with the upload, and the clients read the part ranges back from the API.
import { MULTIPART } from "@portifact/contracts";

export interface MultipartConfig {
  /** Objects strictly larger than this are uploaded in parts. */
  thresholdBytes: number;
  /** Size of every part but the last. */
  partBytes: number;
}

export const DEFAULT_MULTIPART: MultipartConfig = {
  thresholdBytes: MULTIPART.thresholdBytes,
  partBytes: MULTIPART.partBytes,
};

export interface PartPlan {
  partSize: number;
  partCount: number;
}

/**
 * The part plan of an object of `size` bytes, or null when it is uploaded in one request. The
 * part size never drops below R2's minimum, and grows when the object would need more parts
 * than R2 allows.
 */
export function planParts(
  size: number,
  config: MultipartConfig = DEFAULT_MULTIPART,
): PartPlan | null {
  if (size <= config.thresholdBytes) return null;
  const partSize = Math.max(
    config.partBytes,
    MULTIPART.minPartBytes,
    Math.ceil(size / MULTIPART.maxParts),
  );
  return { partSize, partCount: Math.ceil(size / partSize) };
}

/** Bytes `[offset, offset + size)` of the object that part `partNumber` (from 1) carries. */
export function partRange(
  objectSize: number,
  plan: PartPlan,
  partNumber: number,
): { offset: number; size: number } {
  const offset = (partNumber - 1) * plan.partSize;
  return { offset, size: Math.min(plan.partSize, objectSize - offset) };
}

/** Whether `partNumber` is one of the plan's parts. */
export function isPlannedPart(plan: PartPlan, partNumber: number): boolean {
  return Number.isSafeInteger(partNumber) && partNumber >= 1 && partNumber <= plan.partCount;
}
