// The device flow's sign-in time (decision 0021, review fix). A device login (`portifact login`)
// inherits the sign-in of the session that approved it, exactly as an authorization code
// inherits its session's, so approving a new code from a stale session never makes a token look
// fresh. The pinned provider keeps no session for a device grant, and its poll consumes (deletes)
// the device code before it writes the tokens, with nothing on them that names the code; so the
// app records the approving session's `created_at` on the code at approval and copies it onto the
// exact token rows the exchange issued. Nothing here comes from what a client sends but the codes
// that find the rows; the time comes from the session row.
import { schema } from "@portifact/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { regionsOf } from "../regions.ts";
import type { Auth } from "./auth.ts";
import { sessionOf } from "./credentials.ts";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const d = schema.deviceCodes;

/** The spellings the provider looks a user code up by: as typed, then normalized. */
function userCodes(typed: string): string[] {
  return [...new Set([typed, typed.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()])];
}

/**
 * Before the provider approves a code: records when the approving session signed in, on the
 * pending code that session's user claimed. Written before the approval, so the poll can never
 * find an approved code without it. Of two attempts on one code the older sign-in wins, so a
 * value never looks fresher than any session that tried to approve it.
 */
export async function recordDeviceApproval(
  auth: Auth,
  env: Env,
  headers: Headers,
  body: Record<string, unknown>,
): Promise<void> {
  const typed = body.userCode;
  if (typeof typed !== "string" || typed.length === 0 || typed.length > 64) return;
  const found = await sessionOf(auth, env, headers);
  if (!found) return;
  const signedInAt = new Date(found.session.createdAt).getTime();
  await regionsOf(env)
    .global.update(d)
    .set({
      approverSignedInAt: sql`min(coalesce(${d.approverSignedInAt}, ${signedInAt}), ${signedInAt})`,
    })
    .where(
      and(
        inArray(d.userCode, userCodes(typed)),
        eq(d.userId, found.user.id),
        eq(d.status, "pending"),
      ),
    );
}

/**
 * The device exchange (`POST /oauth2/token` with the device grant): reads the approver's sign-in
 * from the code before the provider consumes it, lets the provider issue the tokens, then writes
 * it onto the access token and refresh token it issued, found by the provider's own lookup of the
 * returned access token. Every later refresh copies it. Without one (a code approved before this
 * release, or a failure here), the tokens keep the trigger's 0, "not known": fail closed.
 */
export async function exchangeDeviceCode(
  auth: Auth,
  env: Env,
  body: Record<string, unknown>,
  issue: () => Promise<Response>,
): Promise<Response> {
  if (body.grant_type !== DEVICE_GRANT || typeof body.device_code !== "string") return issue();
  const global = regionsOf(env).global;
  const [code] = await global
    .select({ signedInAt: d.approverSignedInAt })
    .from(d)
    .where(eq(d.deviceCode, body.device_code))
    .limit(1);
  const response = await issue();
  const signedInAt = code?.signedInAt?.getTime() ?? null;
  if (response.status !== 200 || signedInAt === null) return response;
  // The provider has consumed the code and issued the tokens: its answer is the only copy of
  // them, so nothing below may replace it. A failure leaves the tokens' 0 (fail closed for a
  // maximum session age) and the login itself still completes.
  try {
    await stampTokens(auth, env, response.clone(), new Date(signedInAt));
  } catch (error) {
    console.error(JSON.stringify({ event: "device_sign_in_time_failed", error: errorName(error) }));
  }
  return response;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** Writes the sign-in time onto the access and refresh token rows the answer's token names. */
async function stampTokens(auth: Auth, env: Env, answer: Response, at: Date): Promise<void> {
  const tokens = (await answer.json().catch(() => null)) as { access_token?: unknown } | null;
  if (typeof tokens?.access_token !== "string") return;
  const record = (await auth.api.tokenRecordOf({
    headers: new Headers({ authorization: `Bearer ${tokens.access_token}` }),
  })) as { accessId: string; refreshId: string | null } | null;
  if (!record) return;
  const global = regionsOf(env).global;
  await global.batch([
    global
      .update(schema.oauthAccessTokens)
      .set({ authTime: at })
      .where(eq(schema.oauthAccessTokens.id, record.accessId)),
    ...(record.refreshId
      ? [
          global
            .update(schema.oauthRefreshTokens)
            .set({ authTime: at })
            .where(eq(schema.oauthRefreshTokens.id, record.refreshId)),
        ]
      : []),
  ]);
}
