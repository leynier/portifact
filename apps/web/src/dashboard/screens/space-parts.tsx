// Pieces every screen of a space shares: where something lives, and the notice a role gets on a
// page it cannot use (the navigation leaves those pages out; a link can still lead to one).
import { DEFAULT_REGION, type OwnerView } from "@portifact/contracts";
import { Badge, Callout } from "@portifact/ui";
import { Link } from "@tanstack/react-router";
import { Info, Lock, User, Users } from "lucide-react";
import { useT } from "../context.tsx";
import { type Space, spaceRegion } from "../space.tsx";

/** The space an artifact or a page belongs to, as a badge: Personal, or the workspace's name. */
export function SpaceBadge({ owner }: { owner: OwnerView | Space }) {
  const t = useT();
  const personal = owner.kind === "personal";
  return (
    <Badge
      emphasis="subtle"
      icon={personal ? <User className="size-3.5" /> : <Users className="size-3.5" />}
    >
      <span className="sr-only">{t("space.label")}: </span>
      {personal ? t("space.personal") : owner.name}
    </Badge>
  );
}

/** What a role that cannot use the page sees instead of it, with the way back to the list. */
export function RoleNotice({ children }: { children: string }) {
  const t = useT();
  return (
    <Callout
      title={t("space.notAllowed.title")}
      icon={<Lock className="size-5" />}
      action={
        <Link to="/" className="font-semibold">
          {t("space.notAllowed.back")}
        </Link>
      }
    >
      {children}
    </Callout>
  );
}

/**
 * On the pages that send a space's data to a destination its admins choose (webhooks, issue
 * integrations), the notice that it leaves the region for a space stored outside the default one
 * (decision 0005, "What leaves the region"). Audit streams say it with the API's `euOwner`.
 */
export function LeavesRegionNotice({
  space,
  destination,
}: {
  space: Space;
  destination: "webhooks" | "integrations";
}) {
  const t = useT();
  if (space.kind !== "workspace" || spaceRegion(space) === DEFAULT_REGION) {
    return null;
  }
  return (
    <Callout tone="info" title={t("region.leaves.title")} icon={<Info className="size-5" />}>
      {t(`region.leaves.${destination}`)}
    </Callout>
  );
}
