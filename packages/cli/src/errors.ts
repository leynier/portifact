import type { ErrorCode } from "@portifact/contracts";

/**
 * Error codes the CLI reports. The shared ones come from packages/contracts; the rest describe
 * failures that only exist on the client side of a login or a connection.
 */
export type CliErrorCode =
  | Extract<ErrorCode, "invalid_input" | "unauthenticated" | "rate_limited">
  | "authorization_denied"
  | "authorization_expired"
  | "network_error"
  | "server_error";

/** Documented exit codes (skills/portifact/SKILL.md). */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unauthenticated: 3,
  loginIncomplete: 4,
} as const;

export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function exitCodeFor(code: CliErrorCode): number {
  switch (code) {
    case "invalid_input":
      return EXIT.usage;
    case "unauthenticated":
      return EXIT.unauthenticated;
    case "authorization_denied":
    case "authorization_expired":
      return EXIT.loginIncomplete;
    default:
      return EXIT.failure;
  }
}
