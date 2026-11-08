import type { ErrorCode } from "@portifact/contracts";

/**
 * Error codes the CLI reports. Every shared code from packages/contracts can come back from the
 * API; the rest describe failures that only exist on the client side.
 */
export type CliErrorCode =
  | ErrorCode
  | "authorization_denied"
  | "authorization_expired"
  | "network_error"
  | "server_error"
  /** Storage refused an upload, or a file changed while it was being published. */
  | "upload_failed"
  /** A download failed, or its bytes did not match the manifest. */
  | "download_failed"
  /** The user did not confirm a destructive action. */
  | "cancelled";

/** Documented exit codes (skills/portifact/SKILL.md). */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  unauthenticated: 3,
  loginIncomplete: 4,
  notFound: 5,
  conflict: 6,
  limit: 7,
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
    case "not_found":
    case "forbidden":
      return EXIT.notFound;
    case "version_conflict":
    case "upload_incomplete":
    case "artifact_archived":
      return EXIT.conflict;
    case "quota_exceeded":
    case "traffic_exceeded":
    case "account_too_new_for_public":
    case "human_verification_required":
      return EXIT.limit;
    default:
      return EXIT.failure;
  }
}

/** Failures worth retrying with the same request: the server may not have seen it, or may recover. */
export function isTransient(error: unknown): boolean {
  return (
    error instanceof CliError && (error.code === "network_error" || error.code === "server_error")
  );
}
