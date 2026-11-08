import type { ErrorCode } from "@portifact/contracts";

/** Why a source cannot be rendered. Every reason maps to the `invalid_input` error code. */
export type RenderErrorReason = "too_large" | "invalid_utf8" | "binary";

export class RenderError extends Error {
  readonly code: ErrorCode = "invalid_input";

  constructor(
    readonly reason: RenderErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "RenderError";
  }
}
