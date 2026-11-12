import type { ErrorCode } from "@portifact/contracts";
import { plain } from "./plain.ts";

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
  | "cancelled"
  /** `git` is not installed, or a git command the CLI needed failed. */
  | "git_failed"
  /** Another `portifact export` holds the folder's lock. */
  | "folder_in_use"
  /** Writing to the local disk failed (permissions, space, a failing rename). */
  | "write_failed";

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
  /** `export` finished without a part the server asked to fetch later: run it again. */
  incomplete: 8,
  /**
   * The account has not accepted the current terms (`terms_not_accepted`): the message says to
   * accept them in the dashboard. Reading and downloading keep working until then.
   */
  termsNotAccepted: 9,
} as const;

/**
 * A failure the CLI reports. Its message is cleaned here, once, with `plain`: messages often carry
 * the server's own text (an API error's message, a path, a name), and nothing printed from it may
 * drive the terminal or hide text, in human output or in `--json`.
 */
export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(plain(message));
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
    case "sole_workspace_admin":
    case "folder_in_use":
      return EXIT.conflict;
    case "quota_exceeded":
    case "seats_exhausted":
    case "traffic_exceeded":
    case "account_too_new_for_public":
    case "human_verification_required":
    case "plan_required":
    // A workspace policy refused it (decisions 0015 and 0020): the message names the policy, and
    // for a network policy says to connect from an approved network.
    case "policy_refused":
      return EXIT.limit;
    case "terms_not_accepted":
      return EXIT.termsNotAccepted;
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
