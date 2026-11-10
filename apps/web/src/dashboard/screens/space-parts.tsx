// Pieces every screen of a space shares: where something lives, and the notice a role gets on a
// page it cannot use (the navigation leaves those pages out; a link can still lead to one).
import type { OwnerView } from "@portifact/contracts";
import { Badge, Callout } from "@portifact/ui";
import { Link } from "@tanstack/react-router";
import { Lock, User, Users } from "lucide-react";
import { useT } from "../context.tsx";
import type { Space } from "../space.tsx";

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
