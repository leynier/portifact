// What the dashboard's invitation page shows for the token in an invitation's link (premium plan
// T1). The token is a secret only the invited address received, so whoever holds it may learn
// which address it was sent to, and nothing else: a signed-in account that is not that verified
// address gets the address, so it can switch accounts, while the workspace, the role and who sent
// it stay hidden. An expired, revoked or used invitation answers like a missing one.
import { type GlobalDb, schema } from "@portifact/db";
import { checkInvitee, fail, MISSING_INVITATION, ok, type Result } from "@portifact/domain";
import { eq } from "drizzle-orm";
import type { IncomingInvitation } from "./invitations.ts";
import { invitationTokenHash } from "./invitations.ts";

const inv = schema.workspaceInvitations;
const w = schema.workspaces;

export type InvitationStanding =
  | { status: "invited"; invitation: IncomingInvitation }
  | { status: "other_account"; email: string };

/** The invitation a link's token names, as the signed-in account may see it. */
export async function lookupInvitation(
  global: GlobalDb,
  input: { userId: string; token: string; now: number },
): Promise<Result<InvitationStanding>> {
  const [row] = await global
    .select({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invitedBy: inv.invitedBy,
      expiresAt: inv.expiresAt,
      slug: w.slug,
      name: w.name,
    })
    .from(inv)
    .innerJoin(w, eq(w.id, inv.workspaceId))
    .where(eq(inv.tokenHash, await invitationTokenHash(input.token)))
    .limit(1);
  if (!row || row.expiresAt <= input.now) return fail("not_found", MISSING_INVITATION);
  const [user] = await global
    .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  if (!user) return fail("not_found", MISSING_INVITATION);
  if (!checkInvitee(row, user, input.now).ok) {
    return ok({ status: "other_account", email: row.email });
  }
  const inviter = row.invitedBy
    ? await global
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, row.invitedBy))
        .limit(1)
    : [];
  return ok({
    status: "invited",
    invitation: {
      id: row.id,
      workspace: { slug: row.slug, name: row.name },
      role: row.role,
      invitedBy: inviter[0]?.name ?? null,
      expiresAt: row.expiresAt,
    },
  });
}
