// The one-use handoffs (read and review) and the viewer's frame source with custom domains.
// Today each builds `https://<id>.portifact.dev` from the validated ID. With a custom domain the
// host still never comes from input alone: the app picks between exactly two origins of the
// artifact, its Portifact origin and its active custom host from the table, and the code is bound
// to the host it was sent to.
import { artifactOrigin } from "./hostname.ts";

export type HandoffKind = "read" | "review";

export const HANDOFF_TTL_MS = 60_000;

/**
 * The content Worker's sign-in redirect to `/read/<id>`. It names the host only when the visitor
 * is on a custom host, because the transaction cookie lives on the origin the visitor started on
 * and the callback must land there.
 */
export function readEntryUrl(
  appOrigin: string,
  artifactId: string,
  nonce: string,
  via: "artifact" | "custom",
  hostname: string,
): string {
  const url = new URL(`/read/${artifactId}`, appOrigin);
  url.searchParams.set("state", nonce);
  if (via === "custom") url.searchParams.set("host", hostname);
  return url.toString();
}

/**
 * Where `/read/<id>` sends the code, decided only after `checkReadAccess` admitted the visitor:
 * without `host`, the Portifact origin as today; with it, the custom host only when it is this
 * artifact's active one. Anything else is refused with the same `artifact_unavailable` as a
 * forbidden artifact, so the check reveals nothing to someone who cannot read it.
 */
export function callbackOrigin(input: {
  artifactId: string;
  requestedHost: string | null;
  activeHost: string | null;
  contentDomain: string;
}): string | null {
  if (input.requestedHost === null) return artifactOrigin(input.artifactId, input.contentDomain);
  if (input.activeHost !== null && input.requestedHost === input.activeHost) {
    return `https://${input.activeHost}`;
  }
  return null;
}

/**
 * The origin the viewer frames, for both its `frame-src` and the review code's iframe URL: the
 * active custom host only when the visitor may read the artifact (the viewer lookup's own rule:
 * public and servable, or `checkReadAccess` for the session's user). Everyone else gets the
 * Portifact origin, so the page's policy for a missing, protected or unavailable artifact is the
 * same with or without a domain and never names it.
 */
export function viewerFrameOrigin(input: {
  artifactId: string;
  visible: boolean;
  activeHost: string | null;
  contentDomain: string;
}): string {
  return input.visible && input.activeHost
    ? `https://${input.activeHost}`
    : artifactOrigin(input.artifactId, input.contentDomain);
}

/** The viewer's narrowed `frame-src`, as `viewerCsp` builds it (plus the Turnstile origin). */
export function viewerFrameSrc(frameOrigin: string): string {
  return `frame-src ${frameOrigin} https://challenges.cloudflare.com`;
}

/** `frame-ancestors` of artifact responses: `'self'` is whichever origin serves them. */
export function frameAncestors(appOrigin: string, embeddable: boolean): string {
  return embeddable ? "frame-ancestors *" : `frame-ancestors 'self' ${appOrigin}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Stores the hash of a fresh code bound to kind, artifact and the host it will be redeemed on. */
export async function issueHandoff(
  db: D1Database,
  input: { kind: HandoffKind; artifactId: string; origin: string; userId: string; now: number },
): Promise<string> {
  const code = randomCode();
  await db
    .prepare(
      "insert into handoffs (code_hash, kind, artifact_id, host, user_id, expires_at) values (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      await sha256(code),
      input.kind,
      input.artifactId,
      new URL(input.origin).hostname,
      input.userId,
      input.now + HANDOFF_TTL_MS,
    )
    .run();
  return code;
}

/**
 * Redeems a code on the host the request came on. One guarded update: only an unused, unexpired
 * code of this kind, for the artifact that host resolved to and issued for this exact host. A
 * code sent to the custom host is refused on `<id>.portifact.dev` and the other way round.
 */
export async function redeemHandoff(
  db: D1Database,
  input: { kind: HandoffKind; code: string; artifactId: string; hostname: string; now: number },
): Promise<{ userId: string } | null> {
  const row = await db
    .prepare(
      `update handoffs set used_at = ?
       where code_hash = ? and kind = ? and artifact_id = ? and host = ?
         and used_at is null and expires_at > ?
       returning user_id`,
    )
    .bind(
      input.now,
      await sha256(input.code),
      input.kind,
      input.artifactId,
      input.hostname,
      input.now,
    )
    .first<{ user_id: string }>();
  return row ? { userId: row.user_id } : null;
}
