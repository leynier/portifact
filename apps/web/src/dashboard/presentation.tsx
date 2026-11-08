// How artifact facts are shown: every state has a label and an icon, never tone alone.
import type { AccessMode, ArtifactState, ArtifactType } from "@portifact/contracts";
import { Badge } from "@portifact/ui";
import {
  Archive,
  Ban,
  CircleCheck,
  FileText,
  Globe,
  Lock,
  PanelsTopLeft,
  PencilLine,
  ScrollText,
  Trash2,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LifecycleAction } from "./api.ts";
import { useT } from "./context.tsx";

const ICON = "size-3.5";

const STATE_BADGES: Record<
  ArtifactState,
  { icon: ReactNode; emphasis: "normal" | "strong" | "quiet" }
> = {
  draft: { icon: <PencilLine className={ICON} />, emphasis: "quiet" },
  active: { icon: <CircleCheck className={ICON} />, emphasis: "normal" },
  archived: { icon: <Archive className={ICON} />, emphasis: "quiet" },
  suspended: { icon: <Ban className={ICON} />, emphasis: "strong" },
  purging: { icon: <Trash2 className={ICON} />, emphasis: "strong" },
  deleted: { icon: <Trash2 className={ICON} />, emphasis: "strong" },
};

export function StateBadge({ state }: { state: ArtifactState }) {
  const t = useT();
  const { icon, emphasis } = STATE_BADGES[state];
  return (
    <Badge icon={icon} emphasis={emphasis}>
      {t(`state.${state}`)}
    </Badge>
  );
}

const ACCESS_ICONS: Record<AccessMode, ReactNode> = {
  restricted: <Lock className={ICON} />,
  authenticated: <Users className={ICON} />,
  public: <Globe className={ICON} />,
};

/** Who can open an artifact, as a short label with its icon. */
export function AccessBadge({ mode }: { mode: AccessMode }) {
  const t = useT();
  return (
    <Badge icon={ACCESS_ICONS[mode]} emphasis="subtle">
      {t(`list.access.${mode}`)}
    </Badge>
  );
}

const TYPE_ICONS: Record<ArtifactType, ReactNode> = {
  site: <PanelsTopLeft className="size-4" />,
  markdown: <FileText className="size-4" />,
  text: <ScrollText className="size-4" />,
};

/** The artifact's type, as an icon in a tile; the type's name is the caller's text. */
export function TypeIcon({ type }: { type: ArtifactType }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-border bg-surface text-text"
    >
      {TYPE_ICONS[type]}
    </span>
  );
}

/**
 * The lifecycle actions to offer in each state (plan section 10). The API still decides: this
 * only hides buttons that could never succeed.
 */
export function offeredActions(state: ArtifactState): LifecycleAction[] {
  switch (state) {
    case "active":
      return ["renew", "archive", "delete"];
    case "archived":
      return ["restore", "delete"];
    case "draft":
    case "suspended":
      return ["delete"];
    default:
      return [];
  }
}
