import type { ErrorCode } from "@portifact/contracts";

/** Outcome of a business rule: either a value or a typed failure that adapters can map. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(code: ErrorCode, message: string): Result<T> => ({
  ok: false,
  code,
  message,
});
