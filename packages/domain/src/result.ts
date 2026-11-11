import type { ErrorCode, ErrorDetail, RequestRefusal } from "@portifact/contracts";

/**
 * Outcome of a business rule: either a value or a typed failure that adapters can map. `reason`
 * says which sign-in policy refused a `policy_refused` (decision 0021), so a browser entry can
 * send the person to sign in again; absent everywhere else. `detail` names a refusal a page
 * tells apart from others of its code (`ErrorDetail`); absent everywhere else.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string; reason?: RequestRefusal; detail?: ErrorDetail };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(code: ErrorCode, message: string): Result<T> => ({
  ok: false,
  code,
  message,
});
