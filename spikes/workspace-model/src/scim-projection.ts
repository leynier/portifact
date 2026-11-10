// The application side of SCIM: the plugin keeps its own SCIM resources and calls this with the
// complete state of one user after every change, inside its transaction. Portifact turns it into
// workspace membership; the connection's provisioning domain is the workspace ID.
import type { scim } from "@better-auth/scim";

type Projection = NonNullable<Parameters<typeof scim>[0]["projection"]>;
type ReconcileContext = Parameters<Projection["reconcileUser"]>[1];
type Identity = NonNullable<Parameters<typeof scim>[0]["identity"]>;
type ResolveUser = NonNullable<Identity["resolveUser"]>;

export interface ProjectedUser {
  provisioningDomainId: string;
  userId: string;
  active: boolean;
}

export async function reconcileScimMember(
  state: ProjectedUser,
  context: ReconcileContext,
): Promise<void> {
  const where = [
    { field: "organizationId", value: state.provisioningDomainId },
    { field: "userId", value: state.userId },
  ];
  const existing = await context.database.findOne<{ id: string }>({ model: "member", where });
  if (state.active && !existing) {
    await context.database.create({
      model: "member",
      data: {
        organizationId: state.provisioningDomainId,
        userId: state.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
  } else if (!state.active && existing) {
    await context.database.delete({
      model: "member",
      where: [{ field: "id", value: existing.id }],
    });
  }
}

/**
 * Links a provisioned user to the Portifact account that already holds the same address. Every
 * Portifact account's email is verified, which is what the plugin asks of a link. A real design
 * would also require the address to be in the workspace's verified domain, like SSO.
 */
export const linkByVerifiedEmail: ResolveUser = async (input, context) => {
  const email = input.resource.primaryEmail.toLowerCase();
  const user = await context.database.findOne<{ id: string; emailVerified: boolean }>({
    model: "user",
    where: [{ field: "email", value: email }],
  });
  return user?.emailVerified
    ? { action: "link", userId: user.id, profile: "preserve" }
    : { action: "create" };
};
