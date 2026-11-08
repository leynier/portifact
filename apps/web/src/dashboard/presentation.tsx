// How artifact facts are shown: every state has a label and an icon, never tone alone.
import type { ArtifactState } from "@portifact/contracts";
import { Badge } from "@portifact/ui";
import { Archive, Ban, CircleCheck, PencilLine, Trash2 } from "lucide-react";
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
